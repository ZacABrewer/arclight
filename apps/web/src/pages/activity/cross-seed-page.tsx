import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CrossSeedResource, CrossSeedState } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, PageHeader, Pane, Segmented, Table, type Column } from '../../arclight/index.js';
import { ListSearchBar, ListSearchEmpty, useClientListSearch } from '../../components/list-search.js';
import { crossSeedKeys, useCrossSeeds } from '../../hooks/cross-seed.js';
import { useDownloadClientList } from '../../hooks/download-clients.js';
import { formatDateTime, formatSize, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { useDocumentTitle } from './activity-shared.js';
import './activity.css';
import { t } from '../../i18n/index.js';

// Activity -> Cross-seeds: GET /crossseed with a state filter. Each row is one torrent seeded
// from a library file (or a failed attempt with its message).

export type CrossSeedFilter = 'all' | CrossSeedState;

export function crossSeedStateLabel(state: CrossSeedState): string {
  return state === 'seeding' ? t('activity.crossSeed.seeding') : t('status.failed');
}

/** Seeding = accent chip, failed = danger chip. */
export function CrossSeedStateChip({ state }: { state: CrossSeedState }) {
  return <Chip tone={state === 'seeding' ? 'accent' : 'danger'}>{crossSeedStateLabel(state)}</Chip>;
}

export function CrossSeedActivityPage() {
  useDocumentTitle(t('nav.crossSeeds'));
  const [filter, setFilter] = useState<CrossSeedFilter>('all');
  const list = useCrossSeeds(filter === 'all' ? undefined : filter);
  const clients = useDownloadClientList();
  const qc = useQueryClient();
  const clientName = (id: number | null) => (id === null ? '—' : (clients.data?.find((c) => c.id === id)?.name ?? `#${id}`));
  const pending = list.error instanceof ApiError && list.error.status === 404;
  // Search: release title, info-hash, indexer, client, save path, state and the failure message.
  const search = useClientListSearch(list.data, (r) => [
    r.title,
    r.infoHash,
    r.indexerName,
    clientName(r.downloadClientId),
    r.savePath,
    crossSeedStateLabel(r.state),
    r.message,
  ]);

  const columns: Column<CrossSeedResource>[] = [
    { key: 'title', header: t('common.title'), sortValue: (r) => r.title, cell: (r) => <span className="al-activity-break">{r.title}</span> },
    { key: 'state', header: t('common.state'), sortValue: (r) => r.state, cell: (r) => <CrossSeedStateChip state={r.state} /> },
    { key: 'hash', header: t('activity.crossSeed.infoHash'), mono: true, cell: (r) => <span className="al-activity-break">{r.infoHash}</span> },
    { key: 'indexer', header: t('common.indexer'), muted: true, sortValue: (r) => r.indexerName ?? '', cell: (r) => r.indexerName ?? '—' },
    { key: 'client', header: t('activity.crossSeed.client'), muted: true, cell: (r) => clientName(r.downloadClientId) },
    { key: 'savePath', header: t('activity.crossSeed.savePath'), mono: true, cell: (r) => <span className="al-activity-break">{r.savePath ?? '—'}</span> },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', sortValue: (r) => r.size, cell: (r) => formatSize(r.size) },
    { key: 'message', header: t('activity.crossSeed.message'), muted: true, cell: (r) => r.message ?? '' },
    {
      key: 'added',
      header: t('common.added'),
      mono: true,
      align: 'right',
      sortValue: (r) => r.addedAt,
      cell: (r) => (
        <time dateTime={r.addedAt} title={formatDateTime(r.addedAt)}>
          {relativeTime(r.addedAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title={t('nav.crossSeeds')}
        actions={
          <Button variant="secondary" onClick={() => void qc.invalidateQueries({ queryKey: crossSeedKeys.all })}>
            {t('common.refresh')}
          </Button>
        }
      >
        <Segmented
          variant="soft"
          aria-label={t('activity.crossSeed.stateFilter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'seeding', label: t('activity.crossSeed.seeding') },
            { value: 'failed', label: t('status.failed') },
          ]}
        />
      </PageHeader>
      <Pane flush bare className="al-activity-pane">
        <div className="al-activity-filters">
          <ListSearchBar value={search.q} onChange={search.setQ} placeholder={t('listSearch.ph.releases')} shown={search.shown} total={search.total} />
        </div>
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what={t('nav.crossSeeds')} />
          </div>
        ) : list.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.crossSeed.couldNotLoad')} onRetry={() => void list.refetch()}>
              {errorMessage(list.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption={t('nav.crossSeeds')}
            columns={columns}
            rows={search.rows}
            rowKey={(r) => r.id}
            loading={list.isPending}
            density="rich"
            defaultSort={{ key: 'added', direction: 'desc' }}
            empty={
              search.active ? (
                <ListSearchEmpty query={search.q} onClear={search.clear} />
              ) : (
                <EmptyState title={t('activity.crossSeed.empty')}>{t('activity.crossSeed.emptyBody')}</EmptyState>
              )
            }
          />
        )}
      </Pane>
    </div>
  );
}
