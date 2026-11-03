import type { FastifyReply, FastifyRequest } from 'fastify';

// Minimal cookie handling for the one cookie we own; no cookie plugin needed.

export const SESSION_COOKIE = 'al_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, opts: { maxAgeSeconds: number | null; secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAgeSeconds !== null) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Per request: whether the page is known to be served over https although the request arrived as
 * http (a TLS proxy that does not send X-Forwarded-Proto). Set by installAuth from the Application
 * URL: an https Application URL on the request's own host.
 */
const httpsHints = new WeakMap<FastifyRequest, () => boolean>();

export function bindHttpsHint(req: FastifyRequest, hint: () => boolean): void {
  httpsHints.set(req, hint);
}

/** Whether cookies set on this request get `Secure`. */
export function isHttps(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  return httpsHints.get(req)?.() ?? false;
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, maxAgeSeconds: number | null): void {
  reply.header('set-cookie', sessionCookie(token, { maxAgeSeconds, secure: isHttps(req) }));
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.header('set-cookie', sessionCookie('', { maxAgeSeconds: 0, secure: isHttps(req) }));
}
