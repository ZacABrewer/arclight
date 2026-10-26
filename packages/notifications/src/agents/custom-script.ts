import { spawn as nodeSpawn } from 'node:child_process';
import type { CustomScriptSettings } from '../settings.js';
import { NotificationError, type NotificationEvent } from '../types.js';
import { ALL_EVENTS, BaseAgent, type AgentDeps } from './base.js';

/** The slice of `ChildProcess` the agent relies on, so tests can hand in a fake. */
export interface ChildLike {
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildLike;

export const ENV_PREFIX = 'MEDIATRON_';

/**
 * Flatten an event into environment variables. Nested objects join with "_", arrays of
 * primitives join with "|", and arrays of objects become one variable per property with
 * values joined by "|" (so `episodes[].title` -> `MEDIATRON_EPISODES_TITLE=a|b`).
 */
export function eventToEnv(event: NotificationEvent): Record<string, string> {
  const env: Record<string, string> = {};
  const { type, ...rest } = event;
  env[`${ENV_PREFIX}EVENT_TYPE`] = type;
  // Event interfaces have no index signature, so walk them as plain JSON-like data.
  flatten(rest as Json, ENV_PREFIX, env);
  return env;
}

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

function flatten(value: Json, prefix: string, env: Record<string, string>): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      env[trimKey(prefix)] = '';
      return;
    }
    if (value.every((v) => typeof v !== 'object' || v === null)) {
      env[trimKey(prefix)] = value.map((v) => scalar(v)).join('|');
      return;
    }
    env[`${trimKey(prefix)}_COUNT`] = String(value.length);
    const keys = new Set<string>();
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) for (const k of Object.keys(item)) keys.add(k);
    }
    for (const key of keys) {
      const column = value.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? item[key] : undefined));
      if (column.every((v) => typeof v !== 'object' || v === null)) {
        env[`${trimKey(prefix)}_${envKey(key)}`] = column.map((v) => scalar(v)).join('|');
      } else {
        // Nested arrays/objects inside a list (e.g. images[].url): still try one level deeper.
        column.forEach((v, i) => flatten(v, `${trimKey(prefix)}_${i}_${envKey(key)}_`, env));
      }
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, `${prefix}${envKey(k)}_`, env);
    return;
  }
  env[trimKey(prefix)] = scalar(value);
}

function scalar(value: Json): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function envKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function trimKey(prefix: string): string {
  return prefix.replace(/_+$/, '');
}

/** Split "a b \"c d\"" into ["a", "b", "c d"]. */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

export class CustomScriptAgent extends BaseAgent {
  readonly kind = 'custom-script' as const;
  readonly supportedEvents = ALL_EVENTS;
  private readonly spawn: SpawnLike;

  constructor(
    private readonly settings: CustomScriptSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
    this.spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  }

  protected deliver(event: NotificationEvent): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...eventToEnv(event) };
    const args = splitArguments(this.settings.arguments);

    return new Promise<void>((resolve, reject) => {
      let child: ChildLike;
      try {
        child = this.spawn(this.settings.path, args, { env, windowsHide: true });
      } catch (error) {
        reject(new NotificationError(this.kind, 'scriptFailed', `Could not start ${this.settings.path}`, { cause: error }));
        return;
      }

      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() =>
          reject(new NotificationError(this.kind, 'timeout', `${this.settings.path} did not exit within ${this.settings.timeoutMs} ms`)),
        );
      }, this.settings.timeoutMs);

      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      child.stdout?.on('data', () => undefined); // drain so the child never blocks on a full pipe
      child.on('error', (error) =>
        finish(() => reject(new NotificationError(this.kind, 'scriptFailed', `Could not run ${this.settings.path}: ${error.message}`, { cause: error }))),
      );
      child.on('close', (code, signal) =>
        finish(() => {
          if (code === 0) {
            resolve();
            return;
          }
          const why = code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${code}`;
          const detail = stderr.trim();
          reject(new NotificationError(this.kind, 'scriptFailed', `${this.settings.path} ${why}${detail ? `: ${detail.slice(0, 500)}` : ''}`));
        }),
      );
    });
  }
}
