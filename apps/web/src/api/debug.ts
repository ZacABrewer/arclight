import { DebugRunResponse, DebugSnapshot } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/debug/index.ts.

export const debugApi = {
  snapshot: () => request('/system/debug/snapshot', DebugSnapshot),
  run: (input: string) => request('/system/debug/run', DebugRunResponse, { method: 'POST', json: { input } }),
};
