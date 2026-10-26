import { SECRET_MASK } from '@arclight/shared';

// Secret detection for config export. Settings sections and per-implementation settings JSON
// (download clients, indexers, notifications, import lists, subtitle providers) do not carry a
// "this is secret" marker, so secrets are recognised by key name. The rule is deliberately
// broad: masking a harmless value costs a round trip, leaking a token costs much more.

const SECRET_KEY = /(password|passphrase|passwd|secret|token|apikey|api_key|cookies?|privatekey|private_key|presharedkey|passkey|rsskey|userkey|appkey|credentials?|webhookurl|webhook_url)$/i;
/** Key names that end like a secret but are not one. */
const NOT_SECRET = /^(tokenexpiresat|sortkey|dupekey|publickey|haspassword|hadapikey)$/i;

export function isSecretKey(key: string): boolean {
  if (NOT_SECRET.test(key)) return false;
  return key.toLowerCase() === 'key' || SECRET_KEY.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy with every non-empty secret value replaced by SECRET_MASK. */
export function maskSecrets<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, secret: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, secret));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, secret || isSecretKey(k));
    return out;
  }
  if (secret && typeof value === 'string' && value !== '') return SECRET_MASK;
  return value;
}

/** True when the value (anywhere inside) still holds SECRET_MASK. */
export function containsMask(value: unknown): boolean {
  if (value === SECRET_MASK) return true;
  if (Array.isArray(value)) return value.some(containsMask);
  if (isPlainObject(value)) return Object.values(value).some(containsMask);
  return false;
}

/**
 * Replace every SECRET_MASK in `incoming` with the value at the same path in `current` (what
 * is stored). A mask with nothing stored behind it is dropped (object key removed, array
 * element/scalar becomes null) and reported through `onMissing` with its path.
 */
export function resolveMasks(incoming: unknown, current: unknown, onMissing: (path: string) => void, path = ''): unknown {
  if (incoming === SECRET_MASK) {
    if (current !== undefined && current !== null && current !== SECRET_MASK) return current;
    onMissing(path);
    return undefined;
  }
  if (Array.isArray(incoming)) {
    const cur = Array.isArray(current) ? current : [];
    return incoming.map((v, i) => resolveMasks(v, cur[i], onMissing, `${path}[${i}]`) ?? null);
  }
  if (isPlainObject(incoming)) {
    const cur = isPlainObject(current) ? current : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      const resolved = resolveMasks(v, cur[k], onMissing, path ? `${path}.${k}` : k);
      if (resolved !== undefined) out[k] = resolved;
    }
    return out;
  }
  return incoming;
}
