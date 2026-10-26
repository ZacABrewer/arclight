import { finding, type HealthCheckDef } from '../types.js';

/** VPN enabled but down (error), or traffic leaving through the home IP (warning). */
export const vpnDisconnectedCheck: HealthCheckDef = {
  id: 'VpnDisconnected',
  async run(deps) {
    if (!deps.vpn) return [];
    const status = await deps.vpn();
    if (!status.enabled) return [];
    if (!status.connected) {
      const suffix = status.error ? ` ${status.error}` : '';
      return [finding(this.id, 'error', `VPN (${status.provider ?? 'unknown'}) is enabled but not connected.${suffix}`, 'vpn-disconnected')];
    }
    if (status.leak) {
      return [
        finding(
          this.id,
          'warning',
          `Public IP ${status.publicIp ?? ''} matches your home IP: traffic is not going through the VPN.`,
          'vpn-leak',
        ),
      ];
    }
    return [];
  },
};
