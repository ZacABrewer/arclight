/**
 * Transport for the Deluge Web UI JSON-RPC API (`POST <base>/json`).
 *
 * Deluge's Web UI is a proxy in front of the daemon: it needs a login (`auth.login`, which
 * sets a `_session_id` cookie) and must itself be connected to a daemon from its Connection
 * Manager before `core.*` / `label.*` / `daemon.*` methods exist. This class handles both
 * lazily, re-authenticates once when the session expires (error code 1), and reconnects once
 * when the Web UI has lost its daemon.
 */
import type { z } from 'zod';
import { httpStatusError, sendHttp, validate } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import {
  DelugeAny,
  DelugeBoolean,
  DelugeEnvelope,
  DelugeHostStatus,
  DelugeHosts,
  type DelugeRpcErrorShape,
} from './schemas.js';

const CLIENT_NAME = 'Deluge';

/** JSON-RPC error codes used by the Deluge Web UI. */
export const DELUGE_ERROR_NOT_AUTHENTICATED = 1;
export const DELUGE_ERROR_UNKNOWN_METHOD = 2;

export interface DelugeRpcSettings {
  /** Web UI root, e.g. `http://nas:8112` or `https://nas/deluge`. */
  baseUrl: string;
  password: string;
}

/** A JSON-RPC level failure, before it is mapped to a `DownloadClientError`. */
class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly rpc: DelugeRpcErrorShape,
  ) {
    super(rpc.message);
  }
}

interface HostInfo {
  id: string;
  label: string;
  status: string | undefined;
  version: string | undefined;
}

const HOST_STATUSES = new Set(['Online', 'Offline', 'Connected']);

/** Extracts `name=value` pairs from Set-Cookie headers into a Cookie header value. */
function cookieHeaderFrom(response: Response): string | undefined {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
  const pairs = raw
    .map((line) => line.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/** Finds the status word and the version that follows it in either host-status row layout. */
export function parseHostStatus(id: string, row: readonly unknown[] | null): Pick<HostInfo, 'status' | 'version'> {
  if (row === null) return { status: undefined, version: undefined };
  const index = row.findIndex((value, i) => i > 0 && typeof value === 'string' && HOST_STATUSES.has(value));
  if (index < 0) return { status: undefined, version: undefined };
  const status = row[index] as string;
  const after = row[index + 1];
  const version = typeof after === 'string' && after !== '' && after !== id ? after : undefined;
  return { status, version };
}

function isWebMethod(method: string): boolean {
  return method.startsWith('web.') || method.startsWith('auth.');
}

/** Maps a JSON-RPC error to a typed error. */
function mapFailure(failure: RpcFailure): DownloadClientError {
  const { method, rpc } = failure;
  const message = rpc.message.trim();
  if (rpc.code === DELUGE_ERROR_NOT_AUTHENTICATED) {
    return new DownloadClientError('auth', `Deluge reports the session is not authenticated (${method}).`);
  }
  if (rpc.code === DELUGE_ERROR_UNKNOWN_METHOD) {
    const hint = method.startsWith('label.') ? ' Is the Label plugin enabled?' : '';
    return new DownloadClientError('not-found', `Deluge does not know the method ${method}.${hint}`);
  }
  if (/InvalidTorrentError|not in session/i.test(message)) {
    return new DownloadClientError('not-found', `Deluge does not know that torrent (${method}): ${message}`);
  }
  if (/AddTorrentError|already in session/i.test(message) || method.startsWith('core.add_torrent')) {
    return new DownloadClientError('rejected', `Deluge refused ${method}: ${message}`);
  }
  return new DownloadClientError('bad-response', `Deluge returned an error for ${method}: ${message} (code ${rpc.code})`);
}

export class DelugeRpc {
  private cookie: string | undefined;
  private authenticated = false;
  private connected = false;
  private pending: Promise<void> | undefined;
  private nextId = 1;
  /** Daemon version seen in the Connection Manager, when Deluge reported one. */
  hostVersion: string | undefined;

  constructor(
    private readonly settings: DelugeRpcSettings,
    private readonly runtime: ClientRuntime,
  ) {}

  /** Forgets the session and daemon connection so the next call starts over. */
  reset(): void {
    this.cookie = undefined;
    this.authenticated = false;
    this.connected = false;
  }

  /** Logs in and connects the Web UI to a daemon if that has not happened yet. */
  async ensureReady(): Promise<void> {
    if (this.authenticated && this.connected) return;
    // Concurrent callers share one login/connect round trip.
    this.pending ??= this.establish().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * Re-runs the daemon connection even though the Web UI is connected. Used after enabling
   * a plugin, so the Web UI refreshes its list of exported daemon methods.
   */
  async reconnect(): Promise<void> {
    await this.ensureReady();
    await this.connectDaemon(true);
  }

  /** Calls a JSON-RPC method and validates its `result` against `schema`. */
  async call<T extends z.ZodType>(method: string, params: readonly unknown[], schema: T): Promise<z.infer<T>> {
    await this.ensureReady();
    try {
      return validate(CLIENT_NAME, method, await this.invoke(method, params), schema);
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;

      if (error.rpc.code === DELUGE_ERROR_NOT_AUTHENTICATED) {
        // Session expired (Web UI restarted, or timed out): log in once more and retry.
        this.reset();
        await this.ensureReady();
        return this.retry(method, params, schema);
      }

      if (error.rpc.code === DELUGE_ERROR_UNKNOWN_METHOD && !isWebMethod(method)) {
        // Daemon methods disappear when the Web UI loses its daemon connection.
        const stillConnected = await this.invokeValidated('web.connected', [], DelugeBoolean);
        if (!stillConnected) {
          this.connected = false;
          await this.ensureReady();
          return this.retry(method, params, schema);
        }
      }
      throw mapFailure(error);
    }
  }

  private async retry<T extends z.ZodType>(method: string, params: readonly unknown[], schema: T): Promise<z.infer<T>> {
    try {
      return validate(CLIENT_NAME, method, await this.invoke(method, params), schema);
    } catch (error) {
      if (error instanceof RpcFailure) {
        if (error.rpc.code === DELUGE_ERROR_NOT_AUTHENTICATED) {
          throw new DownloadClientError('auth', 'Deluge rejected the session after logging in again.');
        }
        throw mapFailure(error);
      }
      throw error;
    }
  }

  private async establish(): Promise<void> {
    if (!this.authenticated) await this.login();
    if (!this.connected) await this.connectDaemon(false);
  }

  private async login(): Promise<void> {
    this.cookie = undefined;
    const { envelope, response } = await this.post('auth.login', [this.settings.password]);
    if (envelope.error) throw mapFailure(new RpcFailure('auth.login', envelope.error));
    if (envelope.result !== true) {
      throw new DownloadClientError('auth', 'Deluge rejected the Web UI password.');
    }
    const cookie = cookieHeaderFrom(response);
    if (cookie === undefined) {
      throw new DownloadClientError('auth', 'Deluge accepted the password but did not issue a session cookie.');
    }
    this.cookie = cookie;
    this.authenticated = true;
  }

  private async connectDaemon(force: boolean): Promise<void> {
    if (!force && (await this.invokeValidated('web.connected', [], DelugeBoolean))) {
      this.connected = true;
      return;
    }

    const rows = await this.invokeValidated('web.get_hosts', [], DelugeHosts);
    const hosts: HostInfo[] = [];
    for (const row of rows) {
      const id = row[0];
      if (typeof id !== 'string' || id === '') continue;
      const label = `${String(row[1] ?? '?')}:${String(row[2] ?? '?')}`;
      let statusRow: readonly unknown[] | null = null;
      try {
        statusRow = await this.invokeValidated('web.get_host_status', [id], DelugeHostStatus);
      } catch (error) {
        // A host whose status cannot be read is still a candidate; anything else bubbles.
        if (!(error instanceof DownloadClientError && error.code === 'bad-response')) throw error;
      }
      hosts.push({ id, label, ...parseHostStatus(id, statusRow) });
    }
    if (hosts.length === 0) {
      throw new DownloadClientError(
        'unreachable',
        'The Deluge Web UI is not connected to a daemon and has no hosts in its Connection Manager. Add the Deluge daemon there first.',
      );
    }

    const host = hosts.find((h) => h.status === 'Connected') ??
      hosts.find((h) => h.status === 'Online') ??
      hosts[0];
    if (host === undefined) throw new DownloadClientError('unreachable', 'No Deluge daemon available.');

    await this.invokeValidated('web.connect', [host.id], DelugeAny);
    if (!(await this.invokeValidated('web.connected', [], DelugeBoolean))) {
      throw new DownloadClientError(
        'unreachable',
        `The Deluge Web UI could not connect to the daemon at ${host.label} (status: ${host.status ?? 'unknown'}). Check that deluged is running.`,
      );
    }
    if (host.version !== undefined) this.hostVersion = host.version;
    this.connected = true;
  }

  /** `invoke` + validation with RPC failures mapped directly (used during the handshake). */
  private async invokeValidated<T extends z.ZodType>(method: string, params: readonly unknown[], schema: T): Promise<z.infer<T>> {
    try {
      return validate(CLIENT_NAME, method, await this.invoke(method, params), schema);
    } catch (error) {
      if (error instanceof RpcFailure) {
        if (error.rpc.code === DELUGE_ERROR_NOT_AUTHENTICATED) this.reset();
        throw mapFailure(error);
      }
      throw error;
    }
  }

  /** Sends one call and returns its `result`; JSON-RPC errors are thrown as `RpcFailure`. */
  private async invoke(method: string, params: readonly unknown[]): Promise<unknown> {
    const { envelope } = await this.post(method, params);
    if (envelope.error) throw new RpcFailure(method, envelope.error);
    return envelope.result ?? null;
  }

  private async post(method: string, params: readonly unknown[]): Promise<{ envelope: DelugeEnvelope; response: Response }> {
    const url = `${this.settings.baseUrl}/json`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.cookie !== undefined) headers['Cookie'] = this.cookie;
    const id = this.nextId++;
    const response = await sendHttp(this.runtime, CLIENT_NAME, url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params, id }),
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404) {
        throw new DownloadClientError(
          'not-found',
          `Deluge Web UI JSON API not found at ${url}. Check the host, port and URL base.`,
          { httpStatus: 404 },
        );
      }
      throw httpStatusError(CLIENT_NAME, response.status, method, text);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new DownloadClientError('bad-response', `Deluge returned invalid JSON for ${method}. Is this the Deluge Web UI?`, {
        cause: error,
      });
    }
    return { envelope: validate(CLIENT_NAME, method, raw, DelugeEnvelope), response };
  }
}
