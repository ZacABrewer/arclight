import {
  TranscodeHwaccelResponse,
  TranscodeJob,
  TranscodeRule,
  TranscodeRunResult,
  TranscodeSettings,
  type TranscodeJobsQuery,
  type TranscodeRuleInputRaw,
  type TranscodeRunRequest,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md "transcode" (contract: packages/shared/src/transcode.ts).

export const transcodeApi = {
  rules: {
    list: () => request('/transcoderule', TranscodeRule.array()),
    create: (body: TranscodeRuleInputRaw) => request('/transcoderule', TranscodeRule, { method: 'POST', json: body }),
    update: (id: number, body: TranscodeRuleInputRaw) => request(`/transcoderule/${id}`, TranscodeRule, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/transcoderule/${id}`, null, { method: 'DELETE' }),
  },
  jobs: (query: TranscodeJobsQuery = {}) => request('/transcode/jobs', TranscodeJob.array(), { query: { status: query.status } }),
  run: (body: TranscodeRunRequest) => request('/transcode/run', TranscodeRunResult, { method: 'POST', json: body }),
  cancel: (id: number) => request(`/transcode/jobs/${id}/cancel`, TranscodeJob, { method: 'POST' }),
  /** Capability test results (cached by the server); `refresh` runs the tests again. */
  hwaccel: (refresh = false) => request('/transcode/hwaccel', TranscodeHwaccelResponse, refresh ? { query: { refresh: 'true' } } : {}),
  settings: {
    get: () => request('/settings/transcode', TranscodeSettings),
    save: (body: TranscodeSettings) => request('/settings/transcode', TranscodeSettings, { method: 'PUT', json: body }),
  },
};
