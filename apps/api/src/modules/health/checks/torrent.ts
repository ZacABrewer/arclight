import { finding, type HealthCheckDef } from '../types.js';

/**
 * Built-in torrent engine: failed to start (error), enabled but not listening for incoming
 * peers (warning), or bound to something other than the VPN tunnel while the VPN is enabled
 * (warning). Lockdown (VPN down) is reported by the VPN check, not here.
 */
export const torrentEngineCheck: HealthCheckDef = {
  id: 'TorrentEngine',
  async run(deps) {
    if (!deps.torrent) return [];
    const st = await deps.torrent();
    if (!st.enabled || st.state === 'disabled' || st.state === 'starting' || st.state === 'lockdown') return [];
    if (st.state === 'error') {
      return [finding(this.id, 'error', `The built-in torrent engine failed to start: ${st.error ?? 'unknown error'}`, 'torrent-engine-failed')];
    }
    const out = [];
    if (!st.listenPort) {
      out.push(
        finding(this.id, 'warning', 'The built-in torrent engine is not listening for incoming connections.', 'torrent-engine-not-listening'),
      );
    }
    if (st.vpn.enabled && st.vpn.tunnelAddress && st.boundAddress !== st.vpn.tunnelAddress) {
      out.push(
        finding(
          this.id,
          'warning',
          `The built-in torrent engine is bound to ${st.boundAddress ?? 'all interfaces'}, not the VPN tunnel address ${st.vpn.tunnelAddress}.${st.vpn.bindToVpn ? '' : ' Turn on "Bind to VPN" under Settings > Torrent Engine.'}`,
          'torrent-engine-not-on-vpn',
        ),
      );
    }
    return out;
  },
};
