import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission, type MediaRequest } from '@media-tron/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { useApproveRequest, useRequestCount, useRequests } from '../../hooks/requests.js';
import { DeclineDialog, RequestTitle } from '../../pages/requests/requests-page.js';
import { seasonsLabel, usePermissions } from './status.js';

/** Dashboard card: pending requests with quick approve/decline. Managers only. */
export function PendingRequestsCard() {
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const count = useRequestCount(manage);
  const list = useRequests({ filter: 'pending', take: 5, sort: 'added', sortDirection: 'asc' }, manage);
  if (!manage || count.isError) return null;

  return (
    <Card
      title={
        <>
          Requests awaiting approval {count.data ? <Badge tone={count.data.pending ? 'warning' : 'neutral'}>{count.data.pending}</Badge> : null}
        </>
      }
      flush
      actions={
        <Link to="/requests" className="link-subtle">
          All requests
        </Link>
      }
    >
      {list.data && list.data.results.length === 0 ? (
        <EmptyState title="Nothing waiting" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {(list.data?.results ?? []).map((r) => (
                <PendingRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PendingRow({ r }: { r: MediaRequest }) {
  const approve = useApproveRequest();
  const [declining, setDeclining] = useState(false);
  return (
    <tr>
      <td>
        <RequestTitle r={r} />
      </td>
      <td className="muted small">
        {r.requestedBy.displayName ?? r.requestedBy.username}
        {r.seasons.length ? ` · ${seasonsLabel(r.seasons)}` : ''}
      </td>
      <td className="align-right">
        <div className="row row-end">
          <Button size="sm" variant="primary" aria-label={`Approve ${r.mediaTitle}`} loading={approve.isPending} onClick={() => approve.mutate({ id: r.id })}>
            Approve
          </Button>
          <Button size="sm" variant="danger" aria-label={`Decline ${r.mediaTitle}`} onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
        {declining ? <DeclineDialog request={r} onClose={() => setDeclining(false)} /> : null}
      </td>
    </tr>
  );
}
