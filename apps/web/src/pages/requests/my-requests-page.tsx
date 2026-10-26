import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MediaRequest } from '@arclight/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Poster } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { titleLink } from '../../features/requests/discover-ui.js';
import { REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useDeleteRequest, useRequests } from '../../hooks/requests.js';
import '../../features/requests/requests.css';

export interface TimelineStep {
  label: string;
  done: boolean;
  at?: string;
}

/** Requested → decided (approved/declined/failed) → available. */
export function requestTimeline(r: MediaRequest): TimelineStep[] {
  const steps: TimelineStep[] = [{ label: 'Requested', done: true, at: r.createdAt }];
  if (r.status === 'declined') return [...steps, { label: 'Declined', done: true, at: r.updatedAt }];
  if (r.status === 'failed') return [...steps, { label: 'Approved', done: true }, { label: 'Failed to add', done: true, at: r.updatedAt }];
  const approved = r.status !== 'pending';
  steps.push(approved ? { label: 'Approved', done: true, at: r.updatedAt } : { label: 'Awaiting approval', done: false });
  const available = r.mediaStatus === 'available' || r.status === 'completed';
  steps.push({ label: r.mediaStatus === 'partiallyAvailable' ? 'Partially available' : 'Available', done: available || r.mediaStatus === 'partiallyAvailable' });
  return steps;
}

export function MyRequestsPage() {
  const { userId } = usePermissions();
  const list = useRequests({ requestedBy: userId ?? undefined, take: 100, sort: 'added', sortDirection: 'desc' }, userId !== null);

  return (
    <Page title="My requests" actions={<Link className="btn btn-primary btn-md" to="/discover">Discover something</Link>}>
      {userId === null ? (
        <Card>
          <EmptyState title="Not signed in as a user">
            <p className="muted">My requests lists the requests of a signed-in account.</p>
          </EmptyState>
        </Card>
      ) : list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.results.length === 0 ? (
        <Card>
          <EmptyState title="You have not requested anything yet" />
        </Card>
      ) : (
        <ol className="timeline">
          {list.data.results.map((r) => (
            <MyRequestItem key={r.id} r={r} />
          ))}
        </ol>
      )}
    </Page>
  );
}

function MyRequestItem({ r }: { r: MediaRequest }) {
  const del = useDeleteRequest();
  const [confirm, setConfirm] = useState(false);
  const meta = REQUEST_STATUS_META[r.status];
  return (
    <li className="timeline-item" aria-label={r.mediaTitle}>
      <div style={{ width: 64 }}>
        <Poster url={r.mediaPoster ?? undefined} title={r.mediaTitle} />
      </div>
      <div className="timeline-body">
        <div className="row">
          <Link {...titleLink(r.type, r.mediaTmdbId)}>
            <strong>{r.mediaTitle}</strong>
          </Link>
          {r.mediaYear ? <span className="muted">({r.mediaYear})</span> : null}
          {r.is4k ? <Badge tone="info">4K</Badge> : null}
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        {r.seasons.length ? <span className="muted small">{seasonsLabel(r.seasons)}</span> : null}
        <ol className="timeline-steps" aria-label="Progress">
          {requestTimeline(r).map((s) => (
            <li key={s.label} className={s.done ? 'timeline-step-done' : undefined}>
              {s.done ? '●' : '○'} {s.label}
              {s.at ? ` · ${formatDateTime(s.at)}` : ''}
            </li>
          ))}
        </ol>
        {r.declineReason ? <span className="muted small">Reason: {r.declineReason}</span> : null}
      </div>
      {r.status === 'pending' && r.canRemove ? (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Cancel request
          </Button>
          <ConfirmDialog
            open={confirm}
            title={`Cancel your request for ${r.mediaTitle}?`}
            confirmLabel="Cancel request"
            onCancel={() => setConfirm(false)}
            onConfirm={async () => {
              await del.mutateAsync(r.id);
              setConfirm(false);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
