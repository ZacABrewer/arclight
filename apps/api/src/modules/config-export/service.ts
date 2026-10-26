import type { Logger } from 'pino';
import type { ConfigManagedKeys, ConfigIssue, ConfigValidateResult } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { getSection, setSection, type SettingsSection } from '../settings/service.js';
import { buildDocument, importDocument, planImport, stableJson, type ImportOptions, type ImportOutcome } from './engine.js';
import { applyEnvOverrides, parseConfigText, parseEnvOverrides, readConfigFile } from './overlay.js';

export interface ConfigServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
}

/** Raw input: a parsed document, or YAML/JSON text. */
export type ConfigInput = { document: unknown } | { content: string };

export class ConfigService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private managed: ConfigManagedKeys = { file: null, appliedAt: null, settings: {}, resources: {}, env: [], errors: [] };
  /** Values the file/env own, per section and top-level key, re-asserted on `settings` events. */
  private managedValues = new Map<SettingsSection, Record<string, unknown>>();
  private unsubscribe: (() => void) | undefined;

  constructor(opts: ConfigServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.env = opts.env ?? process.env;
  }

  /** Throws ConfigParseError for unparsable text. */
  static parse(input: ConfigInput): unknown {
    return 'content' in input ? parseConfigText(input.content) : input.document;
  }

  export(opts: { includeSecrets?: boolean } = {}): Record<string, unknown> {
    return buildDocument(this.db, opts);
  }

  import(raw: unknown, opts: Omit<ImportOptions, 'mode'> = {}): ImportOutcome {
    const outcome = importDocument(this.db, raw, { ...opts, mode: 'normal' });
    this.warnManaged(outcome);
    if (outcome.applied) this.afterApply(outcome);
    return outcome;
  }

  validate(raw: unknown): ConfigValidateResult {
    const { outcome } = planImport(this.db, raw, { dryRun: true });
    return { valid: outcome.errors.length === 0, errors: outcome.errors, warnings: outcome.warnings };
  }

  managedKeys(): ConfigManagedKeys {
    return structuredClone(this.managed);
  }

  /**
   * Boot: apply ARCLIGHT_CONFIG_FILE (managed mode) then ARCLIGHT_SETTING__* overrides. Never
   * throws: problems are logged and reported by GET /config/managed-keys.
   */
  applyBootOverlay(now: string = new Date().toISOString()): ConfigManagedKeys {
    const errors: ConfigIssue[] = [];
    const settings: Record<string, string[]> = {};
    let resources: Record<string, string[]> = {};
    let file: string | null = null;

    try {
      const loaded = readConfigFile(this.env);
      if (loaded) {
        file = loaded.path;
        const outcome = importDocument(this.db, loaded.raw, { mode: 'managed', now });
        if (outcome.errors.length > 0) {
          errors.push(...outcome.errors.map((e) => ({ path: `file:${e.path}`, message: e.message })));
          this.log?.error({ file, errors: outcome.errors }, 'config file not applied');
        } else {
          for (const [s, keys] of Object.entries(outcome.managed.settings)) settings[s] = [...keys];
          resources = outcome.managed.resources;
          this.afterApply(outcome);
          this.log?.info({ file, summary: outcome.summary }, 'config file applied');
        }
        for (const w of outcome.warnings) this.log?.warn({ file, path: w.path }, w.message);
      }
    } catch (err) {
      errors.push({ path: 'file', message: err instanceof Error ? err.message : String(err) });
      this.log?.error({ err }, 'config file could not be read');
    }

    const parsedEnv = parseEnvOverrides(this.db, this.env);
    const appliedEnv = applyEnvOverrides(this.db, parsedEnv.overrides, now);
    errors.push(...parsedEnv.errors, ...appliedEnv.errors);
    for (const o of appliedEnv.applied) {
      const list = (settings[o.section] ??= []);
      const key = o.path.join('.');
      if (!list.includes(key)) list.push(key);
    }
    for (const e of [...parsedEnv.errors, ...appliedEnv.errors]) this.log?.warn({ variable: e.path }, e.message);

    this.managed = {
      file,
      appliedAt: file || appliedEnv.applied.length > 0 ? now : null,
      settings,
      resources,
      env: appliedEnv.applied.map((o) => o.name),
      errors,
    };
    this.snapshotManagedValues();
    return this.managedKeys();
  }

  /** Re-assert managed settings when a module reports a section change (file/env win over the UI). */
  watch(): void {
    if (!this.bus || this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.type === 'settings') this.enforce(event.section);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Returns true when stored values were reverted to the managed ones. */
  enforce(section: string): boolean {
    const owned = this.managedValues.get(section as SettingsSection);
    if (!owned) return false;
    const current = getSection(this.db, section as SettingsSection) as Record<string, unknown>;
    const drift = Object.keys(owned).filter((k) => stableJson(current[k]) !== stableJson(owned[k]));
    if (drift.length === 0) return false;
    setSection(this.db, section as SettingsSection, { ...current, ...owned } as never);
    this.log?.info({ section, keys: drift }, 'reverted settings managed by config file/env');
    return true;
  }

  private snapshotManagedValues(): void {
    this.managedValues.clear();
    for (const [section, keys] of Object.entries(this.managed.settings)) {
      const current = getSection(this.db, section as SettingsSection) as Record<string, unknown>;
      const top = [...new Set(keys.map((k) => k.split('.')[0]!))];
      this.managedValues.set(section as SettingsSection, Object.fromEntries(top.map((k) => [k, current[k]])));
    }
  }

  private warnManaged(outcome: ImportOutcome): void {
    for (const change of outcome.changes) {
      const owned =
        change.kind === 'settings'
          ? (change.fields ?? []).some((f) => this.managed.settings[change.key]?.includes(f.path.split('.')[0]!))
          : this.managed.resources[change.kind]?.includes(change.key);
      if (owned) {
        outcome.warnings.push({
          path: `${change.kind}.${change.key}`,
          message: 'managed by the config file or environment; the managed value wins',
        });
      }
    }
  }

  private afterApply(outcome: ImportOutcome): void {
    // Imports never publish for themselves; tell clients (and enforce()) what changed.
    for (const section of outcome.changedSections) this.bus?.publish({ type: 'settings', section });
  }
}

const services = new WeakMap<AppContext, ConfigService>();

export function configServiceFor(ctx: AppContext, overrides: Partial<ConfigServiceOptions> = {}): ConfigService {
  let service = services.get(ctx);
  if (!service) {
    service = new ConfigService({ db: ctx.db, bus: ctx.bus, log: ctx.log.child({ module: 'config' }), ...overrides });
    services.set(ctx, service);
  }
  return service;
}
