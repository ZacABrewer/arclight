// Hashed/obfuscated releases: the name is random, the real title is hidden in a folder or
// in a trailing tag. We detect them so the caller can fall back to other information.

const HEX32 = /^[a-f0-9]{32}$/i;
const HEX40 = /^[a-f0-9]{40}$/i;
const BASE64ISH = /^[a-z0-9+/]{20,}={0,2}$/i;
const OBFUSCATED_MARKERS = /(?:^|[-_. ])(?:obfuscated|scrambled|-xpost|-postbot|abc\d{3,}|[a-z0-9]{16,})(?=[-_. ]|$)/i;
const RELEASE_HASH_TAG = /(?:\[(?<hash>[a-f0-9]{8})\]|\((?<paren>[a-f0-9]{8})\))$/i;
const WORDLESS = /^[a-z0-9]{8,}$/i;

export function isHashedRelease(title: string): boolean {
  const base = title.replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  if (HEX32.test(base) || HEX40.test(base)) return true;
  if (WORDLESS.test(base) && !/\d{3,4}p/i.test(base)) return true;
  if (BASE64ISH.test(base) && !/[-_. ]/.test(base)) return true;
  if (OBFUSCATED_MARKERS.test(base) && !/\bS\d{1,2}E\d{1,3}\b/i.test(base) && !/\b(?:19|20)\d{2}\b/.test(base)) return true;
  return false;
}

export function parseReleaseHash(title: string): string | null {
  const g = RELEASE_HASH_TAG.exec(title.trim())?.groups;
  return (g?.['hash'] ?? g?.['paren'])?.toUpperCase() ?? null;
}
