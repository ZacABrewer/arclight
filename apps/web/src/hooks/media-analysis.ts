import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalyzeCommand, AnalyzeResult } from '@arclight/shared';
import { mediaAnalysisApi } from '../api/media-analysis.js';
import { useToast } from '../components/toast.js';
import { t } from '../i18n/index.js';

export const mediaAnalysisKeys = {
  queue: ['mediaanalysis', 'queue'] as const,
};

/** Queue counts for System → Tasks; polls while files are pending or running. */
export function useAnalysisQueue() {
  return useQuery({
    queryKey: mediaAnalysisKeys.queue,
    queryFn: mediaAnalysisApi.queue,
    retry: false,
    refetchInterval: (q) => (q.state.data && q.state.data.pending + q.state.data.running > 0 ? 5_000 : 60_000),
  });
}

/** "Analyzing 4 files." or the ffprobe warning. */
export function analyzeToast(result: AnalyzeResult): { tone: 'ok' | 'warning'; title: string; message?: string } {
  if (!result.ffprobeAvailable) {
    return { tone: 'warning', title: t('hooks.mediaAnalysis.ffprobeNotFound'), message: t('hooks.mediaAnalysis.filesStayQueuedUntilFfprobe', { queued: result.queued }) };
  }
  if (result.queued === 0) return { tone: 'ok', title: t('hooks.mediaAnalysis.nothingToAnalyze'), message: t('hooks.mediaAnalysis.everyFileAlreadyHasMedia') };
  return { tone: 'ok', title: t('hooks.mediaAnalysis.analyzingFiles', { queued: result.queued }), message: t('hooks.mediaAnalysis.mediaInfoUpdatesAsEach') };
}

/** POST /command/analyze for one series or movie; the result is reported as a toast. */
export function useAnalyzeMedia() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: AnalyzeCommand) => mediaAnalysisApi.analyze(body),
    meta: { errorTitle: t('hooks.mediaAnalysis.couldNotStartAnalysis') },
    onSuccess: (result) => {
      toast.push({ ...analyzeToast(result), durationMs: 5_000 });
      void qc.invalidateQueries({ queryKey: mediaAnalysisKeys.queue });
    },
  });
}
