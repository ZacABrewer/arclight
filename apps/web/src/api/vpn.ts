import { VpnSettingsResponse, VpnStatus, type VpnSettingsUpdate } from '@media-tron/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/vpn/routes.ts.

export const vpnApi = {
  status: () => request('/vpn/status', VpnStatus),
  refresh: () => request('/vpn/refresh', VpnStatus, { method: 'POST' }),
  test: (body: VpnSettingsUpdate) => request('/vpn/test', VpnStatus, { method: 'POST', json: body }),
  connect: () => request('/vpn/connect', VpnStatus, { method: 'POST' }),
  disconnect: () => request('/vpn/disconnect', VpnStatus, { method: 'POST' }),
  settings: {
    get: () => request('/settings/vpn', VpnSettingsResponse),
    update: (body: VpnSettingsUpdate) => request('/settings/vpn', VpnSettingsResponse, { method: 'PUT', json: body }),
  },
};
