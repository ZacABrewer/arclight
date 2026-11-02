import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BooksWantedItem } from '@arclight/shared';
import { Button, EmptyState, PageHeader, Paginator, Segmented, Table, Tabs, type Column, type RowKey } from '../../../arclight/index.js';
import { formatDate } from '../../../components/media/format.js';
import { QueryError } from '../../../components/media/media-kit.js';
import { useBooksCommand, useBooksWanted } from '../../../hooks/books.js';
import { BooksCrumb, BooksGate, BooksKindChip, BooksSearchButton, CoverArt, comicSeriesLink, ebookAuthorLink } from './books-kit.js';
import { wantedKey, wantedSearchCommands } from './books-model.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

type Reason = 'missing' | 'cutoff';
type KindFilter = 'all' | 'ebook' | 'comic';
const PAGE_SIZE = 50;

export function BooksWantedPage() {
  return (
    <BooksGate>
      <WantedView />
    </BooksGate>
  );
}

function WantedView() {
  const [reason, setReason] = useState<Reason>('missing');
  const command = useBooksCommand();
  return (
    <div className="lib-page">
      <PageHeader
        title={t('books.wanted.title')}
        subtitle={<BooksCrumb />}
        actions={
          <Button variant="primary" loading={command.isPending && command.variables.name === 'BooksMissingSearch'} onClick={() => command.mutate({ name: 'BooksMissingSearch', kind: 'all' })}>
            {t('books.wanted.searchAll')}
          </Button>
        }
      />
      <Tabs
        value={reason}
        onChange={(v) => setReason(v as Reason)}
        tabs={[
          { id: 'missing', label: t('books.wanted.missing'), content: reason === 'missing' ? <WantedList reason="missing" /> : null },
          { id: 'cutoff', label: t('books.wanted.cutoff'), content: reason === 'cutoff' ? <WantedList reason="cutoff" /> : null },
        ]}
      />
    </div>
  );
}

function WantedList({ reason }: { reason: Reason }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const wanted = useBooksWanted({ kind, reason, page, pageSize: PAGE_SIZE });
  const command = useBooksCommand();
  const rows = wanted.data?.records ?? [];
  const pages = wanted.data ? Math.ceil(wanted.data.totalRecords / PAGE_SIZE) : 1;
  const chosen = rows.filter((r) => selected.has(wantedKey(r)));

  const columns: Column<BooksWantedItem>[] = [
    {
      key: 'title',
      header: t('common.title'),
      mobile: 'primary',
      cell: (r) => (
        <span className="bk-book-row">
          <CoverArt src={r.coverUrl} title={r.title} className="bk-book-row__cover" />
          <span>{r.title}</span>
        </span>
      ),
    },
    {
      key: 'parent',
      header: t('books.wanted.parent'),
      cell: (r) => (
        <Link {...(r.kind === 'ebook' ? ebookAuthorLink({ id: r.parentId }) : comicSeriesLink({ id: r.parentId }))} className="mk-link">
          {r.parentTitle}
        </Link>
      ),
    },
    { key: 'kind', header: t('books.kindLabel'), cell: (r) => <BooksKindChip kind={r.kind} />, width: '96px' },
    { key: 'release', header: t('books.releaseDate'), cell: (r) => (r.releaseDate ? formatDate(r.releaseDate) : '—'), mono: true, width: '120px' },
    { key: 'searched', header: t('books.lastSearched'), cell: (r) => (r.lastSearchedAt ? formatDate(r.lastSearchedAt) : t('books.never')), mono: true, muted: true, width: '120px' },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      mobile: 'end',
      align: 'right',
      cell: (r) => <BooksSearchButton kind={r.kind} id={r.id} variant="ghost" label={t('books.searchFor', { title: r.title })} />,
    },
  ];

  return (
    <div className="mk-stack-sm">
      <div className="mk-row">
        <Segmented
          aria-label={t('books.kindLabel')}
          variant="soft"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPage(1);
            setSelected(new Set());
          }}
          options={[
            { value: 'all' as const, label: t('common.all') },
            { value: 'ebook' as const, label: t('books.kind.ebooks') },
            { value: 'comic' as const, label: t('books.kind.comics') },
          ]}
        />
        <span className="mk-spacer" />
        <Button
          disabled={chosen.length === 0}
          loading={command.isPending && command.variables.name !== 'BooksMissingSearch'}
          onClick={() => {
            for (const c of wantedSearchCommands(chosen)) command.mutate(c);
            setSelected(new Set());
          }}
        >
          {t('books.wanted.searchSelected', { count: chosen.length })}
        </Button>
        {kind !== 'all' ? (
          <Button variant="ghost" onClick={() => command.mutate({ name: 'BooksMissingSearch', kind })}>
            {kind === 'ebook' ? t('books.wanted.searchAllEbooks') : t('books.wanted.searchAllComics')}
          </Button>
        ) : null}
      </div>
      {wanted.isError ? (
        <QueryError error={wanted.error} onRetry={() => void wanted.refetch()} title={t('books.couldNotLoad')} />
      ) : (
        <Table
          columns={columns}
          rows={rows}
          loading={wanted.isPending}
          rowKey={wantedKey}
          sortable={false}
          selectable
          selected={selected}
          onSelectionChange={setSelected}
          rowLabel={(r) => r.title}
          caption={t('books.wanted.title')}
          empty={<EmptyState title={reason === 'missing' ? t('books.wanted.noneMissing') : t('books.wanted.noneCutoff')}>{t('books.wanted.emptyBody')}</EmptyState>}
        />
      )}
      {pages > 1 ? <Paginator page={page} pageCount={pages} onPageChange={setPage} /> : null}
    </div>
  );
}
