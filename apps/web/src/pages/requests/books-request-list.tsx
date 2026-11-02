import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BooksKind, BooksRequest, BooksRequestStatus, ComicSeriesCandidate, EbookCandidate, RequestFilter } from '@arclight/shared';
import { Button, Chip, EmptyState, Field, Input, Modal, Pane, Segmented, Table, Textarea, Timeline, type Column } from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { Loading, QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { formatDateTime } from '../../features/requests/status.js';
import { useBooksRequestAction, useBooksRequestComicLookup, useBooksRequestEbookLookup, useBooksRequests, useCreateBooksRequest } from '../../hooks/books.js';
import { BooksKindChip, CoverArt, SourceStatusChips, comicSeriesLink, useDebounced } from '../library/books/books-kit.js';
import { booksRequestStatusOfTab, requestStatusTone } from '../library/books/books-model.js';
import { shortDate } from './my-requests-page.js';
import '../library/books/books.css';
import { t } from '../../i18n/index.js';

export function booksRequestStatusLabel(status: BooksRequestStatus, available: boolean): string {
  if (available) return t('common.available');
  switch (status) {
    case 'pending':
      return t('common.pending');
    case 'approved':
      return t('common.approved');
    case 'declined':
      return t('common.declined');
    case 'completed':
      return t('common.available');
    case 'failed':
      return t('books.requests.failed');
  }
}

function StatusChip({ r }: { r: BooksRequest }) {
  return (
    <Chip tone={requestStatusTone(r.status, r.available)} dot="fill">
      {booksRequestStatusLabel(r.status, r.available)}
    </Chip>
  );
}

function RequestTitle({ r }: { r: BooksRequest }) {
  return (
    <span className="bk-book-row">
      <CoverArt src={r.coverUrl} title={r.title} className="bk-book-row__cover" />
      <span style={{ minWidth: 0 }}>
        {r.title}
        {r.subtitle ? <span className="mk-muted"> · {r.subtitle}</span> : null}
        {r.year ? <span className="al-num mk-muted"> {r.year}</span> : null}
      </span>
    </span>
  );
}

/** Requests page, "Books" media filter: everyone's ebook and comic requests (approve / decline / delete for managers). */
export function BooksRequestTable({ filter, manage }: { filter: RequestFilter; manage: boolean }) {
  const list = useBooksRequests({ kind: 'all', status: booksRequestStatusOfTab(filter) });
  const [declining, setDeclining] = useState<BooksRequest | null>(null);
  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title={t('requests.couldNotLoadRequests')} onRetry={() => void list.refetch()} />;
  const columns: Column<BooksRequest>[] = [
    { key: 'title', header: t('common.title'), mobile: 'primary', cell: (r) => <RequestTitle r={r} /> },
    { key: 'kind', header: t('books.kindLabel'), cell: (r) => <BooksKindChip kind={r.kind} />, width: '96px' },
    { key: 'by', header: t('common.requestedBy'), cell: (r) => r.requestedBy.username },
    { key: 'status', header: t('common.status'), cell: (r) => <StatusChip r={r} /> },
    { key: 'created', header: t('common.requested'), mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      mobile: 'end',
      align: 'right',
      cell: (r) => <RequestActions r={r} manage={manage} onDecline={() => setDeclining(r)} />,
    },
  ];
  return (
    <>
      <Pane flush bare>
        <Table
          columns={columns}
          rows={list.data.records}
          rowKey={(r) => r.id}
          density="rich"
          sortable={false}
          caption={t('common.requests')}
          empty={<EmptyState title={t('requests.noRequests')}>{t('books.requests.emptyBody')}</EmptyState>}
        />
      </Pane>
      {declining ? <DeclineDialog request={declining} onClose={() => setDeclining(null)} /> : null}
    </>
  );
}

function RequestActions({ r, manage, onDecline }: { r: BooksRequest; manage: boolean; onDecline: () => void }) {
  const action = useBooksRequestAction();
  const busy = action.isPending ? action.variables.action : null;
  return (
    <span className="mk-row mk-row--end">
      {/* libraryId is the comic series (linkable) or the ebook (no page of its own; it shows under its author). */}
      {r.kind === 'comic' && r.libraryId !== null && r.status !== 'pending' ? (
        <Link {...comicSeriesLink({ id: r.libraryId })} className="mk-link">
          {t('common.open')}
        </Link>
      ) : null}
      {manage && r.status === 'pending' ? (
        <>
          <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => action.mutate({ id: r.id, action: 'approve' })}>
            {t('common.approve')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDecline}>
            {t('books.requests.decline')}
          </Button>
        </>
      ) : null}
      {r.canRemove ? (
        <Button size="sm" variant="ghost" loading={busy === 'remove'} onClick={() => action.mutate({ id: r.id, action: 'remove' })}>
          {manage ? t('common.delete') : t('requests.myRequests.cancelRequest')}
        </Button>
      ) : null}
    </span>
  );
}

function DeclineDialog({ request, onClose }: { request: BooksRequest; onClose: () => void }) {
  const action = useBooksRequestAction();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('requests.declineMediatitle', { mediaTitle: request.title })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={action.isPending} onClick={() => action.mutate({ id: request.id, action: 'decline', reason: reason.trim() || undefined }, { onSuccess: onClose })}>
            {t('requests.declineRequest')}
          </Button>
        </>
      }
    >
      <Field label={t('requests.reasonOptional')} hint={t('requests.shownToTheRequester')}>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </Field>
    </Modal>
  );
}

/** My requests, "Books": search the catalogues, request a book or comic series, and see one's own book requests. */
export function BooksMyRequests({ kinds }: { kinds: readonly BooksKind[] }) {
  const list = useBooksRequests({ mine: true });
  const action = useBooksRequestAction();
  return (
    <div className="mk-stack-sm">
      <BooksRequestSearch kinds={kinds} />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <QueryError error={list.error} title={t('requests.myRequests.couldNotLoadYourRequests')} onRetry={() => void list.refetch()} />
      ) : list.data.records.length === 0 ? (
        <EmptyState title={t('requests.myRequests.noRequestsYet')}>{t('books.requests.requestHelp')}</EmptyState>
      ) : (
        <Pane>
          <Timeline
            items={list.data.records.map((r) => ({
              id: String(r.id),
              date: shortDate(r.createdAt),
              tone: r.status === 'declined' ? 'warn' : r.status === 'failed' ? 'danger' : 'default',
              title: <RequestTitle r={r} />,
              aside: (
                <>
                  <StatusChip r={r} />
                  {r.status === 'pending' && r.canRemove ? (
                    <Button size="sm" variant="ghost" loading={action.isPending && action.variables.id === r.id} onClick={() => action.mutate({ id: r.id, action: 'remove' })}>
                      {t('requests.myRequests.cancelRequest')}
                    </Button>
                  ) : null}
                </>
              ),
              description: (
                <>
                  <span>{r.kind === 'ebook' ? t('books.kind.ebook') : t('books.kind.comic')}</span>
                  {r.declineReason ? <span> · {t('requests.myRequests.reasonDeclinereason', { declineReason: r.declineReason })}</span> : null}
                  {r.failureReason ? <span> · {r.failureReason}</span> : null}
                </>
              ),
            }))}
          />
        </Pane>
      )}
    </div>
  );
}

type Candidate = { kind: 'ebook'; item: EbookCandidate } | { kind: 'comic'; item: ComicSeriesCandidate };

function BooksRequestSearch({ kinds }: { kinds: readonly BooksKind[] }) {
  const [kind, setKind] = useState<BooksKind>(kinds[0] ?? 'ebook');
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const ebooks = useBooksRequestEbookLookup(debounced, kind === 'ebook');
  const comics = useBooksRequestComicLookup(debounced, kind === 'comic');
  const query = kind === 'ebook' ? ebooks : comics;
  const results: Candidate[] = kind === 'ebook' ? (ebooks.data?.results ?? []).map((item) => ({ kind: 'ebook', item })) : (comics.data?.results ?? []).map((item) => ({ kind: 'comic', item }));
  const short = debounced.trim().length < 2;

  return (
    <Pane>
      <div className="mk-stack-sm">
        <div className="mk-row">
          {kinds.length > 1 ? (
            <Segmented
              aria-label={t('books.kindLabel')}
              variant="soft"
              value={kind}
              onChange={setKind}
              options={kinds.map((k) => ({ value: k, label: k === 'ebook' ? t('books.kind.ebooks') : t('books.kind.comics') }))}
            />
          ) : null}
          <Input
            type="search"
            className="mk-search"
            aria-label={t('books.requests.searchLabel')}
            placeholder={kind === 'ebook' ? t('books.add.placeholderBook') : t('books.add.placeholderComic')}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
        <SourceStatusChips sources={query.data?.sources} />
        {short ? null : query.isFetching && results.length === 0 ? (
          <Loading label={t('books.add.searching')} />
        ) : query.isError ? (
          <QueryError error={query.error} title={t('common.searchFailed')} onRetry={() => void query.refetch()} />
        ) : results.length === 0 ? (
          <EmptyState title={t('books.add.noResults')}>{t('books.add.noResultsBody', { term: debounced.trim() })}</EmptyState>
        ) : (
          <ul className="bk-results">
            {results.map((c) => (
              <CandidateRow key={c.item.foreignId} candidate={c} />
            ))}
          </ul>
        )}
      </div>
    </Pane>
  );
}

function CandidateRow({ candidate }: { candidate: Candidate }) {
  const create = useCreateBooksRequest();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const c = candidate.item;
  const ebook = candidate.kind === 'ebook';
  const year = ebook ? candidate.item.year : candidate.item.startYear;
  const meta = ebook ? [candidate.item.authorName, year ? String(year) : null] : [candidate.item.publisher, year ? String(year) : null];
  const subtitle = ebook ? candidate.item.subtitle : null;
  const request = () =>
    create.mutate(
      { kind: candidate.kind, foreignId: c.foreignId, title: c.title, subtitle, year, coverUrl: c.coverUrl },
      {
        onSuccess: () => {
          setDone(true);
          toast.push({ tone: 'ok', title: t('books.requests.requested', { title: c.title }) });
        },
        onError: (e) => toast.push({ tone: 'error', title: t('books.requests.couldNotRequest'), message: errorMessage(e) }),
      },
    );
  return (
    <li className="bk-result">
      <CoverArt src={c.coverUrl} title={c.title} className="bk-result__cover" />
      <div style={{ minWidth: 0 }}>
        <div className="bk-result__title">{subtitle ? `${c.title}: ${subtitle}` : c.title}</div>
        <div className="bk-result__meta">{meta.filter(Boolean).join(' · ')}</div>
        {c.overview ? <p className="bk-result__overview">{c.overview}</p> : null}
      </div>
      <div>
        {c.libraryId !== null ? (
          <span className="mk-muted">{t('books.add.inLibrary')}</span>
        ) : done ? (
          <span className="mk-muted">{t('common.requested')}</span>
        ) : (
          <Button size="sm" variant="primary" loading={create.isPending} onClick={request}>
            {t('common.request')}
          </Button>
        )}
      </div>
    </li>
  );
}
