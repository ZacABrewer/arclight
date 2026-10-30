import { useState } from 'react';
import type { AdditionalAudioMode, LanguageRequest, RequestFilter } from '@arclight/shared';
import { Button, Checkbox, Chip, EmptyState, Field, Modal, Pane, Paginator, Poster, RadioGroup, Table, Textarea, Timeline, type Column } from '../../arclight/index.js';
import { useSelection } from '../../components/bulk-actions.js';
import { BulkBar } from '../../components/media/bulk-bar.js';
import { ListSearchEmpty } from '../../components/list-search.js';
import { Loading, QueryError, useIsMobile } from '../../components/media/media-kit.js';
import { DLink, titleTarget } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { REQUEST_STATUS_META, formatDateTime } from '../../features/requests/status.js';
import {
  useApproveLanguageRequest,
  useBulkLanguageRequestAction,
  useDeclineLanguageRequest,
  useDeleteLanguageRequest,
  useLanguageRequests,
  useRetryLanguageRequest,
} from '../../hooks/language-requests.js';
import { StatusLabelChip } from '../discover/discover-kit.js';
import { RequestSearchCount } from './audio-request-list.js';
import { requestTimeline, shortDate } from './my-requests-page.js';
import { useRequestBulkActions } from './request-bulk.js';
import { t } from '../../i18n/index.js';

// Subtitle and language requests (GET /request/language) for the Requests page (everyone's, with
// approve / decline / retry / delete for managers) and My requests (own, cancel while pending).
// Approving an audio request asks how: replace the file or add a version (default replace).

const PAGE_SIZE = 20;

export function languageKindLabel(kind: LanguageRequest['kind']): string {
  return kind === 'audio' ? t('requests.language.kindAudio') : t('requests.language.kindSubtitle');
}

/** "Whole series" / "Season 2"; nothing for movies. */
export function languageScopeLabel(r: Pick<LanguageRequest, 'mediaType' | 'seasonNumber'>): string | null {
  if (r.mediaType !== 'series') return null;
  if (r.seasonNumber === null) return t('requests.language.wholeSeries');
  return r.seasonNumber === 0 ? t('common.specials') : t('requests.language.seasonN', { season: r.seasonNumber });
}

/** "Spanish", "Spanish · forced only", "Spanish · hearing impaired". */
export function languageLabel(r: Pick<LanguageRequest, 'kind' | 'languageName' | 'forced' | 'hi'>): string {
  const flags = r.kind === 'subtitle' ? [r.forced === 'only' ? t('requests.language.forcedOnly') : null, r.hi === 'only' ? t('requests.language.hearingImpaired') : null] : [];
  return [r.languageName, ...flags].filter(Boolean).join(' · ');
}

/** Poster + linked title + "Subtitles · Spanish · Season 2". */
export function LanguageRequestTitle({ r }: { r: LanguageRequest }) {
  const scope = languageScopeLabel(r);
  return (
    <div className="mk-title-cell">
      <Poster src={tmdbImage(r.poster ?? null, 'profile')} title={r.title} width={32} />
      <div className="mk-title-cell__text">
        <DLink className="mk-link" {...titleTarget(r.mediaType, r.tmdbId)}>
          {r.title}
        </DLink>
        <span className="mk-title-cell__sub">
          {r.year ? <span className="al-num">{r.year}</span> : null}
          {r.year ? ' · ' : ''}
          {[languageLabel(r), scope].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}

function LanguageStatusCell({ r }: { r: LanguageRequest }) {
  return (
    <div className="mk-stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
      <div className="mk-row" style={{ gap: 6 }}>
        <Chip tone={r.kind === 'audio' ? 'neutral' : 'default'} dot="none">
          {languageKindLabel(r.kind)}
        </Chip>
        <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
      </div>
      {r.note ? <span className="mk-title-cell__sub">{t('requests.language.noteValue', { note: r.note })}</span> : null}
      {r.outcomeMessage ? <span className="mk-title-cell__sub">{r.outcomeMessage}</span> : null}
      {r.declineReason ? <span className="mk-title-cell__sub">{r.declineReason}</span> : null}
      {r.failureReason ? <span className="mk-title-cell__sub" style={{ color: 'var(--al-danger-text)' }}>{r.failureReason}</span> : null}
    </div>
  );
}

/** Approve / Decline (managers, pending), Retry (managers, failed), Delete (canRemove). */
function LanguageRequestActions({ r, manage }: { r: LanguageRequest; manage: boolean }) {
  const approve = useApproveLanguageRequest();
  const retry = useRetryLanguageRequest();
  const [approving, setApproving] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="mk-row mk-row--end" style={{ flexWrap: 'wrap' }}>
      {manage && r.status === 'pending' ? (
        <>
          <Button size="sm" loading={approve.isPending} onClick={() => (r.kind === 'audio' ? setApproving(true) : approve.mutate({ id: r.id }))}>
            {t('common.approve')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeclining(true)}>
            {t('requests.decline')}
          </Button>
        </>
      ) : null}
      {manage && r.status === 'failed' ? (
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(r.id)}>
          {t('requests.retry')}
        </Button>
      ) : null}
      {r.canRemove ? (
        <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
          {t('common.delete')}
        </Button>
      ) : null}
      {approving ? <ApproveAudioDialog request={r} onClose={() => setApproving(false)} /> : null}
      {declining ? <LanguageDeclineDialog request={r} onClose={() => setDeclining(false)} /> : null}
      {deleting ? <LanguageDeleteDialog request={r} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}

/** Status tabs of the Requests page mapped onto the language list's filters. */
function languageFilter(filter: RequestFilter): 'all' | 'pending' | 'approved' | 'declined' | 'failed' | 'completed' {
  switch (filter) {
    case 'pending':
    case 'approved':
    case 'declined':
    case 'failed':
    case 'completed':
      return filter;
    case 'processing':
      return 'approved';
    case 'available':
      return 'completed';
    default:
      return 'all';
  }
}

/** Everyone's (or the caller's) language requests, by status tab, paged. */
export function LanguageRequestTable({
  filter,
  manage,
  q = '',
  onClearSearch,
}: {
  filter: RequestFilter;
  manage: boolean;
  /** The page's text search (title, language, requester, status; server-side). */
  q?: string | undefined;
  onClearSearch?: (() => void) | undefined;
}) {
  const [page, setPage] = useState(0);
  const list = useLanguageRequests({ filter: languageFilter(filter), take: PAGE_SIZE, skip: page * PAGE_SIZE, sortDirection: 'desc', q: q || undefined });
  const mobile = useIsMobile();
  const bulk = useBulkLanguageRequestAction();
  const rows = list.data?.results ?? [];
  const keys = rows.map((r) => r.id);
  const selection = useSelection(keys);
  const bulkBar = useRequestBulkActions({
    ids: selection.selected,
    manage,
    busy: bulk.isPending ? (bulk.variables?.action ?? null) : null,
    run: (action, ids) => bulk.mutateAsync({ action, ids }),
    nameOf: (id) => rows.find((r) => r.id === id)?.title,
    onDone: selection.drop,
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title={t('requests.couldNotLoadRequests')} onRetry={() => void list.refetch()} />;
  const { results, pageInfo } = list.data;
  const pages = Math.max(1, Math.ceil(pageInfo.total / PAGE_SIZE));
  const columns: Column<LanguageRequest>[] = [
    { key: 'title', header: t('common.title'), cell: (r) => <LanguageRequestTitle r={r} /> },
    { key: 'by', header: t('common.requestedBy'), cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
    { key: 'status', header: t('common.status'), cell: (r) => <LanguageStatusCell r={r} /> },
    { key: 'created', header: t('common.requested'), mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
    {
      key: 'modified',
      header: t('requests.modified'),
      mono: true,
      muted: true,
      cell: (r) => (
        <>
          {formatDateTime(r.updatedAt)}
          {r.modifiedBy ? <div className="mk-title-cell__sub">{t('requests.byValue', { value: r.modifiedBy.displayName ?? r.modifiedBy.username })}</div> : null}
        </>
      ),
    },
    { key: 'actions', header: <span className="al-sr-only">{t('common.actions')}</span>, align: 'right', cell: (r) => <LanguageRequestActions r={r} manage={manage} /> },
  ];

  return (
    <>
      <RequestSearchCount q={q} total={pageInfo.total} />
      {results.length === 0 ? (
        q ? (
          <ListSearchEmpty query={q} onClear={() => onClearSearch?.()} />
        ) : (
          <EmptyState title={t('requests.noRequests')}>{t('requests.language.emptyHelp')}</EmptyState>
        )
      ) : mobile ? (
        <div className="mk-mlist">
          {results.map((r) => (
            <div className="mk-mrow mk-mrow--check" key={r.id}>
              <Checkbox aria-label={t('requests.selectMediatitle', { mediaTitle: r.title })} checked={selection.has(r.id)} onChange={() => selection.toggle(r.id)} />
              <div style={{ minWidth: 0 }}>
                <LanguageRequestTitle r={r} />
                <div style={{ marginTop: 6 }}>
                  <LanguageStatusCell r={r} />
                </div>
              </div>
              <LanguageRequestActions r={r} manage={manage} />
            </div>
          ))}
        </div>
      ) : (
        <Pane flush bare>
          <Table
            columns={columns}
            rows={results}
            rowKey={(r) => r.id}
            density="rich"
            sortable={false}
            caption={t('requests.language.caption')}
            selectable
            selected={selection.selected}
            onSelectionChange={selection.set}
            rowLabel={(r) => t('requests.selectMediatitle', { mediaTitle: r.title })}
          />
        </Pane>
      )}
      <BulkBar count={selection.count} total={keys.length} onSelectAll={() => selection.set(keys)} actions={bulkBar.actions} onClear={selection.clear}>
        {bulkBar.dialogs}
      </BulkBar>
      {pages > 1 ? (
        <div className="mk-row mk-row--end" style={{ marginTop: 16 }}>
          <Paginator page={page + 1} pageCount={pages} onPageChange={(p) => setPage(p - 1)} />
        </div>
      ) : null}
    </>
  );
}

/** My requests: the caller's language requests as a timeline. */
export function LanguageMyRequests({ userId }: { userId: number }) {
  const list = useLanguageRequests({ requestedBy: userId, take: 100, sortDirection: 'desc' });
  const [cancelling, setCancelling] = useState<LanguageRequest | null>(null);
  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title={t('requests.myRequests.couldNotLoadYourRequests')} onRetry={() => void list.refetch()} />;
  if (list.data.results.length === 0) {
    return (
      <EmptyState
        title={t('requests.myRequests.noRequestsYet')}
        action={
          <DLink className="al-btn al-btn--primary" to="">
            {t('requests.myRequests.discoverTitles')}
          </DLink>
        }
      >
        {t('requests.language.myEmptyHelp')}
      </EmptyState>
    );
  }
  return (
    <>
      <Pane>
        <Timeline
          items={list.data.results.map((r) => {
            // Language requests have no library availability of their own: completed is "added".
            const steps = requestTimeline({ ...r, mediaStatus: r.status === 'completed' ? 'available' : 'unknown' })
              .map((s) => `${s.done ? s.label : t('requests.myRequests.nextStep', { label: s.label })}${s.at && s.done ? ` ${formatDateTime(s.at)}` : ''}`)
              .join(' → ');
            const scope = languageScopeLabel(r);
            return {
              id: String(r.id),
              date: shortDate(r.createdAt),
              tone: r.status === 'declined' ? 'warn' : r.status === 'failed' ? 'danger' : 'default',
              title: (
                <DLink className="mk-link" {...titleTarget(r.mediaType, r.tmdbId)}>
                  {r.title}
                  {r.year ? <span className="al-num mk-muted"> {r.year}</span> : null}
                </DLink>
              ),
              aside: (
                <>
                  <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
                  {r.status === 'pending' && r.canRemove ? (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>
                      {t('requests.myRequests.cancelRequest')}
                    </Button>
                  ) : null}
                </>
              ),
              description: (
                <>
                  <span>{[languageKindLabel(r.kind), languageLabel(r), scope].filter(Boolean).join(' · ')} · </span>
                  {steps}
                  {r.outcomeMessage ? <span> {r.outcomeMessage}</span> : null}
                  {r.failureReason ? <span> {r.failureReason}</span> : null}
                  {r.declineReason ? <span> {t('requests.myRequests.reasonDeclinereason', { declineReason: r.declineReason })}</span> : null}
                </>
              ),
            };
          })}
        />
      </Pane>
      {cancelling ? <LanguageDeleteDialog request={cancelling} own onClose={() => setCancelling(null)} /> : null}
    </>
  );
}

/** Audio requests: replace the file with a release that has every language, or add a version. */
function ApproveAudioDialog({ request, onClose }: { request: LanguageRequest; onClose: () => void }) {
  const approve = useApproveLanguageRequest();
  const [mode, setMode] = useState<AdditionalAudioMode>('replace');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('requests.language.approveTitle', { language: request.languageName, title: request.title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate({ id: request.id, body: { mode } }, { onSuccess: onClose })}>
            {t('common.approve')}
          </Button>
        </>
      }
    >
      <RadioGroup
        legend={t('requests.language.how')}
        value={mode}
        onChange={(v) => setMode(v as AdditionalAudioMode)}
        options={[
          { value: 'replace', label: t('requests.language.modeReplace'), hint: t('requests.language.modeReplaceHint') },
          { value: 'version', label: t('requests.language.modeVersion'), hint: t('requests.language.modeVersionHint') },
        ]}
      />
    </Modal>
  );
}

function LanguageDeclineDialog({ request, onClose }: { request: LanguageRequest; onClose: () => void }) {
  const decline = useDeclineLanguageRequest();
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
          <Button variant="danger" loading={decline.isPending} onClick={() => decline.mutate({ id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }, { onSuccess: onClose })}>
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

/** Delete (managers) or cancel (own pending request) confirm. */
function LanguageDeleteDialog({ request, own = false, onClose }: { request: LanguageRequest; own?: boolean; onClose: () => void }) {
  const del = useDeleteLanguageRequest();
  return (
    <Modal
      open
      onClose={onClose}
      title={own ? t('requests.myRequests.cancelYourRequestForMediatitle', { mediaTitle: request.title }) : t('requests.deleteTheRequestForMediatitle', { mediaTitle: request.title })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {own ? t('requests.myRequests.keepRequest') : t('common.cancel')}
          </Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(request.id, { onSuccess: onClose })}>
            {own ? t('requests.myRequests.cancelRequest') : t('requests.deleteRequest')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{own ? t('requests.myRequests.theRequestIsRemovedYou') : t('requests.language.deleteHelp')}</p>
    </Modal>
  );
}
