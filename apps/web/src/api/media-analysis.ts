import { AnalyzeResult, MediaAnalysisQueueSummary, type AnalyzeCommand } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md "media-analysis" (contract: packages/shared/src/media-analysis.ts).

export const mediaAnalysisApi = {
  analyze: (body: AnalyzeCommand) => request('/command/analyze', AnalyzeResult, { method: 'POST', json: body }),
  queue: () => request('/mediaanalysis/queue', MediaAnalysisQueueSummary),
};
