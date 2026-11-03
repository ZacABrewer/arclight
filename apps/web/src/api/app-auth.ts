import { AppDevice, AppPairCode } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/app-auth/routes.ts (sign-in for the Arclight player app).

export const appAuthApi = {
  /** A one-time code (and QR link) the app trades for a device token; replaces the previous one. */
  pairCode: () => request('/app/pair-codes', AppPairCode, { method: 'POST' }),
  devices: () => request('/app/devices', AppDevice.array()),
  remove: (id: number) => request(`/app/devices/${id}`, null, { method: 'DELETE' }),
};

export const appAuthKeys = {
  pairCode: ['app', 'pair-code'] as const,
  devices: ['app', 'devices'] as const,
};
