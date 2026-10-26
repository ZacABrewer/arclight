/**
 * Per-instance cookie jar (S13.7): name -> value only, no domain/path scoping. Every
 * request to the site carries the whole jar. Expiry is tracked for the jar as a whole
 * (S8.2) rather than per cookie.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  /** Epoch ms after which the jar is considered stale; undefined = never. */
  expiresAt: number | undefined;

  constructor(initial?: Record<string, string> | Iterable<[string, string]>) {
    if (initial) {
      const entries = Symbol.iterator in initial ? initial : Object.entries(initial);
      for (const [name, value] of entries) this.set(name, value);
    }
  }

  get size(): number {
    return this.cookies.size;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  set(name: string, value: string): void {
    const key = name.trim();
    if (key) this.cookies.set(key, value);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  clear(): void {
    this.cookies.clear();
    this.expiresAt = undefined;
  }

  /** True when the jar has an expiry and it has passed. */
  isExpired(now: number = Date.now()): boolean {
    return this.expiresAt !== undefined && now >= this.expiresAt;
  }

  /** Parse a `Cookie:` header style string (`a=1; b=2`) and merge it in (S8.8). */
  importCookieHeader(header: string): void {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      this.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }

  /**
   * Merge `Set-Cookie` header values. Only the leading `name=value` pair is used; a cookie
   * whose `Expires` is in the past or `Max-Age` <= 0 is removed (sites log out that way).
   */
  importSetCookie(values: readonly string[], now: number = Date.now()): void {
    for (const raw of values) {
      const [pair = '', ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      let expired = false;
      for (const attr of attrs) {
        const [k = '', v = ''] = attr.split('=', 2).map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === 'max-age' && Number(v) <= 0) expired = true;
        if (key === 'expires') {
          const t = Date.parse(v);
          if (Number.isFinite(t) && t <= now) expired = true;
        }
      }
      if (expired) this.delete(name);
      else this.set(name, value);
    }
  }

  /** Merge every `Set-Cookie` of a fetch Response. */
  importResponse(response: Response, now: number = Date.now()): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (values.length === 0) {
      const single = response.headers.get('set-cookie');
      if (single) values.push(...splitCombinedSetCookie(single));
    }
    this.importSetCookie(values, now);
  }

  /** Value for a `Cookie` request header, or undefined when empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  entries(): Array<[string, string]> {
    return [...this.cookies];
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }
}

/** Split a comma-folded Set-Cookie header without breaking `Expires=Wed, 01 Jan ...`. */
function splitCombinedSetCookie(header: string): string[] {
  return header.split(/,(?=\s*[^;,=\s]+=)/).map((s) => s.trim()).filter(Boolean);
}
