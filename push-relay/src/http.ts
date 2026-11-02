/** Origins of the Arclight apps, Arclight Admin and the Arclight player (Capacitor iOS, Capacitor Android, local dev). */
export const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers },
  });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: message }, headers);
}

/** CORS headers for the app-facing endpoints, only for the app's own origins. */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { vary: "Origin" };
  if (origin && APP_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    headers["access-control-allow-headers"] = "authorization, content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/** Largest request body accepted on any endpoint. */
export const MAX_BODY_BYTES = 8 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a JSON object body, enforcing MAX_BODY_BYTES. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Returns the bearer credential, or undefined if the header is missing or malformed. */
export function bearer(request: Request): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1];
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
