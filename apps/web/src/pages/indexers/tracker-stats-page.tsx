import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { TrackerStatsResource } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, KeyValue, PageHeader, Pane, Skeleton, type KeyValueItem } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useSyncTrackerStats, useTrackerStats } from '../../hooks/tracker-stats.js';
import { formatDateTime, formatSize } from '../../lib/format.js';
import { formatBuffer, formatRatio, hnrRuleText, formatSeedTime, ratioStatusChip, sortTrackers, trackerWarnings } from './tracker-stats-model.js';
import './stats.css';
import { t } from '../../i18n/index.js';

// Indexers -> Tracker stats: one pane per private-tracker account with this client's totals
// (built-in engine) and the values read from the tracker's account page.

const orDash = (v: number | null, f: (n: number) => string) => (v === null ? '—' : f(v));

function TrackerPane({ s }: { s: TrackerStatsResource }) {
  const chip = ratioStatusChip(s.ratioStatus);
  const warnings = trackerWarnings(s);
  const required = s.account.ratioRequired;
  const client: KeyValueItem[] = [
    { label: t('indexers.trackerStats.ratio'), value: required !== undefined ? `${formatRatio(s.ratio)} / ${formatRatio(required)}` : formatRatio(s.ratio) },
    { label: t('indexers.trackerStats.buffer'), value: formatBuffer(s.buffer) },
    { label: t('indexers.trackerStats.uploaded'), value: formatSize(s.uploaded) },
    { label: t('indexers.trackerStats.downloaded'), value: formatSize(s.downloaded) },
    { label: t('indexers.trackerStats.seeding'), value: t('indexers.trackerStats.seedingOfTorrents', { seeding: s.seeding, torrents: s.torrents }) },
    { label: t('indexers.trackerStats.seedTime'), value: formatSeedTime(s.seedingTimeMs) },
    { label: t('indexers.trackerStats.hnrPending'), value: String(s.hnrPending) },
    {
      label: t('indexers.trackerStats.hnrRule'),
      value: hnrRuleText(s.account.hnrRule),
    },
  ];
  const account: KeyValueItem[] = [
    { label: t('indexers.trackerStats.ratio'), value: orDash(s.accountRatio, (n) => n.toFixed(2)) },
    { label: t('indexers.trackerStats.uploaded'), value: orDash(s.accountUploaded, formatSize) },
    { label: t('indexers.trackerStats.downloaded'), value: orDash(s.accountDownloaded, formatSize) },
    { label: t('indexers.trackerStats.buffer'), value: orDash(s.accountBuffer, (n) => formatBuffer(n)) },
    { label: t('indexers.trackerStats.hnrCount'), value: orDash(s.accountHnrCount, String) },
    { label: t('indexers.trackerStats.seedBonus'), value: orDash(s.accountSeedBonus, (n) => n.toLocaleString()) },
    { label: t('indexers.trackerStats.updated'), value: s.accountUpdatedAt ? formatDateTime(s.accountUpdatedAt) : '—' },
  ];
  return (
    <Pane
      title={s.indexerName}
      aria-label={s.indexerName}
      actions={
        <Chip tone={chip.tone} title={t('indexers.trackerStats.ratioStatus')}>
          {chip.label}
        </Chip>
      }
    >
      <div className="mt-tracker">
        {warnings.length > 0 ? (
          <ul className="mt-tracker__warnings" aria-label={t('indexers.trackerStats.warnings')}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {!s.account.enabled ? <p className="al-caption">{t('indexers.trackerStats.accountDisabled')}</p> : null}
        <section aria-label={t('indexers.trackerStats.thisClient')}>
          <h3 className="al-label mt-tracker__head">{t('indexers.trackerStats.thisClient')}</h3>
          <KeyValue layout="grid" columns={4} items={client} />
          {s.engineUpdatedAt ? <p className="al-caption">{t('indexers.trackerStats.updatedAt', { time: formatDateTime(s.engineUpdatedAt) })}</p> : null}
        </section>
        <section aria-label={t('indexers.trackerStats.accountPage')}>
          <h3 className="al-label mt-tracker__head">{t('indexers.trackerStats.accountPage')}</h3>
          {s.accountUpdatedAt || s.accountError ? (
            <KeyValue layout="grid" columns={4} items={account} />
          ) : (
            <p className="al-caption">{t('indexers.trackerStats.accountNotRead')}</p>
          )}
        </section>
        {s.hosts.length > 0 ? <p className="al-caption mt-tracker__hosts">{t('indexers.trackerStats.hosts', { hosts: s.hosts.join(', ') })}</p> : null}
      </div>
    </Pane>
  );
}

/** Indexers -> Tracker stats. */
export function TrackerStatsPage() {
  const stats = useTrackerStats();
  const sync = useSyncTrackerStats();
  const toast = useToast();

  useEffect(() => {
    document.title = t('indexers.stats.titleArclight', { title: t('indexers.trackerStats.title') });
  }, []);

  return (
    <>
      <PageHeader index="08" title={t('indexers.trackerStats.title')}>
        <Button
          variant="secondary"
          loading={sync.isPending}
          onClick={() => sync.mutate(undefined, { onSuccess: (r) => toast.push({ tone: 'ok', title: t('indexers.trackerStats.synced'), message: r.message }) })}
        >
          {t('indexers.trackerStats.syncNow')}
        </Button>
      </PageHeader>
      {stats.isPending ? (
        <Pane>
          <Skeleton lines={4} />
        </Pane>
      ) : stats.isError ? (
        <ErrorBlock title={t('indexers.trackerStats.couldntLoad')} onRetry={() => void stats.refetch()}>
          {errorMessage(stats.error)}
        </ErrorBlock>
      ) : stats.data.length === 0 ? (
        <EmptyState title={t('indexers.trackerStats.empty')}>
          {t('indexers.trackerStats.emptyHint')}{' '}
          <Link to="/settings/indexers">{t('indexers.trackerStats.openIndexers')}</Link>
        </EmptyState>
      ) : (
        <div className="mt-trackers" role="list" aria-label={t('indexers.trackerStats.trackers')}>
          {sortTrackers(stats.data).map((s) => (
            <div role="listitem" key={s.indexerId}>
              <TrackerPane s={s} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
