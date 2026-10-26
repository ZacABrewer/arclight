import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission } from '@arclight/shared';
import { Button, EmptyState, ErrorBlock, PageHeader, Pane, SectionLabel, Skeleton, StatusChip, Trail } from '../arclight/index.js';
import { useAuth } from '../auth/auth-context.js';
import { usePermissions } from '../features/requests/status.js';
import { useQueue } from '../hooks/activity.js';
import { useCalendar } from '../hooks/library-calendar.js';
import { useRootFolders } from '../hooks/library.js';
import { useApproveRequest, useRequestCount, useRequests } from '../hooks/requests.js';
import { useHealth } from '../hooks/system.js';
import { useTorrentStatus } from '../hooks/torrent.js';
import { useVpnStatus } from '../hooks/vpn.js';
import { attentionChecks, queueRow, storageRows, upcomingRows, vpnSummary } from './dashboard-model.js';
import { formatClock, formatDay, formatRate } from './system/format.js';

// Page 01. Two hero panes (chamfer tl / br) frame the open centre where the backdrop spire
// stands; two decorative traces lead from them toward it. Queue and Requests sit below.
// The engine card and job tables moved to System → Status / Tasks.

/** Start of the current hour, fixed for the page's lifetime so the calendar key is stable. */
function useWindowStart(): Date {
  const [start] = useState(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d;
  });
  return start;
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function NextDayPane() {
  const start = useWindowStart();
  const end = new Date(start.getTime() + 25 * 3_600_000);
  const calendar = useCalendar(start.toISOString(), end.toISOString(), false);
  const rows = upcomingRows(calendar.data, new Date(Math.max(Date.now() - 3_600_000, start.getTime())));
  return (
    <Pane
      chamfer="tl"
      small={false}
      className="dash-hero dash-hero--next"
      title="Next 24 hours"
      actions={
        <Link to="/calendar" className="al-link">
          Calendar
        </Link>
      }
    >
      {calendar.isLoading ? (
        <Skeleton lines={3} />
      ) : calendar.isError ? (
        <ErrorBlock title="Couldn't load the calendar" onRetry={() => void calendar.refetch()} />
      ) : calendar.data === null ? (
        <p className="dash-muted">The calendar is not available on this server.</p>
      ) : rows.length === 0 ? (
        <p className="dash-muted">Nothing airs in the next 24 hours.</p>
      ) : (
        <ul className="dash-upcoming">
          {rows.slice(0, 5).map((r) => (
            <li key={r.key}>
              <span className="al-num dash-upcoming__time">{r.time}</span>
              <Link {...r.href} className="dash-upcoming__body">
                <span className="dash-upcoming__title">{r.title}</span>
                <span className="dash-upcoming__detail">{r.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function VpnSection() {
  const vpn = useVpnStatus();
  const summary = vpnSummary(vpn.data);
  return (
    <div className="dash-status__block">
      <SectionLabel tone={summary?.state === 'down' ? 'warn' : 'default'}>VPN</SectionLabel>
      {vpn.isLoading ? (
        <Skeleton lines={2} />
      ) : !summary ? (
        <p className="dash-muted">VPN status is unavailable.</p>
      ) : summary.state === 'off' ? (
        <>
          <div className="dash-status__headline">VPN off</div>
          <div className="dash-muted">
            Downloads use your normal connection.{' '}
            <Link to="/settings/vpn" className="al-link">
              Set up
            </Link>
          </div>
        </>
      ) : (
        <>
          <div className="dash-status__headline">{summary.headline}</div>
          {summary.state === 'down' ? (
            <div className="dash-warn">{summary.cause}</div>
          ) : (
            <div className="dash-muted">
              {summary.port !== undefined ? (
                <>
                  Port <span className="al-num dash-data">{summary.port}</span> forwarded
                </>
              ) : (
                'Connected'
              )}
              {summary.uptime ? (
                <>
                  {' '}
                  · up <span className="al-num dash-data">{summary.uptime}</span>
                </>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StorageSection() {
  const folders = useRootFolders();
  const rows = storageRows(folders.data);
  return (
    <div className="dash-status__block">
      <SectionLabel>Storage</SectionLabel>
      {folders.isLoading ? (
        <Skeleton lines={2} />
      ) : folders.isError ? (
        <p className="dash-muted">Couldn't read root folders.</p>
      ) : rows.length === 0 ? (
        <p className="dash-muted">
          No root folders yet.{' '}
          <Link to="/settings/mediamanagement" className="al-link">
            Add one
          </Link>
        </p>
      ) : (
        <ul className="dash-storage">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="al-num dash-storage__path">{r.path}</span>
              <span className="al-num" data-tone={r.low ? 'warn' : undefined}>
                {r.free}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssuesSection() {
  const health = useHealth();
  const issues = attentionChecks(health.data?.checks);
  return (
    <div className="dash-status__block">
      <SectionLabel tone={issues.length ? 'warn' : 'default'} count={health.data ? issues.length : undefined}>
        Issues
      </SectionLabel>
      {health.isLoading ? (
        <Skeleton lines={2} />
      ) : health.isError ? (
        <p className="dash-muted">Couldn't run health checks.</p>
      ) : issues.length === 0 ? (
        <p className="dash-muted">No issues.</p>
      ) : (
        <ul className="dash-issues">
          {issues.slice(0, 3).map((c) => (
            <li key={`${c.source}:${c.message}`}>
              {c.message}{' '}
              <Link to="/system/health" className="al-link">
                {c.status === 'error' ? 'Fix' : 'Details'}
              </Link>
            </li>
          ))}
          {issues.length > 3 ? (
            <li>
              <Link to="/system/health" className="al-link">
                {issues.length - 3} more
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function StatusPane() {
  return (
    <Pane chamfer="br" className="dash-hero dash-hero--status" bare>
      <VpnSection />
      <StorageSection />
      <IssuesSection />
    </Pane>
  );
}

function QueuePane() {
  const queue = useQueue({ page: 1, pageSize: 5 });
  const engine = useTorrentStatus();
  const rates = engine.data && !engine.isError && engine.data.state !== 'disabled' ? engine.data : undefined;
  const rows = (queue.data?.records ?? []).map(queueRow);
  return (
    <Pane
      className="dash-queue"
      flush
      title={
        <div className="dash-queue__head">
          <SectionLabel as="h2">Queue</SectionLabel>
          {rates ? (
            <>
              <span>
                Down <span className="al-num dash-data--strong">{formatRate(rates.downloadRate)}</span>
              </span>
              <span>
                Up <span className="al-num dash-data">{formatRate(rates.uploadRate)}</span>
              </span>
            </>
          ) : null}
        </div>
      }
      actions={
        <Link to="/activity/queue" className="al-link">
          Activity
        </Link>
      }
    >
      {queue.isLoading ? (
        <div className="dash-pad">
          <Skeleton lines={4} />
        </div>
      ) : queue.isError ? (
        <div className="dash-pad">
          <ErrorBlock title="Couldn't load the queue" onRetry={() => void queue.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <div className="dash-pad">
          <EmptyState title="Queue is empty">Grabbed releases show their progress here.</EmptyState>
        </div>
      ) : (
        <ul className="dash-queue__rows">
          {rows.map((r) => (
            <li key={r.key} className="dash-queue__row" data-attention={r.trail === 'failed' || r.trail === 'stalled' ? 'true' : undefined}>
              <div className="dash-queue__title">
                <span className="dash-queue__name" title={r.title}>
                  {r.title}
                </span>
                <span className="dash-queue__detail">
                  {r.chip ? (
                    r.chip.status === 'failed' || r.chip.status === 'stalled' ? (
                      <StatusChip status={r.chip.status} cause={r.chip.cause ?? ''} />
                    ) : (
                      <StatusChip status={r.chip.status} />
                    )
                  ) : null}
                  {r.detail}
                </span>
              </div>
              <Trail value={r.pct} state={r.trail} label={`${r.title} progress`} />
              <div className="dash-queue__pct">
                <span className="al-num">{r.pctLabel}</span>
                <span className="al-num dash-queue__eta">{r.eta}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function RequestsPane() {
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const count = useRequestCount(manage);
  const list = useRequests({ filter: 'pending', take: 4, sort: 'added', sortDirection: 'asc' }, manage);
  const approve = useApproveRequest();
  if (!manage) {
    return (
      <Pane title="Requests" className="dash-requests">
        <p className="dash-muted">
          Ask for a series or movie and follow it here.{' '}
          <Link to="/requests/mine" className="al-link">
            My requests
          </Link>
        </p>
      </Pane>
    );
  }
  const items = list.data?.results ?? [];
  return (
    <Pane
      className="dash-requests"
      title={<SectionLabel as="h2" count={count.data?.pending}>Requests</SectionLabel>}
      actions={
        <Link to="/requests" className="al-link">
          Review all
        </Link>
      }
    >
      {list.isLoading ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load requests" onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="dash-muted">No requests are waiting for approval.</p>
      ) : (
        <ul className="dash-requests__rows">
          {items.map((r) => (
            <li key={r.id}>
              <div className="dash-requests__body">
                <span className="dash-requests__title">{r.mediaTitle}</span>
                <span className="dash-muted">
                  {r.type === 'movie' ? 'Movie' : 'Series'}
                  {r.is4k ? ' · 4K' : ''} · {r.requestedBy.displayName ?? r.requestedBy.username}
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Approve ${r.mediaTitle}`}
                loading={approve.isPending && approve.variables?.id === r.id}
                onClick={() => approve.mutate({ id: r.id })}
              >
                Approve
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

/** Two decorative traces from the hero panes toward the spire (kit Page 01 geometry). */
function Traces() {
  return (
    <>
      <svg className="dash-trace dash-trace--left" width="236" height="98" viewBox="0 0 236 98" aria-hidden="true" focusable="false">
        <polyline points="0,0.5 138,0.5 234,96.5" />
      </svg>
      <svg className="dash-trace dash-trace--right" width="276" height="62" viewBox="0 0 276 62" aria-hidden="true" focusable="false">
        <polyline points="275,0.5 117,0.5 57,60.5 1,60.5" />
      </svg>
    </>
  );
}

export function DashboardPage() {
  const { isAdmin } = useAuth();
  const now = useNow();
  useEffect(() => {
    document.title = 'Dashboard · Arclight';
  }, []);

  return (
    <div className="dash">
      <PageHeader
        index="00"
        title="Dashboard"
        className="al-page-header--baseline"
        actions={
          <span className="dash-date">
            {formatDay(now)} · <time className="al-num" dateTime={now.toISOString()}>{formatClock(now)}</time>
          </span>
        }
      />
      <div className="dash-heroes">
        <NextDayPane />
        {isAdmin ? (
          <>
            <Traces />
            <StatusPane />
          </>
        ) : null}
      </div>
      <div className="dash-lower" data-admin={isAdmin || undefined}>
        {isAdmin ? <QueuePane /> : null}
        <RequestsPane />
      </div>
    </div>
  );
}
