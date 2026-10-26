import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MediaRequest } from '@arclight/shared';
import { Button, EmptyState, Modal, PageHeader, Pane, Timeline, type TimelineItem } from '../../arclight/index.js';
import { Loading, QueryError } from '../../components/media/media-kit.js';
import { titleLink } from '../../features/requests/title-link.js';
import { HeldChip } from '../../features/requests/policy-drawer.js';
import { REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useDeleteRequest, useRequests } from '../../hooks/requests.js';
import { StatusLabelChip } from '../discover/discover-kit.js';
import '../../components/media/media-kit.css';
import { t, intlLocale } from '../../i18n/index.js';

export interface TimelineStep {
  label: string;
  done: boolean;
  at?: string;
}

/** Requested → decided (approved/declined/failed) → available. */
export function requestTimeline(r: MediaRequest): TimelineStep[] {
  const steps: TimelineStep[] = [{ label: t('common.requested'), done: true, at: r.createdAt }];
  if (r.status === 'declined') return [...steps, { label: t('common.declined'), done: true, at: r.updatedAt }];
  if (r.status === 'failed') return [...steps, { label: t('common.approved'), done: true }, { label: t('requests.myRequests.failedToAdd'), done: true, at: r.updatedAt }];
  const approved = r.status !== 'pending';
  steps.push(approved ? { label: t('common.approved'), done: true, at: r.updatedAt } : { label: t('requests.myRequests.awaitingApproval'), done: false });
  const available = r.mediaStatus === 'available' || r.status === 'completed';
  steps.push({ label: r.mediaStatus === 'partiallyAvailable' ? t('requests.myRequests.partiallyAvailable') : t('common.available'), done: available || r.mediaStatus === 'partiallyAvailable' });
  return steps;
}

/** "12 Oct" style date for the timeline's mono column. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(intlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

/** One timeline entry per request: mono date, linked title, status chip, steps line. */
export function requestTimelineItem(r: MediaRequest, aside?: React.ReactNode): TimelineItem {
  const steps = requestTimeline(r)
    .map((s) => `${s.done ? s.label : t('requests.myRequests.nextStep', { label: s.label })}${s.at && s.done ? ` ${formatDateTime(s.at)}` : ''}`)
    .join(' → ');
  return {
    id: String(r.id),
    date: shortDate(r.createdAt),
    tone: r.status === 'declined' ? 'warn' : r.status === 'failed' ? 'danger' : 'default',
    title: (
      <Link className="mk-link" {...titleLink(r.type, r.mediaTmdbId)}>
        {r.mediaTitle}
        {r.mediaYear ? <span className="al-num mk-muted"> {r.mediaYear}</span> : null}
        {r.is4k ? t('requests.myRequests.n4k') : ''}
      </Link>
    ),
    aside: (
      <>
        <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
        <HeldChip request={r} />
        {aside}
      </>
    ),
    description: (
      <>
        {r.seasons.length ? <span className="al-num">{seasonsLabel(r.seasons)} · </span> : null}
        {steps}
        {r.declineReason ? <span> {t('requests.myRequests.reasonDeclinereason', { declineReason: r.declineReason })}</span> : null}
      </>
    ),
  };
}

export function MyRequestsPage() {
  const { userId } = usePermissions();
  const list = useRequests({ requestedBy: userId ?? undefined, take: 100, sort: 'added', sortDirection: 'desc' }, userId !== null);
  const [cancelling, setCancelling] = useState<MediaRequest | null>(null);

  return (
    <>
      <PageHeader
        index="03"
        title={t('common.myRequests')}
        actions={
          <Link className="al-btn al-btn--primary" to="/discover">
            {t('requests.myRequests.discoverTitles')}
          </Link>
        }
      />
      {userId === null ? (
        <EmptyState title={t('requests.myRequests.noUserAccount')}>{t('requests.myRequests.myRequestsListsTheRequests')}</EmptyState>
      ) : list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <QueryError error={list.error} title={t('requests.myRequests.couldNotLoadYourRequests')} onRetry={() => void list.refetch()} />
      ) : list.data.results.length === 0 ? (
        <EmptyState
          title={t('requests.myRequests.noRequestsYet')}
          action={
            <Link className="al-btn al-btn--primary" to="/discover">
              {t('requests.myRequests.discoverTitles')}
            </Link>
          }
        >
          {t('requests.myRequests.requestAMovieOrSeries')}
        </EmptyState>
      ) : (
        <Pane>
          <Timeline
            items={list.data.results.map((r) =>
              requestTimelineItem(
                r,
                r.status === 'pending' && r.canRemove ? (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>
                    {t('requests.myRequests.cancelRequest')}
                  </Button>
                ) : undefined,
              ),
            )}
          />
        </Pane>
      )}
      {cancelling ? <CancelRequestDialog request={cancelling} onClose={() => setCancelling(null)} /> : null}
    </>
  );
}

function CancelRequestDialog({ request, onClose }: { request: MediaRequest; onClose: () => void }) {
  const del = useDeleteRequest();
  return (
    <Modal
      open
      onClose={onClose}
      title={t('requests.myRequests.cancelYourRequestForMediatitle', { mediaTitle: request.mediaTitle })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('requests.myRequests.keepRequest')}
          </Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(request.id, { onSuccess: onClose })}>
            {t('requests.myRequests.cancelRequest')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t('requests.myRequests.theRequestIsRemovedYou')}</p>
    </Modal>
  );
}
