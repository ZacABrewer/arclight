import { useState } from 'react';
import type { AudioRequest, AudioRequestKind, RequestFilter } from '@arclight/shared';
import type { AudioDomain } from '../../api/audio-requests.js';
import { Button, Checkbox, EmptyState, Field, Modal, Pane, Paginator, Poster, Table, Textarea, Timeline, type Column } from '../../arclight/index.js';
import { useSelection } from '../../components/bulk-actions.js';
import { BulkBar } from '../../components/media/bulk-bar.js';
import { useRequestBulkActions } from './request-bulk.js';
import { Loading, QueryError, useIsMobile } from '../../components/media/media-kit.js';
import { DLink } from '../../features/discover/base.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, formatDateTime } from '../../features/requests/status.js';
import {
  useApproveAudioRequest,
  useBulkAudioRequestAction,
  useAudioRequests,
  useDeclineAudioRequest,
  useDeleteAudioRequest,
  useRetryAudioRequest,
} from '../../hooks/audio-requests.js';
import { StatusLabelChip } from '../discover/discover-kit.js';
import { audioTarget, isAudioDisabled } from '../discover/audio-kit.js';
import { requestTimeline, shortDate } from './my-requests-page.js';
import { t } from '../../i18n/index.js';

// Music and audiobook requests (GET /audiorequest) for the Requests page (everyone's, with
// approve / decline / retry / delete for managers) and My requests (own, cancel while pending).
// Approving needs no dialog: audio requests have no root folder or profile pickers.

const PAGE_SIZE = 20;

export function kindLabel(kind: AudioRequestKind): string {
  switch (kind) {
    case 'album':
      return t('music.album');
    case 'artist':
      return t('music.artist');
    case 'book':
      return t('discover.audio.audiobook');
    case 'author':
      return t('audiobooks.author');
  }
}

/** Cover + linked title + "2011 · Album · Artist name". */
export function AudioRequestTitle({ r }: { r: AudioRequest }) {
  return (
    <div className="mk-title-cell">
      <Poster src={r.coverUrl ?? null} title={r.title} width={32} />
      <div className="mk-title-cell__text">
        <DLink className="mk-link" {...audioTarget({ kind: r.kind, foreignId: r.foreignId, region: r.region })}>
          {r.title}
        </DLink>
        <span className="mk-title-cell__sub">
          {r.year ? <span className="al-num">{r.year}</span> : null}
          {r.year ? ' · ' : ''}
          {[kindLabel(r.kind), r.subtitle].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}

function AudioStatusCell({ r }: { r: AudioRequest }) {
  return (
    <div className="mk-stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
      <div className="mk-row" style={{ gap: 6 }}>
        <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
        {r.status === 'approved' || r.status === 'completed' ? <StatusLabelChip label={MEDIA_STATUS_META[r.mediaStatus].label} /> : null}
      </div>
      {r.declineReason ? <span className="mk-title-cell__sub">{r.declineReason}</span> : null}
      {r.failureReason ? <span className="mk-title-cell__sub" style={{ color: 'var(--al-danger-text)' }}>{r.failureReason}</span> : null}
    </div>
  );
}

/** Approve / Decline (managers, pending), Retry (managers, failed), Delete (canRemove). */
function AudioRequestActions({ r, manage }: { r: AudioRequest; manage: boolean }) {
  const approve = useApproveAudioRequest();
  const retry = useRetryAudioRequest();
  const [declining, setDeclining] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="mk-row mk-row--end" style={{ flexWrap: 'wrap' }}>
      {manage && r.status === 'pending' ? (
        <>
          <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(r.id)}>
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
      {declining ? <AudioDeclineDialog request={r} onClose={() => setDeclining(false)} /> : null}
      {deleting ? <AudioDeleteDialog request={r} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}

/** Everyone's (or the caller's) audio requests of one domain, by status tab, paged. */
export function AudioRequestTable({ filter, domain, manage }: { filter: RequestFilter; domain: AudioDomain; manage: boolean }) {
  const [page, setPage] = useState(0);
  // The audio list has no "unavailable" filter (the status tabs never pick it).
  const list = useAudioRequests({ filter: filter === 'unavailable' ? 'all' : filter, domain, take: PAGE_SIZE, skip: page * PAGE_SIZE, sortDirection: 'desc' });
  const mobile = useIsMobile();
  const bulk = useBulkAudioRequestAction();
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
  if (list.isError) {
    if (isAudioDisabled(list.error)) return <EmptyState title={domain === 'music' ? t('discover.audio.musicOff') : t('discover.audio.audiobooksOff')}>{t('discover.audio.offHelp')}</EmptyState>;
    return <QueryError error={list.error} title={t('requests.couldNotLoadRequests')} onRetry={() => void list.refetch()} />;
  }
  const { results, pageInfo } = list.data;
  const pages = Math.max(1, Math.ceil(pageInfo.total / PAGE_SIZE));
  const columns: Column<AudioRequest>[] = [
    { key: 'title', header: t('common.title'), cell: (r) => <AudioRequestTitle r={r} /> },
    { key: 'by', header: t('common.requestedBy'), cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
    { key: 'status', header: t('common.status'), cell: (r) => <AudioStatusCell r={r} /> },
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
    { key: 'actions', header: <span className="al-sr-only">{t('common.actions')}</span>, align: 'right', cell: (r) => <AudioRequestActions r={r} manage={manage} /> },
  ];

  return (
    <>
      {results.length === 0 ? (
        <EmptyState title={t('requests.noRequests')}>{t('requests.requestsMadeFromDiscoverShow')}</EmptyState>
      ) : mobile ? (
        <div className="mk-mlist">
          {results.map((r) => (
            <div className="mk-mrow mk-mrow--check" key={r.id}>
              <Checkbox aria-label={t('requests.selectMediatitle', { mediaTitle: r.title })} checked={selection.has(r.id)} onChange={() => selection.toggle(r.id)} />
              <div style={{ minWidth: 0 }}>
                <AudioRequestTitle r={r} />
                <div style={{ marginTop: 6 }}>
                  <AudioStatusCell r={r} />
                </div>
              </div>
              <AudioRequestActions r={r} manage={manage} />
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
            caption={t('common.requests')}
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

/** My requests: the caller's audio requests of one domain as a timeline. */
export function AudioMyRequests({ domain, userId }: { domain: AudioDomain; userId: number }) {
  const list = useAudioRequests({ domain, requestedBy: userId, take: 100, sortDirection: 'desc' });
  const [cancelling, setCancelling] = useState<AudioRequest | null>(null);
  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title={t('requests.myRequests.couldNotLoadYourRequests')} onRetry={() => void list.refetch()} />;
  if (list.data.results.length === 0) {
    return (
      <EmptyState
        title={t('requests.myRequests.noRequestsYet')}
        action={
          <DLink className="al-btn al-btn--primary" to={domain === 'music' ? '/music' : '/audiobooks'}>
            {domain === 'music' ? t('discover.audio.discoverMusic') : t('discover.audio.discoverAudiobooks')}
          </DLink>
        }
      >
        {domain === 'music' ? t('discover.audio.requestMusicHelp') : t('discover.audio.requestAudiobooksHelp')}
      </EmptyState>
    );
  }
  return (
    <>
      <Pane>
        <Timeline
          items={list.data.results.map((r) => {
            const steps = requestTimeline(r)
              .map((s) => `${s.done ? s.label : t('requests.myRequests.nextStep', { label: s.label })}${s.at && s.done ? ` ${formatDateTime(s.at)}` : ''}`)
              .join(' → ');
            return {
              id: String(r.id),
              date: shortDate(r.createdAt),
              tone: r.status === 'declined' ? 'warn' : r.status === 'failed' ? 'danger' : 'default',
              title: (
                <DLink className="mk-link" {...audioTarget({ kind: r.kind, foreignId: r.foreignId, region: r.region })}>
                  {r.title}
                  {r.subtitle ? <span className="mk-muted"> · {r.subtitle}</span> : null}
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
                  <span>{kindLabel(r.kind)} · </span>
                  {steps}
                  {r.declineReason ? <span> {t('requests.myRequests.reasonDeclinereason', { declineReason: r.declineReason })}</span> : null}
                </>
              ),
            };
          })}
        />
      </Pane>
      {cancelling ? <AudioDeleteDialog request={cancelling} own onClose={() => setCancelling(null)} /> : null}
    </>
  );
}

function AudioDeclineDialog({ request, onClose }: { request: AudioRequest; onClose: () => void }) {
  const decline = useDeclineAudioRequest();
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
function AudioDeleteDialog({ request, own = false, onClose }: { request: AudioRequest; own?: boolean; onClose: () => void }) {
  const del = useDeleteAudioRequest();
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
      <p style={{ margin: 0 }}>{own ? t('requests.myRequests.theRequestIsRemovedYou') : t('requests.theTitleStaysInThe')}</p>
    </Modal>
  );
}
