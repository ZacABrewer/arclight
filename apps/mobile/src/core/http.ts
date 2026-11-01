/**
 * HTTP as the app needs it. In the app this is CapacitorHttp (native networking): no CORS
 * (the user's server does not list the app's origin) and native TLS errors we can classify.
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Final URL after redirects (falls back to the requested URL). */
  url: string;
  data: unknown;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export type NetworkErrorKind = 'tls' | 'timeout' | 'unreachable';

/** Classifies a thrown network error from CapacitorHttp / fetch by its message. */
export function classifyNetworkError(err: unknown): NetworkErrorKind {
  const text = `${(err as { message?: unknown })?.message ?? ''} ${(err as { code?: unknown })?.code ?? ''} ${String(err)}`;
  if (/ssl|tls|certificat|handshake|trust anchor|CertPath|-120[0-6]|-9807|-9813|-9814|-9843/i.test(text)) return 'tls';
  if (/timed? ?out|-1001/i.test(text)) return 'timeout';
  return 'unreachable';
}
