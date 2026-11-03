import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { customType } from 'drizzle-orm/sqlite-core';
import { isSecretKey } from '../modules/config-export/secrets.js';

// Encryption at rest for stored secrets (API keys, passwords, tokens, private keys).
//
// A sealed value is a string `enc:v1:<key id>:<iv>:<ciphertext+tag>` (AES-256-GCM, 12-byte IV,
// 16-byte tag, base64url). The key lives in the config directory (`secrets.key`, see
// secret-keys.ts), never in the database. Sealing happens at the column level: the columns that
// hold secrets use `sealedJson` / `sealedText` below instead of `text()`, so every module that
// reads or writes them through Drizzle sees plain values and the database file only ever holds
// sealed ones.
//
// Upgrade path: values written before 0.24 are plain. Reading never requires a value to be sealed
// (plain strings pass through), and the startup backfill (secret-keys.ts) seals what is still
// plain, so existing installs keep working and get migrated in place. With no key registered
// (unit tests, or ARCLIGHT_SECRETS_AT_REST=0) sealing is a no-op.

export const SEALED_PREFIX = 'enc:v1:';
const SEALED_RE = /^enc:v1:([0-9a-f]{16}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Keyring {
  keys: Map<string, Buffer>;
  /** Key id new values are sealed with; null = sealing off (values are stored plain). */
  active: string | null;
  /** Called once per key id whose values cannot be opened (key missing or value damaged). */
  onUnreadable: ((kid: string) => void) | null;
  warned: Set<string>;
}

// One keyring per process: the column types have no access to a db handle. Keys are only ever
// added (a restore merges the archive's key in), so values sealed with an older key stay readable.
const ring: Keyring = { keys: new Map(), active: null, onUnreadable: null, warned: new Set() };

export function keyId(key: Buffer): string {
  return createHash('sha256').update('arclight-secret-key').update(key).digest('hex').slice(0, 16);
}

export function generateSecretKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Adds a key to the process keyring; `active` makes it the key new values are sealed with. */
export function registerSecretKey(key: Buffer, opts: { active?: boolean } = {}): string {
  if (key.length !== KEY_BYTES) throw new Error(`secret key must be ${KEY_BYTES} bytes`);
  const kid = keyId(key);
  ring.keys.set(kid, Buffer.from(key));
  if (opts.active) ring.active = kid;
  return kid;
}

/** Stops sealing new values (keys stay registered so sealed values can still be opened). */
export function setSealing(kid: string | null): void {
  if (kid !== null && !ring.keys.has(kid)) throw new Error(`unknown secret key ${kid}`);
  ring.active = kid;
}

export function sealingKeyId(): string | null {
  return ring.active;
}

export function onUnreadableSecret(fn: ((kid: string) => void) | null): void {
  ring.onUnreadable = fn;
}

/** Test helper: forget every key. */
export function resetSecretKeys(): void {
  ring.keys.clear();
  ring.active = null;
  ring.onUnreadable = null;
  ring.warned.clear();
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && SEALED_RE.test(value);
}

/** Seals a non-empty plain string with the active key; anything else is returned unchanged. */
export function sealString(plain: string): string {
  if (plain === '' || ring.active === null || isSealed(plain)) return plain;
  const key = ring.keys.get(ring.active);
  if (!key) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${SEALED_PREFIX}${ring.active}:${iv.toString('base64url')}:${body.toString('base64url')}`;
}

/**
 * Opens a sealed string. Plain strings are returned as they are; a sealed one whose key is not in
 * the keyring (or that fails authentication) yields undefined, never the ciphertext, so a lost key
 * cannot turn a ciphertext copied out of the database into a working credential.
 */
export function openString(value: string): string | undefined {
  const m = SEALED_RE.exec(value);
  if (!m) return value;
  const [, kid, iv, body] = m as unknown as [string, string, string, string];
  const key = ring.keys.get(kid);
  if (key) {
    try {
      const raw = Buffer.from(body, 'base64url');
      if (raw.length >= TAG_BYTES) {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES });
        decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
        return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
      }
    } catch {
      // fall through: damaged value
    }
  }
  if (!ring.warned.has(kid)) {
    ring.warned.add(kid);
    ring.onUnreadable?.(kid);
  }
  return undefined;
}

/** Plain assignment, except `__proto__` (an own key after JSON.parse) is defined, not set. */
function setOwn(out: Record<string, unknown>, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  else out[k] = v;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Copy of a JSON value with every non-empty string under a secret-looking key (config-export's
 * `isSecretKey`: password, token, apiKey, privateKey, secret, cookies, ...) sealed. Strings that
 * are already sealed are kept, so this is idempotent.
 */
export function sealTree(value: unknown, secret = false): unknown {
  if (ring.active === null) return value;
  if (typeof value === 'string') return secret ? sealString(value) : value;
  if (Array.isArray(value)) return value.map((v) => sealTree(v, secret));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) setOwn(out, k, sealTree(v, secret || isSecretKey(k)));
    return out;
  }
  return value;
}

/**
 * Copy of a JSON value with every sealed string opened, wherever it sits. An unreadable value is
 * dropped from its object (so schema defaults apply: an optional API key is regenerated, a missing
 * password reads as unset) or becomes '' inside an array or at the top level.
 */
export function openTree(value: unknown): unknown {
  if (typeof value === 'string') return openString(value) ?? '';
  if (Array.isArray(value)) return value.map((v) => openTree(v));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSealed(v)) {
        const opened = openString(v);
        if (opened !== undefined) setOwn(out, k, opened);
        continue;
      }
      setOwn(out, k, openTree(v));
    }
    return out;
  }
  return value;
}

/** True when a sealed string sits anywhere in the value. */
export function treeHasSealed(value: unknown): boolean {
  if (isSealed(value)) return true;
  if (Array.isArray(value)) return value.some(treeHasSealed);
  if (isPlainObject(value)) return Object.values(value).some(treeHasSealed);
  return false;
}

/** toDriver of `sealedJson`; also how the backfill recognises a sealed JSON column. */
export function sealedJsonToDriver(value: unknown): string {
  return JSON.stringify(sealTree(value));
}

/** toDriver of `sealedText`; also how the backfill recognises a sealed text column. */
export function sealedTextToDriver(value: string): string {
  return sealString(value);
}

/** Drop-in for `text(name, { mode: 'json' })` whose secret-looking keys are sealed at rest. */
export const sealedJson = customType<{ data: unknown; driverData: string }>({
  dataType: () => 'text',
  toDriver: sealedJsonToDriver,
  fromDriver: (value) => openTree(JSON.parse(value)),
});

/** Drop-in for `text(name)` holding one secret string, sealed at rest. */
export const sealedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: sealedTextToDriver,
  fromDriver: (value) => openString(value) ?? '',
});
