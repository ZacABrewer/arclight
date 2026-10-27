import { SECRET_MASK } from './settings.js';

// Free-text secret redaction, shared by the api's debug console and the web's Debugging page
// (copied and downloaded log lines). Deliberately broad: a masked harmless value costs
// nothing, a leaked key in a pasted bug report costs a lot.

/** Name fragments that make a `name=value` / `name: value` pair secret. */
const SECRET_NAME =
  '[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|preshared[_-]?key|pre[_-]?shared[_-]?key|passkey|rsskey|userkey|appkey|cookie|authorization|credentials?)|apikey|key|pass|pwd';

/** "name": "value" (JSON). */
const JSON_PAIR = new RegExp(`("(?:${SECRET_NAME})")(\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`, 'gi');
/** name=value, name: value (logfmt, query strings, env dumps, headers). */
const PLAIN_PAIR = new RegExp(`(\\b(?:${SECRET_NAME}))(\\s*[=:]\\s*)(?!${escapeRe(SECRET_MASK)})([^\\s&,;"'<>}\\]]+)`, 'gi');
/** scheme://user:password@host */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi;
/** Authorization schemes followed by a credential. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** 32-byte keys in base64 (WireGuard private / preshared keys). */
const WG_KEY = /(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])/g;
/** PEM private key blocks. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mask secrets inside free text (key=value pairs, JSON pairs, URL passwords, bearer tokens, WireGuard keys, PEM keys). Idempotent. */
export function redactText(text: string): string {
  return text
    .replace(PEM, `-----PRIVATE KEY ${SECRET_MASK}-----`)
    .replace(JSON_PAIR, (_m, name: string, sep: string, value: string) => `${name}${sep}"${value === '' ? '' : SECRET_MASK}"`)
    .replace(URL_USERINFO, (_m, head: string) => `${head}:${SECRET_MASK}@`)
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${SECRET_MASK}`)
    .replace(PLAIN_PAIR, (_m, name: string, sep: string) => `${name}${sep}${SECRET_MASK}`)
    .replace(WG_KEY, (_m, lead: string) => `${lead}${SECRET_MASK}`);
}

