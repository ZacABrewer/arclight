import { z } from 'zod';

// VPN contract (settings section `vpn`, GET /vpn/status, POST /vpn/refresh|test|connect|disconnect).
//
// The section is a provider union discriminated on `provider.type`:
// - `gluetun`            Docker: Arclight and qBittorrent share Gluetun's network namespace;
//                        we poll Gluetun's control server for status, public IP and forwarded port.
// - `wireguard-windows`  Native Windows: Arclight installs/monitors a WireGuard for Windows
//                        tunnel service from a .conf file (e.g. one downloaded from Proton).
// - `interface-binding`  Any OS: an adapter the user manages (e.g. the ProtonVPN app); we watch
//                        its IPv4 address and expose it as the bind address.
// Secrets (Gluetun API key / password) are masked with SECRET_MASK on reads.

export const DEFAULT_GLUETUN_CONTROL_URL = 'http://localhost:8000';
export const DEFAULT_WIREGUARD_EXE = 'C:\\Program Files\\WireGuard\\wireguard.exe';
export const DEFAULT_PUBLIC_IP_CHECK_URL = 'https://api.ipify.org?format=json';

export const VpnProviderType = z.enum(['gluetun', 'wireguard-windows', 'interface-binding']);
export type VpnProviderType = z.infer<typeof VpnProviderType>;

export const GluetunProviderSettings = z.object({
  type: z.literal('gluetun'),
  /** Absent: ARCLIGHT_VPN_CONTROL_URL, then DEFAULT_GLUETUN_CONTROL_URL. */
  controlUrl: z.string().url().optional(),
  /** Sent as `X-API-Key`. */
  apiKey: z.string().min(1).optional(),
  /** HTTP basic auth (older Gluetun / reverse proxies). */
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});
export type GluetunProviderSettings = z.infer<typeof GluetunProviderSettings>;

export const WireguardWindowsProviderSettings = z.object({
  type: z.literal('wireguard-windows'),
  /** Path to the WireGuard .conf; the file name (without .conf) is the tunnel name. */
  configPath: z.string().default(''),
  /** Install the tunnel service when it is not running. */
  autoStart: z.boolean().default(true),
  /** Block grabs and tell the torrent engine to stop when the adapter disappears. */
  killSwitch: z.boolean().default(true),
  /** Override for wireguard.exe; wg.exe is expected next to it. */
  wireguardExe: z.string().min(1).optional(),
});
export type WireguardWindowsProviderSettings = z.infer<typeof WireguardWindowsProviderSettings>;

export const InterfaceBindingProviderSettings = z.object({
  type: z.literal('interface-binding'),
  /** Adapter name as the OS reports it, e.g. "ProtonVPN" or "wg0". */
  interfaceName: z.string().default(''),
});
export type InterfaceBindingProviderSettings = z.infer<typeof InterfaceBindingProviderSettings>;

export const VpnProviderSettings = z.discriminatedUnion('type', [
  GluetunProviderSettings,
  WireguardWindowsProviderSettings,
  InterfaceBindingProviderSettings,
]);
export type VpnProviderSettings = z.infer<typeof VpnProviderSettings>;

/** Stored form of the `vpn` settings section. */
export const VpnSettings = z.object({
  enabled: z.boolean().default(false),
  provider: VpnProviderSettings.default({ type: 'gluetun' }),
  /** Gluetun: push Gluetun's forwarded port to enabled qBittorrent clients. */
  syncForwardedPortToDownloadClient: z.boolean().default(true),
  /** Reject grabs (temporarily) while the VPN is down or leaking. */
  pauseGrabsWhenDown: z.boolean().default(true),
  /** Your ISP address; a public IP equal to it means traffic bypasses the VPN. */
  homePublicIp: z.string().min(1).optional(),
  /** Used by the native providers (Gluetun reports its own public IP). */
  publicIpCheckUrl: z.string().url().default(DEFAULT_PUBLIC_IP_CHECK_URL),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
});
export type VpnSettings = z.infer<typeof VpnSettings>;
export type VpnSettingsInput = z.input<typeof VpnSettings>;

/** GET /settings/vpn: secrets are SECRET_MASK when stored, absent otherwise. */
export const VpnSettingsResponse = VpnSettings;
export type VpnSettingsResponse = z.infer<typeof VpnSettingsResponse>;

/**
 * PUT /settings/vpn and POST /vpn/test. Secrets: SECRET_MASK or omitted keeps the stored value
 * (when the provider type is unchanged), '' clears it, anything else replaces it.
 */
export const VpnSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  provider: z
    .discriminatedUnion('type', [
      GluetunProviderSettings.extend({
        controlUrl: z.string().url().or(z.literal('')).optional(),
        apiKey: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
      WireguardWindowsProviderSettings.extend({ wireguardExe: z.string().optional() }),
      InterfaceBindingProviderSettings,
    ])
    .optional(),
  syncForwardedPortToDownloadClient: z.boolean().optional(),
  pauseGrabsWhenDown: z.boolean().optional(),
  homePublicIp: z.string().nullable().optional(),
  publicIpCheckUrl: z.string().url().optional(),
  pollIntervalSeconds: z.number().int().min(10).max(3600).optional(),
});
export type VpnSettingsUpdate = z.infer<typeof VpnSettingsUpdate>;

export const VpnStatus = z.object({
  enabled: z.boolean(),
  provider: VpnProviderType.optional(),
  connected: z.boolean(),
  publicIp: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  /** Gluetun: port forwarded by the VPN provider. */
  forwardedPort: z.number().int().optional(),
  /** Native providers: IPv4 of the VPN adapter (the address to bind sockets to). */
  tunnelAddress: z.string().optional(),
  interfaceName: z.string().optional(),
  /** WireGuard peer endpoint, e.g. 185.1.2.3:51820. */
  endpoint: z.string().optional(),
  /** ISO-8601 time of the last WireGuard handshake. */
  lastHandshake: z.string().optional(),
  rxBytes: z.number().int().optional(),
  txBytes: z.number().int().optional(),
  /** Public IP equals homePublicIp: traffic is not going through the VPN. */
  leak: z.boolean().optional(),
  /** True when grabs (and torrent sockets) must stop: enabled and down or leaking. */
  killSwitchEngaged: z.boolean().optional(),
  /** ISO-8601; null before the first check. */
  lastChecked: z.string().nullable(),
  lastChanged: z.string().nullable(),
  error: z.string().optional(),
  downloadClientPortSynced: z.boolean().optional(),
});
export type VpnStatus = z.infer<typeof VpnStatus>;

export const VpnErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type VpnErrorResponse = z.infer<typeof VpnErrorResponse>;
