import { EngineAgentSettingsResponse, type EngineAgentSettingsUpdate } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/engine-agent (Arclight as a remote engine for other instances).

export const engineAgentApi = {
  get: () => request('/settings/engineagent', EngineAgentSettingsResponse),
  update: (body: EngineAgentSettingsUpdate) => request('/settings/engineagent', EngineAgentSettingsResponse, { method: 'PUT', json: body }),
};
