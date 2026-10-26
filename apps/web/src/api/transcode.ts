import {
  TranscodeHwaccelResponse,
  TranscodeJob,
  TranscodeRule,
  TranscodeRunResult,
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
  hwaccel: () => request('/transcode/hwaccel', TranscodeHwaccelResponse),
};
