import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ConfigIssue } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { getSection, setSection, settingsSections, validateSection, type SettingsSection } from '../settings/service.js';

// Boot-time overlays: the managed config file (ARCLIGHT_CONFIG_FILE) and scalar settings
// overrides (ARCLIGHT_SETTING__<section>__<key>[__<nested>]=value). Precedence, lowest first:
// UI/database < config file < environment.

export const CONFIG_FILE_ENV = 'ARCLIGHT_CONFIG_FILE';
export const SETTING_ENV_PREFIX = 'ARCLIGHT_SETTING__';

export class ConfigParseError extends Error {
  readonly code = 'PARSE';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

/** YAML 1.2 is a superset of JSON, so one parser reads both. */
export function parseConfigText(text: string): unknown {
  try {
    return parseYaml(text, { prettyErrors: true });
  } catch (err) {
    throw new ConfigParseError(err instanceof Error ? err.message : String(err));
  }
}

export function toYaml(doc: unknown): string {
  return stringifyYaml(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

/** The config file named by the environment, or null when unset or missing. */
export function readConfigFile(env: NodeJS.ProcessEnv): { path: string; raw: unknown } | null {
  const path = env[CONFIG_FILE_ENV];
  if (!path || !existsSync(path)) return null;
  return { path, raw: parseConfigText(readFileSync(path, 'utf8')) };
}

export interface EnvOverride {
  /** The variable name as given. */
  name: string;
  section: SettingsSection;
  /** Key path inside the section (resolved to the section's own casing where it exists). */
  path: string[];
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce an env string to the type of the value it replaces (JSON for anything unknown). */
export function coerceEnvValue(raw: string, current: unknown): unknown {
  if (typeof current === 'string') return raw;
  if (typeof current === 'boolean') {
    const v = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return raw;
  }
  if (typeof current === 'number') {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** ARCLIGHT_SETTING__* variables, matched case-insensitively to sections and keys. */
export function parseEnvOverrides(db: Db, env: NodeJS.ProcessEnv): { overrides: EnvOverride[]; errors: ConfigIssue[] } {
  const overrides: EnvOverride[] = [];
  const errors: ConfigIssue[] = [];
  const sections = settingsSections();
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.toUpperCase().startsWith(SETTING_ENV_PREFIX)) continue;
    const parts = name.slice(SETTING_ENV_PREFIX.length).split('__').filter((p) => p !== '');
    if (parts.length < 2) {
      errors.push({ path: name, message: `expected ${SETTING_ENV_PREFIX}<section>__<key>` });
      continue;
    }
    const section = sections.find((s) => s.toLowerCase() === parts[0]!.toLowerCase());
    if (!section) {
      errors.push({ path: name, message: `unknown settings section "${parts[0]}"` });
      continue;
    }
    let node: unknown = getSection(db, section);
    const path: string[] = [];
    for (const part of parts.slice(1)) {
      const match = isPlainObject(node) ? Object.keys(node).find((k) => k.toLowerCase() === part.toLowerCase()) : undefined;
      const key = match ?? part;
      path.push(key);
      node = isPlainObject(node) ? node[key] : undefined;
    }
    overrides.push({ name, section, path, value: coerceEnvValue(raw, node) });
  }
  return { overrides, errors };
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return target;
  if (rest.length === 0) return { ...target, [head]: value };
  const child = isPlainObject(target[head]) ? (target[head] as Record<string, unknown>) : {};
  return { ...target, [head]: setPath(child, rest, value) };
}

/** Write the overrides; returns the applied ones (dotted key per section) and per-variable errors. */
export function applyEnvOverrides(
  db: Db,
  overrides: readonly EnvOverride[],
  now: string = new Date().toISOString(),
): { applied: EnvOverride[]; errors: ConfigIssue[] } {
  const applied: EnvOverride[] = [];
  const errors: ConfigIssue[] = [];
  for (const o of overrides) {
    const current = getSection(db, o.section) as Record<string, unknown>;
    const next = setPath(current, o.path, o.value);
    const valid = validateSection(o.section, next);
    if (!valid.ok) {
      errors.push({ path: o.name, message: valid.error });
      continue;
    }
    setSection(db, o.section, valid.value as never, now);
    applied.push(o);
  }
  return { applied, errors };
}
