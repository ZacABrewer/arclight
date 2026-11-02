import type { BooksKind, BooksRelease } from '@arclight/shared';
import { Chip, EmptyState, Modal, ProtocolBadge, RejectionList, StatusChip, Table, Tooltip, type Column } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, QueryError } from '../../../components/media/media-kit.js';
import { useBooksReleases, useGrabBooksRelease } from '../../../hooks/books.js';
import { BooksGrabButton, FormatBadge } from './books-kit.js';
import { releaseAgeDays, sortReleases } from './books-model.js';
import { t } from '../../../i18n/index.js';

export interface BooksReleaseTarget {
  kind: BooksKind;
  id: number;
  title: string;
}

function ageText(r: BooksRelease): string {
  const days = releaseAgeDays(r.publishDate);
  return days === null ? '—' : t('books.releases.ageDays', { count: days });
}

/** Interactive search results for one ebook or comic issue: title, indexer, size, format, peers, age, decision, grab. */
export function BooksReleaseTable({ target }: { target: BooksReleaseTarget }) {
  const releases = useBooksReleases(target.kind, target.id, true);
  const grab = useGrabBooksRelease();

  const columns: Column<BooksRelease>[] = [
    { key: 'protocol', header: t('common.source'), sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} />, width: '64px' },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.title,
      cell: (r) => (
        <span className="mk-release-title" title={r.title}>
          {r.title}
        </span>
      ),
    },
    { key: 'indexer', header: t('common.indexer'), sortValue: (r) => r.indexer, cell: (r) => r.indexer, muted: true },
    { key: 'size', header: t('common.size'), sortValue: (r) => r.sizeBytes, cell: (r) => formatBytes(r.sizeBytes), mono: true, align: 'right' },
    { key: 'format', header: t('books.format'), sortValue: (r) => r.format ?? '', cell: (r) => (r.format ? <FormatBadge format={r.format} /> : '—') },
    {
      key: 'seeders',
      header: t('books.releases.seeders'),
      sortValue: (r) => r.seeders ?? -1,
      cell: (r) => (r.protocol === 'torrent' ? (r.seeders ?? '?') : '—'),
      mono: true,
      align: 'right',
    },
    { key: 'age', header: t('library.interactiveSearch.age'), sortValue: (r) => -(Date.parse(r.publishDate) || 0), cell: ageText, mono: true, align: 'right' },
    {
      key: 'decision',
      header: t('library.interactiveSearch.decision'),
      sortValue: (r) => (r.approved ? 0 : 1),
      cell: (r) =>
        r.approved ? (
          <Chip tone="accent">{t('common.approved')}</Chip>
        ) : (
          <Tooltip content={<RejectionList reasons={r.rejections} />}>
            <button type="button" className="mk-action-link" aria-label={t('books.releases.rejectionsAria', { count: r.rejections.length, reasons: r.rejections.join('; ') })}>
              <StatusChip status="missing" label={t('library.interactiveSearch.rejections', { rejectionsCount: r.rejections.length })} />
            </button>
          </Tooltip>
        ),
    },
    {
      key: 'grab',
      header: <span className="al-sr-only">{t('library.interactiveSearch.grab')}</span>,
      label: t('library.interactiveSearch.grab'),
      mobile: 'end',
      align: 'right',
      cell: (r) => (
        <BooksGrabButton
          release={r}
          loading={grab.isPending && grab.variables?.guid === r.guid}
          onGrab={(force) => grab.mutateAsync({ kind: target.kind, id: target.id, indexerId: r.indexerId, guid: r.guid, force })}
        />
      ),
    },
  ];

  if (releases.isPending && releases.fetchStatus !== 'idle') return <Loading label={t('library.interactiveSearch.searchingIndexers')} />;
  if (releases.isError) return <QueryError error={releases.error} onRetry={() => void releases.refetch()} title={t('common.searchFailed')} />;
  return (
    <Table
      className="bk-releases"
      columns={columns}
      rows={sortReleases(releases.data ?? [])}
      rowKey={(r) => `${r.indexerId}-${r.guid}`}
      maxHeight="62vh"
      empty={<EmptyState title={t('library.interactiveSearch.noReleasesFound')}>{t('library.interactiveSearch.everyEnabledIndexerWasSearched')}</EmptyState>}
      caption={t('library.interactiveSearch.releases')}
    />
  );
}

/** Interactive search modal for one ebook or comic issue. */
export function BooksReleaseModal({ target, onClose }: { target: BooksReleaseTarget | null; onClose: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title={t('library.interactiveSearch.interactiveSearchTitle', { title: target?.title ?? '' })} size={1100}>
      {target ? <BooksReleaseTable target={target} /> : null}
    </Modal>
  );
}
