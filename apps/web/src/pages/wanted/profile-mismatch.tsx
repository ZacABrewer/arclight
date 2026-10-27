import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ProfileFileStatus, ProfileMismatchRecord } from '@arclight/shared';
import { Button, EmptyState, Pane, Paginator, Segmented, Table, type Column } from '../../arclight/index.js';
import { Loading, QueryError, useIsMobile } from '../../components/media/media-kit.js';
import { replacementText } from '../../components/media/pipeline-status.js';
import { fitReasonLabel, ProfileFitChip, queueStateLabel } from '../../components/media/profile-fit.js';
import { useAutomaticSearch } from '../../hooks/library.js';
import { useProfileMismatch } from '../../hooks/profile-migration.js';
import { relativeTime } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 50;

/**
 * Whether the file will be replaced and when (first line), then what the work list did so far:
 * its state, searches out of the maximum and the last message.
 */
function ReplacementLines({ record, compact }: { record: ProfileMismatchRecord; compact?: boolean }) {
  const m = record.migration;
  const max = record.replacement?.maxAttempts;
  const progress = m
    ? [
        queueStateLabel(m.state),
        m.attempts > 0 && max ? t('profileMigration.wanted.attempts', { attempts: m.attempts, max }) : null,
        m.lastSearchedAt ? t('profileMigration.wanted.lastSearched', { when: relativeTime(m.lastSearchedAt) }) : null,
        m.message,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  return (
    <span className="mk-search-status" data-compact={compact || undefined} data-testid="replacement">
      <span data-state={record.replacement?.state}>{replacementText(record)}</span>
      {progress ? <span>{progress}</span> : null}
    </span>
  );
}

type StatusFilter = 'notAllowed' | 'upgradeAllowed' | 'both';

const STATUS_FILTERS: Record<StatusFilter, ProfileFileStatus[]> = {
  notAllowed: ['notAllowed'],
  upgradeAllowed: ['upgradeAllowed'],
  both: ['notAllowed', 'upgradeAllowed'],
};

/**
 * Wanted -> Profile mismatch: files that do not meet the profile governing them (one row per
 * file), with what the profile migration is doing about each.
 */
export function ProfileMismatchList({ kind }: { kind: 'episodes' | 'movies' }) {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<StatusFilter>('notAllowed');
  const query = { page, pageSize: PAGE_SIZE, mediaType: kind === 'episodes' ? ('series' as const) : ('movie' as const), status: STATUS_FILTERS[filter] };
  const list = useProfileMismatch(query);
  const search = useAutomaticSearch();
  const mobile = useIsMobile();

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} title={t('profileMigration.wanted.couldNotLoad')} />;
  const rows = list.data?.records;
  const pages = Math.max(1, Math.ceil((list.data?.totalRecords ?? 0) / PAGE_SIZE));
  const label = (r: ProfileMismatchRecord) => (r.episodeLabel ? `${r.title} ${r.episodeLabel}` : r.title);
  const searchRow = (r: ProfileMismatchRecord) =>
    search.mutate(r.mediaType === 'movie' && r.movieId !== null ? { movieId: r.movieId } : { episodeIds: r.episodeIds });

  const columns: Column<ProfileMismatchRecord>[] = [
    {
      key: 'title',
      header: t('common.title'),
      cell: (r) =>
        r.mediaType === 'movie' && r.movieId !== null ? (
          <Link className="mk-link" to="/library/movie/$id" params={{ id: String(r.movieId) }}>
            {r.title}
          </Link>
        ) : (
          <Link className="mk-link" to="/library/series/$id" params={{ id: String(r.seriesId ?? 0) }}>
            {r.title}
          </Link>
        ),
    },
    ...(kind === 'episodes' ? [{ key: 'episode', header: t('common.episode'), mono: true, width: '110px', cell: (r: ProfileMismatchRecord) => r.episodeLabel ?? '—' }] : []),
    { key: 'profile', header: t('common.profile'), muted: true, cell: (r) => (r.versionTag ? `${r.qualityProfileName} · ${r.versionTag}` : r.qualityProfileName) },
    { key: 'quality', header: t('common.quality'), mono: true, cell: (r) => r.quality },
    { key: 'score', header: t('common.score'), mono: true, align: 'right', width: '72px', cell: (r) => r.formatScore },
    {
      key: 'status',
      header: t('common.status'),
      width: '190px',
      cell: (r) => (
        <span title={r.reasons.map(fitReasonLabel).join(', ')}>
          <ProfileFitChip status={r.status} />
        </span>
      ),
    },
    {
      key: 'migration',
      header: t('profileMigration.wanted.replacement'),
      cell: (r) => <ReplacementLines record={r} />,
    },
    {
      key: 'search',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      width: '96px',
      cell: (r) => (
        <Button size="sm" aria-label={t('wanted.searchLabel', { label: label(r) })} onClick={() => searchRow(r)}>
          {t('common.search')}
        </Button>
      ),
    },
  ];

  const noun = kind === 'episodes' ? t('common.episodes') : t('common.movies');
  const empty = (
    <EmptyState title={t('profileMigration.wanted.emptyTitle')}>{t('profileMigration.wanted.emptyBody')}</EmptyState>
  );

  return (
    <Pane
      flush
      title={list.data ? `${list.data.totalRecords} ${noun}` : noun}
      actions={
        <Segmented
          aria-label={t('profileMigration.wanted.statusFilter')}
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setPage(1);
          }}
          options={[
            { value: 'notAllowed', label: t('profileMigration.status.notAllowed') },
            { value: 'upgradeAllowed', label: t('profileMigration.status.upgradeAllowed') },
            { value: 'both', label: t('profileMigration.wanted.both') },
          ]}
        />
      }
    >
      {mobile ? (
        list.isPending ? (
          <Loading />
        ) : (rows ?? []).length === 0 ? (
          empty
        ) : (
          <div className="mk-mlist" role="list" aria-label={t('profileMigration.wanted.title')}>
            {(rows ?? []).map((r) => (
              <div key={r.mediaFileId} className="mk-mrow" role="listitem">
                <div style={{ minWidth: 0 }}>
                  <div className="mk-mrow__title">{label(r)}</div>
                  <div className="mk-mrow__sub al-num">{`${r.quality} · ${r.qualityProfileName}`}</div>
                  <ReplacementLines record={r} compact />
                </div>
                <ProfileFitChip status={r.status} />
              </div>
            ))}
          </div>
        )
      ) : (
        <Table
          columns={columns}
          rows={rows}
          loading={list.isPending}
          rowKey={(r) => r.mediaFileId}
          density="rich"
          sortable={false}
          empty={empty}
          caption={t('profileMigration.wanted.title')}
        />
      )}
      {pages > 1 ? (
        <div className="wanted-foot">
          <Paginator page={page} pageCount={pages} onPageChange={setPage} />
        </div>
      ) : null}
    </Pane>
  );
}
