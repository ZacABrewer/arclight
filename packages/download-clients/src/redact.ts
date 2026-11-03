// What of a client URL an error message may carry (shared by the transports and the API).

/**
 * A URL as error messages may show it: origin and path only. SABnzbd carries its API key and
 * web login in the query, and a host typed as `user:pass@host` would carry userinfo; messages
 * end up in queue status lines, health checks and logs.
 */
export function safeUrl(url: string | URL): string {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).replace(/[?#].*$/s, '').replace(/\/\/[^/@]*@/, '//');
  }
}

/** Query parameters whose values are credentials (SABnzbd: apikey, ma_username, ma_password). */
const SECRET_PARAM = /key|pass|user|token|secret|auth/i;

/** `text` with every occurrence of `url`'s query and userinfo removed (for error texts that quote the URL). */
export function scrubUrl(text: string, url: string | URL): string {
  let out = text;
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (u.href) out = out.split(u.href).join(safeUrl(u));
    if (u.search) out = out.split(u.search).join('');
    if (u.password) out = out.split(u.password).join('***');
    for (const [key, value] of u.searchParams) if (SECRET_PARAM.test(key) && value.length >= 4) out = out.split(value).join('***');
  } catch {
    // Not a URL: nothing of it to remove.
  }
  return out;
}

/**
 * A copy of a transport error safe to keep as a `cause`: the same name, message and cause chain
 * with `url`'s query and userinfo scrubbed (loggers print the whole chain).
 */
export function scrubError(error: unknown, url: string | URL, depth = 0): unknown {
  if (!(error instanceof Error)) return typeof error === 'string' ? scrubUrl(error, url) : error;
  const inner = (error as { cause?: unknown }).cause;
  const copy = new Error(scrubUrl(error.message, url), depth < 3 && inner !== undefined ? { cause: scrubError(inner, url, depth + 1) } : undefined);
  copy.name = error.name;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') Object.assign(copy, { code });
  return copy;
}
