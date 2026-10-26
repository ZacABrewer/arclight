import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VpnSettingsUpdate, VpnStatus } from '@arclight/shared';
import { vpnApi } from '../api/vpn.js';
import { useInvalidatingMutation } from './settings-keys.js';

// Everything VPN lives under ['vpn'], which live.ts invalidates on every `vpn` event.
export const vpnKeys = {
  all: ['vpn'] as const,
  status: ['vpn', 'status'] as const,
  settings: ['vpn', 'settings'] as const,
};

export function useVpnStatus() {
  return useQuery({ queryKey: vpnKeys.status, queryFn: vpnApi.status, retry: false });
}

export function useVpnSettings() {
  return useQuery({ queryKey: vpnKeys.settings, queryFn: vpnApi.settings.get, retry: false });
}

export function useSaveVpnSettings() {
  return useInvalidatingMutation((body: VpnSettingsUpdate) => vpnApi.settings.update(body), [vpnKeys.all], {
    errorTitle: 'Could not save VPN settings',
  });
}

/** Probe a draft configuration; the result is shown inline, not cached. */
export function useTestVpn() {
  return useMutation({ mutationFn: (body: VpnSettingsUpdate) => vpnApi.test(body), meta: { silent: true } });
}

/** Refresh / connect / disconnect: each answers with the new status, written into the cache. */
export function useVpnAction(action: 'refresh' | 'connect' | 'disconnect') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<VpnStatus> => vpnApi[action](),
    meta: { errorTitle: `VPN ${action} failed` },
    onSuccess: (status) => qc.setQueryData(vpnKeys.status, status),
  });
}
