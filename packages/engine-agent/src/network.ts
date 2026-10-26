import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import type { Session } from '@arclight/torrent-engine';

/** Where the engine binds while the followed interface is missing: nothing can leave. */
export const LOCKDOWN_ADDRESS = '127.0.0.1';

export interface NetworkFollowerOptions {
  session: Session;
  /** Interface whose IPv4 address the engine binds to (e.g. tun0, wg0). */
  interfaceName: string | null;
  /** File holding a forwarded port number (Gluetun writes /tmp/gluetun/forwarded_port). */
  portFile: string | null;
  pollMs: number;
  log?: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
  /** Test seams. */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  readPortFile?: (path: string) => Promise<string>;
}

/**
 * Keeps the agent's engine on its VPN: binds every socket to the followed interface's address
 * (falling back to loopback, a kill switch, while the interface is gone) and moves the listener
 * onto the forwarded port the VPN client writes to a file.
 */
export class NetworkFollower {
  private timer: NodeJS.Timeout | null = null;
  private up: boolean | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly opts: NetworkFollowerOptions) {}

  /** The interface state for /status. */
  state(): { interface: string | null; up: boolean | null } {
    return { interface: this.opts.interfaceName, up: this.opts.interfaceName ? this.up : null };
  }

  /** True when the forwarded-port file decides the listen port. */
  portManaged(): boolean {
    return this.opts.portFile !== null;
  }

  /** The address the engine should bind to now, or undefined when no interface is followed. */
  interfaceAddress(): string | null | undefined {
    const name = this.opts.interfaceName;
    if (!name) return undefined;
    const list = (this.opts.interfaces ?? networkInterfaces)()[name] ?? [];
    return list.find((a) => a.family === 'IPv4' && !a.internal)?.address ?? list.find((a) => a.family === 'IPv4')?.address ?? null;
  }

  async check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doCheck(): Promise<void> {
    const { session, log } = this.opts;
    const address = this.interfaceAddress();
    if (address !== undefined) {
      const target = address ?? LOCKDOWN_ADDRESS;
      const nowUp = address !== null;
      if (nowUp !== this.up) {
        log?.(nowUp ? 'info' : 'warn', nowUp ? 'VPN interface up; binding the engine to it' : 'VPN interface missing; engine locked to loopback', {
          interface: this.opts.interfaceName,
          address: target,
        });
      }
      this.up = nowUp;
      if (session.settings.listenAddress !== target) await session.bindTo(target);
    }
    if (this.opts.portFile) {
      let raw: string | null = null;
      try {
        raw = await (this.opts.readPortFile ?? ((p) => readFile(p, 'utf8')))(this.opts.portFile);
      } catch {
        raw = null;
      }
      const port = raw === null ? NaN : Number(raw.trim());
      if (Number.isInteger(port) && port > 0 && port < 65536 && session.listenPort !== port) {
        log?.('info', 'forwarded port changed; moving the engine listener', { port });
        await session.setListenPort(port);
      }
    }
  }

  async start(): Promise<void> {
    await this.check();
    if (this.opts.interfaceName || this.opts.portFile) {
      this.timer = setInterval(() => void this.check().catch((err: unknown) => this.opts.log?.('warn', 'network check failed', { err: String(err) })), this.opts.pollMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
