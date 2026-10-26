import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Permission, type MediaRequest } from '@arclight/shared';
import { ApiError } from '../../api/client.js';
import { Banner, Button, EmptyState, KeyValue, PageHeader, Pane } from '../../arclight/index.js';
import { Loading, QueryError } from '../../components/media/media-kit.js';
import { REQUEST_STATUS_META, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useRequest } from '../../hooks/requests.js';
import { formatDateTime } from '../../lib/ui-preferences.js';
import { ApproveDialog } from './approve-dialog.js';
import { DeclineDialog, RequestStatusCell, RequestTitle } from './requests-page.js';
import '../../components/media/media-kit.css';
import { t } from '../../i18n/index.js';

// /requests/:id — where notification links land. `?action=approve` opens the approve dialog
// and `?action=decline` the decline dialog, once, for someone who may manage requests and
// only while the request is still pending; otherwise the page says why nothing happened.

export type RequestDeepLinkAction = 'approve' | 'decline';

/** `?action=approve|decline` on /requests/$id (notification deep links). */
export function parseRequestActionSearch(search: Record<string, unknown>): { action?: RequestDeepLinkAction } {
  return search.action === 'approve' || search.action === 'decline' ? { action: search.action } : {};
}

/** Why a deep-link action cannot run, or null when it can. */
export function deepLinkBlocker(r: Pick<MediaRequest, 'status'>, action: RequestDeepLinkAction | undefined, manage: boolean): string | null {
  if (!action) return null;
  if (!manage) return t('requests.requestDeepLink.youDoNotHavePermission');
  if (r.status !== 'pending') return t('requests.requestDeepLink.thisRequestIsAlreadyLabel', { label: REQUEST_STATUS_META[r.status].label.toLowerCase(), action });
  return null;
}

export function RequestDeepLinkPage() {
  const { id } = useParams({ from: '/requests/$id' });
  const search = useSearch({ from: '/requests/$id' });
  const navigate = useNavigate();
  const requestId = Number(id);
  const query = useRequest(Number.isInteger(requestId) ? requestId : 0);
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const [dialog, setDialog] = useState<RequestDeepLinkAction | null>(null);
  const [consumed, setConsumed] = useState(false);

  useEffect(() => {
    document.title = t('requests.requestDeepLink.requestArclight');
  }, []);

  const r = query.data;
  useEffect(() => {
    if (!r || consumed || !search.action) return;
    setConsumed(true);
    if (deepLinkBlocker(r, search.action, manage) === null) setDialog(search.action);
  }, [r, consumed, search.action, manage]);

  const close = () => {
    setDialog(null);
    void navigate({ to: '/requests/$id', params: { id }, search: {}, replace: true });
  };

  const header = (
    <PageHeader
      index="03"
      title={t('common.request')}
      subtitle={r?.mediaTitle}
      actions={
        <Link className="al-btn al-btn--secondary" to="/requests">
          {t('requests.requestDeepLink.allRequests')}
        </Link>
      }
    />
  );

  if (query.isPending && requestId > 0) {
    return (
      <>
        {header}
        <Loading lines={3} />
      </>
    );
  }
  if (!r) {
    const missing = !(requestId > 0) || (query.error instanceof ApiError && query.error.status === 404);
    return (
      <>
        {header}
        {missing ? (
          <EmptyState title={t('requests.requestDeepLink.requestNotFound')}>{t('requests.requestDeepLink.itMayHaveBeenDeleted')}</EmptyState>
        ) : (
          <QueryError error={query.error} onRetry={() => void query.refetch()} title={t('requests.requestDeepLink.couldNotLoadThisRequest')} />
        )}
      </>
    );
  }

  const blocker = consumed ? deepLinkBlocker(r, search.action, manage) : null;
  const seasons = seasonsLabel(r.seasons);
  return (
    <>
      {header}
      <div className="mk-stack">
        {blocker ? <Banner tone="info">{blocker}</Banner> : null}
        <Pane
          title={t('common.request')}
          aria-label={t('requests.requestDeepLink.requestDetails')}
          actions={
            manage && r.status === 'pending' ? (
              <>
                <Button size="sm" onClick={() => setDialog('approve')}>
                  {t('common.approve')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDialog('decline')}>
                  {t('requests.requestDeepLink.decline')}
                </Button>
              </>
            ) : null
          }
        >
          <div className="mk-stack-sm" style={{ gap: 16 }}>
            <RequestTitle r={r} />
            <RequestStatusCell r={r} />
            <KeyValue
              items={[
                { label: t('common.requestedBy'), value: r.requestedBy.username, mono: false },
                { label: t('common.requested'), value: formatDateTime(r.createdAt) },
                ...(seasons ? [{ label: t('common.seasons'), value: seasons }] : []),
                ...(r.modifiedBy ? [{ label: t('requests.requestDeepLink.handledBy'), value: r.modifiedBy.username, mono: false }] : []),
              ]}
            />
          </div>
        </Pane>
      </div>
      {dialog === 'approve' ? <ApproveDialog request={r} onClose={close} /> : null}
      {dialog === 'decline' ? <DeclineDialog request={r} onClose={close} /> : null}
    </>
  );
}
