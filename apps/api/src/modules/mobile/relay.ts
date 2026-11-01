import type { RelaySendBody } from '@arclight/shared';

// The push relay's send API: POST <relay>/v1/send, `Authorization: Bearer <relaySecret>`.
//   200 sent · 404 unknown device · 410 device gone (token invalid) · 429 rate limited ·
//   503 relay not configured. The relay never stores the notification content.

export const RELAY_TIMEOUT_MS = 10_000;

export type RelayOutcome =
  /** Delivered to the relay. */
  | { kind: 'sent' }
  /** 404 / 410: the device no longer exists at the relay; delete it here. */
  | { kind: 'gone'; status: number }
  /** 429, 5xx, timeout or network error: back off, maybe retry once. */
  | { kind: 'retry'; status?: number; retryAfterMs?: number; message: string }
  /** Any other answer (400, 401, 403…): give up on this send. */
  | { kind: 'failed'; status: number; message: string };

export interface RelayClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Retry-After as seconds or an HTTP date → milliseconds; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class RelayClient {
  readonly sendUrl: string;

  constructor(private readonly opts: RelayClientOptions) {
    this.sendUrl = `${opts.baseUrl.replace(/\/+$/, '')}/v1/send`;
  }

  /** One POST /v1/send. Never throws; the secret is only ever put in the Authorization header. */
  async send(secret: string, body: RelaySendBody): Promise<RelayOutcome> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.sendUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? RELAY_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { kind: 'retry', message: timedOut ? 'push relay timed out' : 'push relay unreachable' };
    }
    // The body is not needed; drain it so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return { kind: 'sent' };
    if (res.status === 404 || res.status === 410) return { kind: 'gone', status: res.status };
    if (res.status === 429 || res.status >= 500) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const message = res.status === 429 ? 'rate limited by the push relay' : res.status === 503 ? 'push relay not available (503)' : `push relay error (${res.status})`;
      return { kind: 'retry', status: res.status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { kind: 'failed', status: res.status, message: `push relay refused the notification (${res.status})` };
  }
}
