// Console output without secrets. Stream, artwork and download links carry a signature (`sig=`)
// or a token that opens the user's media; on Android the WebView forwards every console line to
// logcat, so each one is redacted first, in release builds too. Mirrors SafeLog.java.

const SECRET_PARAM =
  /([?&;](?:sig|signature|token|access_token|refresh_token|api_key|apikey|key|auth|password|x-plex-token|x-emby-token|x-amz-signature|x-amz-credential)=)[^&#\s"'<>]*/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
export const REDACTED = 'REDACTED';

/** `text` with secret query values and bearer tokens replaced. */
export function redact(text: string): string {
  return text.replace(SECRET_PARAM, `$1${REDACTED}`).replace(BEARER, `$1${REDACTED}`);
}

/** A console argument with every string in it redacted (objects are copied, a few levels deep). */
export function redactValue(value: unknown, depth = 3, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof URL) return redact(value.href);
  if (value instanceof Error) {
    const copy = new Error(redact(value.message));
    copy.name = value.name;
    if (value.stack !== undefined) copy.stack = redact(value.stack);
    return copy;
  }
  if (value === null || typeof value !== 'object' || depth <= 0) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth - 1, seen));
  const proto = Object.getPrototypeOf(value) as unknown;
  // Plain records only; DOM nodes, Maps and class instances are logged as they are.
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, depth - 1, seen);
  return out;
}

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
let installed = false;

/** Wraps the console methods so every argument is redacted. Idempotent. */
export function installConsoleRedaction(target: Console = console): void {
  if (installed && target === console) return;
  if (target === console) installed = true;
  for (const name of METHODS) {
    const original = target[name].bind(target) as (...args: unknown[]) => void;
    target[name] = (...args: unknown[]) => original(...args.map((a) => redactValue(a)));
  }
}
