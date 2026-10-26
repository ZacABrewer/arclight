import { z } from 'zod';
import { VpnError } from './errors.js';

// Client for Gluetun's HTTP control server. Endpoint names changed across Gluetun versions:
// newer builds serve /v1/vpn/status and /v1/portforward, older ones /v1/openvpn/status and
// /v1/openvpn/portforwarded. We try the newer path first and fall back on 404.
// Auth: an API key sent as `X-API-Key`, or HTTP basic auth, depending on how the control
// server is configured.

export interface GluetunClientOptions {
  controlUrl: string;
  apiKey?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GluetunPublicIp {
  publicIp?: string;
  country?: string;
  region?: string;
  city?: string;
}

const PublicIpBody = z.looseObject({
  public_ip: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
});
const StatusBody = z.looseObject({ status: z.string() });
const PortBody = z.looseObject({ port: z.number().int().optional() });

export class GluetunClient {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GluetunClientOptions) {
    this.base = opts.controlUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async publicIp(): Promise<GluetunPublicIp> {
    const body = PublicIpBody.safeParse(await this.getJson('/v1/publicip/ip'));
    if (!body.success) throw new VpnError('bad-response', 'Gluetun returned an unexpected public IP body.');
    const b = body.data;
    return {
      ...(b.public_ip ? { publicIp: b.public_ip } : {}),
      ...(b.country ? { country: b.country } : {}),
      ...(b.region ? { region: b.region } : {}),
      ...(b.city ? { city: b.city } : {}),
    };
  }

  /** True when the VPN process reports `running`. */
  async isRunning(): Promise<boolean> {
    const raw = await this.getJsonWithFallback('/v1/vpn/status', '/v1/openvpn/status');
    const body = StatusBody.safeParse(raw);
    if (!body.success) throw new VpnError('bad-response', 'Gluetun returned an unexpected VPN status body.');
    return body.data.status === 'running';
  }

  /** The forwarded port, or undefined when none is forwarded (Gluetun reports 0). */
  async forwardedPort(): Promise<number | undefined> {
    const raw = await this.getJsonWithFallback('/v1/portforward', '/v1/openvpn/portforwarded');
    const body = PortBody.safeParse(raw);
    if (!body.success) throw new VpnError('bad-response', 'Gluetun returned an unexpected port forward body.');
    const port = body.data.port;
    return port && port > 0 ? port : undefined;
  }

  private async getJsonWithFallback(path: string, legacyPath: string): Promise<unknown> {
    try {
      return await this.getJson(path);
    } catch (err) {
      if (err instanceof VpnError && err.code === 'not-found') return this.getJson(legacyPath);
      throw err;
    }
  }

  private headers(): Headers {
    const h = new Headers({ accept: 'application/json' });
    if (this.opts.apiKey) h.set('X-API-Key', this.opts.apiKey);
    if (this.opts.username !== undefined && this.opts.password !== undefined) {
      h.set('authorization', `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64')}`);
    }
    return h;
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new VpnError('timeout', `Gluetun did not answer within ${this.timeoutMs} ms (${url}).`, { cause: err });
      }
      throw new VpnError('unreachable', `Cannot reach Gluetun at ${this.base}: ${(err as Error).message ?? err}`, { cause: err });
    }
    if (res.status === 401 || res.status === 403) {
      throw new VpnError('unauthorized', 'Gluetun rejected the credentials (check the API key or username/password).', {
        httpStatus: res.status,
      });
    }
    if (res.status === 404) throw new VpnError('not-found', `Gluetun has no ${path} endpoint.`, { httpStatus: 404 });
    if (!res.ok) throw new VpnError('bad-response', `Gluetun answered ${res.status} for ${path}.`, { httpStatus: res.status });
    try {
      return await res.json();
    } catch (err) {
      throw new VpnError('bad-response', `Gluetun returned invalid JSON for ${path}.`, { cause: err });
    }
  }
}
