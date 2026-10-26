import { PushPreferences, PushPublicKey, PushSubscriptionResource, PushTestResult, type PushSubscriptionInput } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/push/routes.ts.

export const pushApi = {
  publicKey: () => request('/push/vapid-public-key', PushPublicKey),
  list: () => request('/push/subscription', PushSubscriptionResource.array()),
  subscribe: (body: PushSubscriptionInput) => request('/push/subscription', PushSubscriptionResource, { method: 'POST', json: body }),
  unsubscribe: (endpoint: string) => request('/push/subscription', null, { method: 'DELETE', json: { endpoint } }),
  preferences: () => request('/push/preferences', PushPreferences),
  setPreferences: (body: PushPreferences) => request('/push/preferences', PushPreferences, { method: 'PUT', json: body }),
  test: () => request('/push/test', PushTestResult, { method: 'POST' }),
};
