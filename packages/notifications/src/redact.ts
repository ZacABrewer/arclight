/**
 * Which settings are credentials, and scrubbing them out of text (error messages, logs, the
 * delivery log). Agents already avoid echoing secrets, but a remote server can quote a token
 * back in its error body; redaction is the second line of defence.
 */

/** Settings keys whose string value is a credential. Webhook URLs embed their token. */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  'password',
  'botToken',
  'accessToken',
  'appToken',
  'apiToken',
  'apiKey',
  'authToken',
  'userKey',
  'webhookUrl',
  'deviceKey',
  'token',
  'configKey',
]);

/** Record-valued settings whose every value is a credential (webhook headers). */
export const SECRET_RECORD_KEYS: ReadonlySet<string> = new Set(['headers']);

/** List-valued settings whose every entry is a credential (Apprise service URLs). */
export const SECRET_LIST_KEYS: ReadonlySet<string> = new Set(['urls']);

export const REDACTED = '[redacted]';

/** Pieces shorter than this are not worth (or safe) redacting: they match ordinary words. */
const MIN_SECRET_LENGTH = 6;
/** URL path segments and query values at least this long are treated as tokens. */
const MIN_URL_PART_LENGTH = 12;

function urlParts(value: string): string[] {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter((p) => p.length >= MIN_URL_PART_LENGTH);
    for (const v of url.searchParams.values()) if (v.length >= MIN_URL_PART_LENGTH) parts.push(v);
    if (url.password) parts.push(url.password);
    return parts.flatMap((p) => [p, safeDecode(p)]);
  } catch {
    return [];
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Every secret string in `settings` (and the token-looking parts of secret URLs). */
export function collectSecrets(settings: Record<string, unknown> | null | undefined): string[] {
  if (!settings) return [];
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    out.add(value);
    for (const part of urlParts(value)) out.add(part);
  };
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_SETTING_KEYS.has(key)) add(value);
    else if (SECRET_RECORD_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const v of Object.values(value)) add(v);
    } else if (SECRET_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (const v of value) add(v);
    }
  }
  // Longest first, so a URL is replaced whole before its token part is.
  return [...out].sort((a, b) => b.length - a.length);
}

/** `text` with every secret of `settings` replaced by "[redacted]". */
export function redactSecrets(text: string, settings: Record<string, unknown> | null | undefined): string {
  let out = text;
  for (const secret of collectSecrets(settings)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}
