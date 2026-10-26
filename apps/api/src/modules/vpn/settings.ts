import {
  DEFAULT_GLUETUN_CONTROL_URL,
  SECRET_MASK,
  VpnSettings,
  type GluetunProviderSettings,
  type VpnProviderSettings,
  type VpnSettingsResponse,
  type VpnSettingsUpdate,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { getSection, setSection } from '../settings/service.js';

// The `vpn` settings section: reads, secret masking and merging client updates.

export const VPN_CONTROL_URL_ENV = 'ARCLIGHT_VPN_CONTROL_URL';

export function getVpnSettings(db: Db): VpnSettings {
  return getSection(db, 'vpn');
}

/** Stored URL, else ARCLIGHT_VPN_CONTROL_URL, else http://localhost:8000. */
export function effectiveControlUrl(p: GluetunProviderSettings, env: NodeJS.ProcessEnv = process.env): string {
  return p.controlUrl ?? (env[VPN_CONTROL_URL_ENV]?.trim() || DEFAULT_GLUETUN_CONTROL_URL);
}

export function maskVpnSettings(value: VpnSettings, env: NodeJS.ProcessEnv = process.env): VpnSettingsResponse {
  const p = value.provider;
  if (p.type !== 'gluetun') return value;
  const { apiKey, password, ...rest } = p;
  return {
    ...value,
    provider: {
      ...rest,
      controlUrl: effectiveControlUrl(p, env),
      ...(apiKey ? { apiKey: SECRET_MASK } : {}),
      ...(password ? { password: SECRET_MASK } : {}),
    },
  };
}

/** undefined / mask keeps `stored`, '' clears, anything else replaces. */
function secret(next: string | undefined, stored: string | undefined): string | undefined {
  if (next === undefined || next === SECRET_MASK) return stored;
  const t = next.trim();
  return t === '' ? undefined : t;
}

function plain(next: string | undefined, stored: string | undefined): string | undefined {
  if (next === undefined) return stored;
  const t = next.trim();
  return t === '' ? undefined : t;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function mergeProvider(current: VpnProviderSettings, update: VpnSettingsUpdate['provider'], env: NodeJS.ProcessEnv): VpnProviderSettings {
  if (update === undefined) return current;
  switch (update.type) {
    case 'gluetun': {
      const prev = current.type === 'gluetun' ? current : undefined;
      const url = plain(update.controlUrl, prev?.controlUrl);
      return compact({
        type: 'gluetun' as const,
        // The form echoes the effective default back; storing it would pin it and ignore a
        // later ARCLIGHT_VPN_CONTROL_URL change, so only a different URL is stored.
        controlUrl: url === effectiveControlUrl({ type: 'gluetun' }, env) ? undefined : url,
        apiKey: secret(update.apiKey, prev?.apiKey),
        username: plain(update.username, prev?.username),
        password: secret(update.password, prev?.password),
      });
    }
    case 'wireguard-windows':
      return compact({ ...update, configPath: update.configPath.trim(), wireguardExe: plain(update.wireguardExe, undefined) });
    case 'interface-binding':
      return { type: 'interface-binding', interfaceName: update.interfaceName.trim() };
  }
}

export function applyVpnUpdate(current: VpnSettings, update: VpnSettingsUpdate, env: NodeJS.ProcessEnv = process.env): VpnSettings {
  const home = update.homePublicIp === undefined ? current.homePublicIp : (update.homePublicIp?.trim() || undefined);
  return VpnSettings.parse(
    compact({
      enabled: update.enabled ?? current.enabled,
      provider: mergeProvider(current.provider, update.provider, env),
      syncForwardedPortToDownloadClient: update.syncForwardedPortToDownloadClient ?? current.syncForwardedPortToDownloadClient,
      pauseGrabsWhenDown: update.pauseGrabsWhenDown ?? current.pauseGrabsWhenDown,
      homePublicIp: home,
      publicIpCheckUrl: update.publicIpCheckUrl ?? current.publicIpCheckUrl,
      pollIntervalSeconds: update.pollIntervalSeconds ?? current.pollIntervalSeconds,
    }),
  );
}

export function saveVpnSettings(db: Db, value: VpnSettings): VpnSettings {
  return setSection(db, 'vpn', value);
}
