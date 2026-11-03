/**
 * Scheme allow-list for links built from API data (indexer info URLs, podcast and artist links,
 * trailers, release notes, sign-in verification pages). Those values come from third parties, so a
 * `javascript:` or `data:` URL must never reach an href: the link then renders without one.
 */

/** Whether the value is an absolute http(s) URL. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The value as an href when it is an absolute http(s) URL, else undefined (no href rendered). */
export function externalHref(value: string | null | undefined): string | undefined {
  return isHttpUrl(value) ? value : undefined;
}

/** Like {@link externalHref}, also allowing magnet links (release downloads). */
export function downloadHref(value: string | null | undefined): string | undefined {
  if (typeof value === 'string' && /^magnet:\?/i.test(value)) return value;
  return externalHref(value);
}
