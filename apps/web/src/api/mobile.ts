import { MobileDeviceResource, MobilePairingInfo, MobileTestResult, type MobileDeviceInput } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/mobile/routes.ts.

export const mobileApi = {
  pairing: () => request('/mobile/pairing', MobilePairingInfo),
  devices: () => request('/mobile/devices', MobileDeviceResource.array()),
  /** Admins: every user's devices. */
  allDevices: () => request('/mobile/devices', MobileDeviceResource.array(), { query: { all: true } }),
  register: (body: MobileDeviceInput) => request('/mobile/devices', MobileDeviceResource, { method: 'POST', json: body }),
  remove: (id: number) => request(`/mobile/devices/${id}`, null, { method: 'DELETE' }),
  test: (id: number) => request(`/mobile/devices/${id}/test`, MobileTestResult, { method: 'POST' }),
};
