import type { SceneMappingFeedStatus } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, Chip, ErrorBlock, KeyValue, Pane, Skeleton, type ChipTone } from '../../arclight/index.js';
import { useSceneMappingFeed, useSyncSceneMappingFeed } from '../../hooks/scene-mapping.js';
import { relativeTime } from '../../lib/format.js';
import { formatStamp } from './format.js';
import { t } from '../../i18n/index.js';

/** The feed's own state line: a 404 feed is "not published yet" (info), never an error. */
export function sceneFeedState(s: Pick<SceneMappingFeedStatus, 'notPublished' | 'lastError' | 'lastSuccessAt' | 'lastSyncAt'>): { label: string; tone: ChipTone } {
  if (s.notPublished) return { label: t('system.sceneMappingFeed.notPublished'), tone: 'neutral' };
  if (s.lastError) return { label: `${t('status.failed')} · ${s.lastError}`, tone: 'danger' };
  if (s.lastSuccessAt) return { label: t('common.upToDate'), tone: 'accent' };
  return { label: t('system.feeds.notSyncedYet'), tone: 'neutral' };
}

function when(iso: string | null) {
  return iso ? (
    <time dateTime={iso} title={formatStamp(iso)}>
      {relativeTime(iso)}
    </time>
  ) : (
    t('system.feeds.never')
  );
}

/** System → Feeds: the community scene-mapping feed (`sceneMappings`) with a manual sync. */
export function SceneMappingFeedPane() {
  const feed = useSceneMappingFeed();
  const sync = useSyncSceneMappingFeed();
  // The scene-mapping module is optional; without it the endpoint answers 404 and the pane stays out.
  if (feed.error instanceof ApiError && feed.error.status === 404) return null;
  const title = t('system.sceneMappingFeed.title');
  return (
    <Pane
      title={title}
      aria-label={title}
      actions={
        <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate(undefined)}>
          {t('common.syncNow')}
        </Button>
      }
    >
      {feed.isError ? (
        <ErrorBlock title={t('system.sceneMappingFeed.couldntLoad')} onRetry={() => void feed.refetch()}>
          {errorMessage(feed.error)}
        </ErrorBlock>
      ) : feed.isPending ? (
        <Skeleton lines={3} />
      ) : (
        <SceneMappingFeedStatusView status={feed.data} />
      )}
    </Pane>
  );
}

export function SceneMappingFeedStatusView({ status }: { status: SceneMappingFeedStatus }) {
  const state = sceneFeedState(status);
  return (
    <KeyValue
      layout="grid"
      columns={2}
      items={[
        { label: t('common.state'), value: <Chip tone={state.tone}>{state.label}</Chip>, mono: false },
        { label: t('common.url'), value: <span style={{ overflowWrap: 'anywhere' }}>{status.url}</span> },
        { label: t('common.lastSync'), value: when(status.lastSyncAt) },
        { label: t('common.lastSuccess'), value: when(status.lastSuccessAt) },
        { label: t('system.sceneMappingFeed.seriesInFeed'), value: String(status.feedSeries) },
        { label: t('system.sceneMappingFeed.matchedSeries'), value: String(status.matchedSeries) },
        { label: t('system.sceneMappingFeed.rulesStored'), value: String(status.mappings) },
        { label: t('system.sceneMappingFeed.rulesRejected'), value: String(status.rejected) },
      ]}
    />
  );
}
