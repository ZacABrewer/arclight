import type { AppModule } from '../../app.js';
import { registerVpnJobs } from './jobs.js';
import { vpnRoutes } from './routes.js';
import { vpnServiceFor } from './service.js';

export { VpnService, vpnServiceFor, GRAB_GUARD_REASON, type ListenPortSync, type VpnServiceOptions } from './service.js';
export { VpnError, type VpnErrorCode } from './errors.js';
export { GluetunClient } from './gluetun-client.js';
export { WireguardWindows, parseWgDump, tunnelNameFromConfig } from './wireguard-windows.js';
export { findInterfaceIPv4 } from './interfaces.js';
export { nodeShellRunner, type ShellRunner, type ShellResult } from './shell.js';
export { VPN_STATUS_JOB } from './jobs.js';

// VPN integration: Gluetun (Docker), WireGuard for Windows (native) or a user-managed adapter.
// Owns the `vpn` settings section, /vpn/* routes, the VpnStatusCheck job and the kill-switch
// watcher. Other modules use vpnServiceFor(ctx): isSafeToGrab() (releases grab guard),
// getTunnelAddress() (torrent engine bind address) and getStatus() (health).
export const vpnModule: AppModule = (ctx) => async (app) => {
  const service = vpnServiceFor(ctx);
  await app.register(vpnRoutes(service));
  registerVpnJobs(ctx.scheduler, service);
  app.addHook('onReady', async () => {
    service.startWatch();
    // First status right away instead of waiting for the next minute tick.
    void service.refreshIfDue().catch((err: unknown) => ctx.log.warn({ err }, 'initial vpn check failed'));
  });
  app.addHook('onClose', async () => service.stopWatch());
};
