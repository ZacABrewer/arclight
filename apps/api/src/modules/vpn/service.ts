import type { Logger } from 'pino';
import type { VpnProviderType, VpnSettings, VpnSettingsUpdate, VpnStatus } from '@media-tron/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { VpnError, errorMessage } from './errors.js';
import { defaultInterfaceDeps } from './interfaces.js';
import { createProviders, type ProbeResult, type ProviderDeps, type VpnProvider } from './providers.js';
import { applyVpnUpdate, getVpnSettings, maskVpnSettings, saveVpnSettings } from './settings.js';
import { nodeShellRunner } from './shell.js';

// VPN status, transitions and the grab guard.
//
// `refresh()` probes the configured provider, folds the result into one VpnStatus, publishes a
// `vpn` event whenever something meaningful changed (connected, IP, port, address, leak,
// error) and, for Gluetun, pushes a changed forwarded port to qBittorrent. `isSafeToGrab()`
// is what the releases module consults before a grab; `getTunnelAddress()` is the bind
// address for the built-in torrent engine. The kill switch is the `vpn` event with
// `killSwitchEngaged: true` (and `getTunnelAddress()` returning null).

export interface ListenPortSync {
  setListenPortOnAll(port: number): Promise<Array<{ id: number; name: string; ok: boolean; message?: string }>>;
}

export interface VpnServiceOptions {
  db: Db;
  bus?: EventBus | undefined;
  log?: Logger | undefined;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Replace provider adapters (tests). */
  providers?: Partial<Record<VpnProviderType, VpnProvider>>;
  providerDeps?: Partial<ProviderDeps>;
  downloadClients?: ListenPortSync | undefined;
  /** Kill-switch watcher period for the native providers. Default 5 s. */
  watchIntervalMs?: number;
}

/** Shortest gap between watcher-triggered refreshes. */
const WATCH_REFRESH_MIN_MS = 15_000;

export const GRAB_GUARD_REASON = 'The VPN is down or not protecting traffic; grabs are paused until it reconnects.';

function initialStatus(): VpnStatus {
  return { enabled: false, connected: false, lastChecked: null, lastChanged: null };
}

const SIGNIFICANT: Array<keyof VpnStatus> = [
  'enabled',
  'provider',
  'connected',
  'publicIp',
  'forwardedPort',
  'tunnelAddress',
  'leak',
  'killSwitchEngaged',
  'error',
  'downloadClientPortSynced',
];

export class VpnService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly providers: Record<VpnProviderType, VpnProvider>;
  private readonly downloadClients: ListenPortSync | undefined;
  private readonly watchIntervalMs: number;

  private status: VpnStatus = initialStatus();
  private lastSyncedPort: number | undefined;
  private inFlight: Promise<VpnStatus> | null = null;
  private manuallyDisconnected = false;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastWatchRefresh = 0;

  constructor(opts: VpnServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.downloadClients = opts.downloadClients;
    this.watchIntervalMs = opts.watchIntervalMs ?? 5_000;
    const shell = opts.providerDeps?.shell ?? nodeShellRunner;
    const deps: ProviderDeps = {
      fetch: (input, init) => globalThis.fetch(input, init),
      shell,
      interfaces: defaultInterfaceDeps(shell),
      env: this.env,
      now: this.now,
      ...opts.providerDeps,
    };
    this.providers = { ...createProviders(deps), ...opts.providers };
  }

  // ---- settings -------------------------------------------------------------------------

  settings(): VpnSettings {
    return getVpnSettings(this.db);
  }

  maskedSettings() {
    return maskVpnSettings(this.settings(), this.env);
  }

  updateSettings(update: VpnSettingsUpdate) {
    const saved = saveVpnSettings(this.db, applyVpnUpdate(this.settings(), update, this.env));
    this.bus?.publish({ type: 'settings', section: 'vpn' });
    // Provider or credentials may have changed: re-sync the port and re-check soon.
    this.lastSyncedPort = undefined;
    void this.refresh().catch((err: unknown) => this.log?.warn({ err }, 'vpn refresh after settings change failed'));
    return maskVpnSettings(saved, this.env);
  }

  // ---- status ---------------------------------------------------------------------------

  getStatus(): VpnStatus {
    return this.status;
  }

  /** Probe now. Concurrent callers share one probe. */
  refresh(): Promise<VpnStatus> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Scheduler entry point: a no-op when disabled, otherwise refresh once the poll interval passed. */
  async refreshIfDue(): Promise<string> {
    const s = this.settings();
    if (!s.enabled) {
      if (this.status.enabled) await this.refresh();
      return 'disabled';
    }
    const last = this.status.lastChecked ? new Date(this.status.lastChecked).getTime() : 0;
    // One second of slack so a 60 s interval does not skip every other minute tick.
    if (this.now().getTime() - last < s.pollIntervalSeconds * 1000 - 1000) return 'not due';
    const st = await this.refresh();
    return st.connected ? `connected${st.publicIp ? ` (${st.publicIp})` : ''}` : `disconnected${st.error ? `: ${st.error}` : ''}`;
  }

  /** Probe a draft configuration without saving it or publishing anything. */
  async test(update: VpnSettingsUpdate): Promise<VpnStatus> {
    const draft = applyVpnUpdate(this.settings(), { ...update, enabled: true }, this.env);
    const { status } = await this.probeInto(draft, { ...initialStatus() }, false);
    return status;
  }

  // ---- guard and bind address -------------------------------------------------------------

  /** True when grabs may proceed: VPN disabled, guard off, or connected without a leak. */
  async isSafeToGrab(): Promise<boolean> {
    const s = this.settings();
    if (!s.enabled || !enforces(s)) return true;
    const last = this.status.lastChecked ? new Date(this.status.lastChecked).getTime() : 0;
    // Stale (or never checked): probe first rather than trusting an old answer.
    if (!this.status.enabled || this.now().getTime() - last > 2 * s.pollIntervalSeconds * 1000) await this.refresh();
    return this.status.connected && !this.status.leak;
  }

  /** IPv4 of the VPN adapter to bind torrent sockets to; null when unknown, down or leaking. */
  getTunnelAddress(): string | null {
    const st = this.status;
    if (!st.enabled || !st.connected || st.leak || st.killSwitchEngaged) return null;
    return st.tunnelAddress ?? null;
  }

  // ---- native tunnel control ----------------------------------------------------------------

  async connect(): Promise<VpnStatus> {
    const s = this.settings();
    const provider = this.providers[s.provider.type];
    if (!provider.connect) throw new VpnError('unsupported', `The ${s.provider.type} provider does not manage the tunnel.`);
    this.manuallyDisconnected = false;
    await provider.connect(s);
    this.log?.info({ provider: s.provider.type }, 'vpn tunnel started');
    return this.refresh();
  }

  async disconnect(): Promise<VpnStatus> {
    const s = this.settings();
    const provider = this.providers[s.provider.type];
    if (!provider.disconnect) throw new VpnError('unsupported', `The ${s.provider.type} provider does not manage the tunnel.`);
    this.manuallyDisconnected = true;
    await provider.disconnect(s);
    this.log?.info({ provider: s.provider.type }, 'vpn tunnel stopped by user');
    return this.refresh();
  }

  // ---- kill-switch watcher ------------------------------------------------------------------

  /** Poll adapter presence every few seconds (native providers) so a dropped tunnel is noticed fast. */
  startWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => void this.watchTick(), this.watchIntervalMs);
    this.watchTimer.unref?.();
  }

  stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** One watcher step; exposed for tests. Returns true when it triggered a refresh. */
  async watchTick(): Promise<boolean> {
    if (!this.status.enabled || !this.status.connected) return false;
    const s = this.settings();
    const provider = this.providers[s.provider.type];
    if (!s.enabled || !provider.quickCheck || provider.quickCheck(s)) return false;
    const now = this.now().getTime();
    if (now - this.lastWatchRefresh < WATCH_REFRESH_MIN_MS) return false;
    this.lastWatchRefresh = now;
    try {
      await this.refresh();
    } catch (err) {
      this.log?.warn({ err }, 'vpn watcher refresh failed');
    }
    return true;
  }

  // ---- internals ------------------------------------------------------------------------------

  private async doRefresh(): Promise<VpnStatus> {
    const s = this.settings();
    const prev = this.status;
    const { status: next, probed } = await this.probeInto(s, prev, true);
    if (probed) await this.syncPort(s, next);
    return this.commit(prev, next);
  }

  private async probeInto(
    s: VpnSettings,
    prev: VpnStatus,
    live: boolean,
  ): Promise<{ status: VpnStatus; probed: boolean }> {
    const checked = this.now().toISOString();
    if (!s.enabled) {
      return { status: { enabled: false, connected: false, lastChecked: checked, lastChanged: prev.lastChanged }, probed: false };
    }
    let result: ProbeResult;
    try {
      result = await this.providers[s.provider.type].probe(s, { allowAutoStart: live && !this.manuallyDisconnected });
    } catch (err) {
      result = { connected: false, error: errorMessage(err) };
    }
    const leak = Boolean(s.homePublicIp && result.publicIp && result.publicIp === s.homePublicIp);
    const status: VpnStatus = {
      ...result,
      enabled: true,
      provider: s.provider.type,
      leak,
      killSwitchEngaged: enforces(s) && (!result.connected || leak),
      lastChecked: checked,
      lastChanged: prev.lastChanged,
      ...(prev.downloadClientPortSynced !== undefined && result.forwardedPort === prev.forwardedPort
        ? { downloadClientPortSynced: prev.downloadClientPortSynced }
        : {}),
    };
    if (leak && !result.error) status.error = `Public IP ${result.publicIp} is your home IP: traffic is not going through the VPN.`;
    return { status, probed: true };
  }

  private async syncPort(s: VpnSettings, next: VpnStatus): Promise<void> {
    const port = next.forwardedPort;
    if (s.provider.type !== 'gluetun' || !s.syncForwardedPortToDownloadClient || !this.downloadClients) return;
    if (port === undefined || !next.connected || port === this.lastSyncedPort) return;
    let results: Awaited<ReturnType<ListenPortSync['setListenPortOnAll']>>;
    try {
      results = await this.downloadClients.setListenPortOnAll(port);
    } catch (err) {
      this.log?.warn({ err, port }, 'forwarded port sync failed');
      next.downloadClientPortSynced = false;
      return;
    }
    if (results.length === 0) return; // no qBittorrent client yet: try again next poll
    const ok = results.every((r) => r.ok);
    next.downloadClientPortSynced = ok;
    if (ok) {
      this.lastSyncedPort = port;
      this.log?.info({ port, clients: results.map((r) => r.name) }, 'forwarded port synced to download clients');
    } else {
      this.log?.warn({ port, failed: results.filter((r) => !r.ok) }, 'forwarded port sync failed for some clients');
    }
  }

  private commit(prev: VpnStatus, next: VpnStatus): VpnStatus {
    const changed = prev.lastChecked === null || SIGNIFICANT.some((k) => prev[k] !== next[k]);
    if (changed) {
      next.lastChanged = next.lastChecked;
      this.logTransition(prev, next);
    }
    this.status = next;
    if (changed) this.bus?.publish({ type: 'vpn', status: next });
    return next;
  }

  private logTransition(prev: VpnStatus, next: VpnStatus): void {
    if (!this.log) return;
    const ctx = { provider: next.provider, publicIp: next.publicIp, port: next.forwardedPort, address: next.tunnelAddress };
    if (!next.enabled) {
      if (prev.enabled) this.log.info('vpn monitoring disabled');
    } else if (next.leak && !prev.leak) {
      this.log.warn(ctx, 'vpn leak: public IP equals the home IP');
    } else if (next.connected && !prev.connected) {
      this.log.info(ctx, 'vpn connected');
    } else if (!next.connected && (prev.connected || prev.lastChecked === null)) {
      this.log.warn({ ...ctx, error: next.error }, 'vpn disconnected');
    } else {
      this.log.info(ctx, 'vpn status changed');
    }
  }
}

/** Whether a down VPN blocks grabs: the guard setting, or the WireGuard kill switch. */
function enforces(s: VpnSettings): boolean {
  return s.pauseGrabsWhenDown || (s.provider.type === 'wireguard-windows' && s.provider.killSwitch);
}

// One service per app context so health, releases and the torrent engine share its status.
const services = new WeakMap<AppContext, VpnService>();

/** `overrides` apply only when this call creates the instance. */
export function vpnServiceFor(ctx: AppContext, overrides: Partial<Omit<VpnServiceOptions, 'db'>> = {}): VpnService {
  let service = services.get(ctx);
  if (!service) {
    service = new VpnService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'vpn' }),
      // Resolved lazily so module registration order does not matter.
      downloadClients: { setListenPortOnAll: (port) => getDownloadClientsService(ctx).setListenPortOnAll(port) },
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}
