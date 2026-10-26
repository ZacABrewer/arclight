import { Link } from '@tanstack/react-router';
import type { FeedState, FeedSummary } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Chip, EmptyState, ErrorBlock, Pane, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useFeeds } from '../../hooks/guides.js';
import { relativeTime } from '../../lib/format.js';
import { formatSpan, formatStamp } from './format.js';
import { SceneMappingFeedPane } from './scene-mapping-feed.js';
import { SystemHeader } from './system-header.js';
import type { AppPath } from '../../router.js';
import './feeds.css';
import { t } from '../../i18n/index.js';

export const FEED_STATE: Record<FeedState, { label: string; tone: ChipTone }> = {
  ok: { get label() { return t('common.upToDate'); }, tone: 'accent' },
  stale: { get label() { return t('system.feeds.stale'); }, tone: 'warn' },
  error: { get label() { return t('status.failed'); }, tone: 'danger' },
  never: { get label() { return t('system.feeds.notSyncedYet'); }, tone: 'neutral' },
  disabled: { get label() { return t('common.off'); }, tone: 'muted' },
  unregistered: { get label() { return t('system.feeds.notAvailable'); }, tone: 'muted' },
};

/** Where each feed is configured. */
export const FEED_SETTINGS: Partial<Record<string, AppPath>> = {
  guides: '/settings/guides',
  definitions: '/settings/indexeroptions',
  communityDefinitions: '/settings/indexercatalogue',
  updates: '/settings/updates',
};

/** Health docs anchor for the FeedStale check (rendered as /docs/system/health#feed-stale). */
export const FEED_STALE_DOCS = { to: '/docs/system/health', hash: 'feed-stale' } as const;

/** Chip text: failures carry their cause ("Failed · 502 from upstream"). */
export function feedStateLabel(feed: Pick<FeedSummary, 'state' | 'lastError'>): string {
  const base = FEED_STATE[feed.state].label;
  return feed.state === 'error' && feed.lastError ? `${base} · ${feed.lastError}` : base;
}

/** "every 12 h", "on demand". */
export function feedInterval(ms: number | null): string {
  return ms === null ? 'on demand' : `every ${formatSpan(ms)}`;
}

/** Feeds that need attention first, then by name. */
export function sortFeeds(feeds: readonly FeedSummary[]): FeedSummary[] {
  const rank: Record<FeedState, number> = { stale: 0, error: 1, never: 2, ok: 3, disabled: 4, unregistered: 5 };
  return [...feeds].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="sys-muted">{t('system.feeds.never')}</span>;
  return (
    <time dateTime={iso} title={formatStamp(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

const columns: Column<FeedSummary>[] = [
  {
    key: 'name',
    get header() {
      return t('common.feed');
    },
    cell: (f) => {
      const to = FEED_SETTINGS[f.id];
      return (
        <span className="sys-feed__name">
          {to ? (
            <Link to={to} className="al-link">
              {f.name}
            </Link>
          ) : (
            f.name
          )}
          {f.detail ? <span className="al-caption">{f.detail}</span> : null}
        </span>
      );
    },
  },
  {
    key: 'state',
    get header() {
      return t('common.state');
    },
    cell: (f) => (
      <span className="sys-feed__state">
        <Chip tone={FEED_STATE[f.state].tone}>{feedStateLabel(f)}</Chip>
        {f.state === 'stale' ? (
          <Link {...FEED_STALE_DOCS} className="al-link" aria-label={t('system.feeds.whyNameIsStale', { name: f.name })}>
            {t('common.fix')}
          </Link>
        ) : null}
      </span>
    ),
  },
  { key: 'interval', get header() { return t('common.interval'); }, mono: true, muted: true, cell: (f) => feedInterval(f.intervalMs) },
  { key: 'lastSync', get header() { return t('common.lastSync'); }, mono: true, cell: (f) => <When iso={f.lastSyncAt} /> },
  { key: 'lastSuccess', get header() { return t('common.lastSuccess'); }, mono: true, cell: (f) => <When iso={f.lastSuccessAt} /> },
  { key: 'pending', get header() { return t('common.pending'); }, mono: true, align: 'right', cell: (f) => (f.pending === null ? '—' : String(f.pending)) },
];

/** System → Feeds (/system/feeds): the self-updating data feeds with stale markers. */
export function SystemFeedsPage() {
  const feeds = useFeeds();
  const rows = feeds.data ? sortFeeds(feeds.data.feeds) : undefined;
  const stale = rows?.filter((f) => f.state === 'stale').length ?? 0;
  return (
    <>
      <SystemHeader
        title={t('common.feeds')}
        subtitle={
          stale ? (
            <span className="sys-feed__warn">
              {t('system.feeds.feedsHaveNotSyncedFor', { stale })}
              <Link {...FEED_STALE_DOCS} className="al-link">
                {t('system.feeds.whatToDo')}
              </Link>
            </span>
          ) : undefined
        }
      />
      <Pane title={t('system.feeds.dataFeeds')} flush aria-label={t('system.feeds.dataFeeds')}>
        {feeds.isError ? (
          <ErrorBlock title={t('system.feeds.couldntLoadTheFeeds')} onRetry={() => void feeds.refetch()}>
            {errorMessage(feeds.error)}
          </ErrorBlock>
        ) : (
          <Table caption={t('system.feeds.dataFeeds')} columns={columns} rows={rows} rowKey={(f) => f.id} loading={feeds.isPending} empty={<EmptyState title={t('system.feeds.noFeedsRegistered')} />} />
        )}
      </Pane>
      <div style={{ marginTop: 20 }}>
        <SceneMappingFeedPane />
      </div>
    </>
  );
}
