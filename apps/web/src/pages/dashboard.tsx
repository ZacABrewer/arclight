import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission } from '@arclight/shared';
import { Button, EmptyState, ErrorBlock, PageHeader, Pane, SectionLabel, Skeleton, StatusChip, Trail } from '../arclight/index.js';
import { useAuth } from '../auth/auth-context.js';
import { usePermissions } from '../features/requests/status.js';
import { useQueue } from '../hooks/activity.js';
import { useGenerateSummary, useLatestSummary } from '../hooks/alerts.js';
import { useCalendar } from '../hooks/library-calendar.js';
import { useRootFolders } from '../hooks/library.js';
import { useApproveRequest, useRequestCount, useRequests } from '../hooks/requests.js';
import { useHealth } from '../hooks/system.js';
import { useTorrentStatus } from '../hooks/torrent.js';
import { useVpnStatus } from '../hooks/vpn.js';
import { attentionChecks, queueRow, storageRows, summaryCard, upcomingRows, vpnSummary } from './dashboard-model.js';
import { formatClock, formatDay, formatRate } from './system/format.js';
import { formatDateTime, t } from '../i18n/index.js';

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
    const item = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(item);
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
      title={t('dashboard.next24Hours')}
      actions={
        <Link to="/calendar" className="al-link">
          {t('common.calendar')}
        </Link>
      }
    >
      {calendar.isLoading ? (
        <Skeleton lines={3} />
      ) : calendar.isError ? (
        <ErrorBlock title={t('dashboard.couldntLoadTheCalendar')} onRetry={() => void calendar.refetch()} />
      ) : calendar.data === null ? (
        <p className="dash-muted">{t('dashboard.theCalendarIsNotAvailable')}</p>
      ) : rows.length === 0 ? (
        <p className="dash-muted">{t('dashboard.nothingAirsInTheNext')}</p>
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
      <SectionLabel tone={summary?.state === 'down' ? 'warn' : 'default'}>{t('common.vpn')}</SectionLabel>
      {vpn.isLoading ? (
        <Skeleton lines={2} />
      ) : !summary ? (
        <p className="dash-muted">{t('dashboard.vpnStatusIsUnavailable')}</p>
      ) : summary.state === 'off' ? (
        <>
          <div className="dash-status__headline">{t('common.vpnOff')}</div>
          <div className="dash-muted">
            {t('dashboard.downloadsUseYourNormalConnection')}
            <Link to="/settings/vpn" className="al-link">
              {t('dashboard.setUp')}
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
                  {t('common.port')} <span className="al-num dash-data">{summary.port}</span> {t('dashboard.forwarded')}
                </>
              ) : (
                t('common.connected')
              )}
              {summary.uptime ? (
                <>
                  {t('dashboard.up')} <span className="al-num dash-data">{summary.uptime}</span>
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
      <SectionLabel>{t('dashboard.storage')}</SectionLabel>
      {folders.isLoading ? (
        <Skeleton lines={2} />
      ) : folders.isError ? (
        <p className="dash-muted">{t('dashboard.couldntReadRootFolders')}</p>
      ) : rows.length === 0 ? (
        <p className="dash-muted">
          {t('dashboard.noRootFoldersYet')}
          <Link to="/settings/mediamanagement" className="al-link">
            {t('dashboard.addOne')}
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
        {t('common.issues')}
      </SectionLabel>
      {health.isLoading ? (
        <Skeleton lines={2} />
      ) : health.isError ? (
        <p className="dash-muted">{t('dashboard.couldntRunHealthChecks')}</p>
      ) : issues.length === 0 ? (
        <p className="dash-muted">{t('dashboard.noIssues')}</p>
      ) : (
        <ul className="dash-issues">
          {issues.slice(0, 3).map((c) => (
            <li key={`${c.source}:${c.message}`}>
              {c.message}{' '}
              <Link to="/system/health" className="al-link">
                {c.status === 'error' ? t('common.fix') : t('common.details')}
              </Link>
            </li>
          ))}
          {issues.length > 3 ? (
            <li>
              <Link to="/system/health" className="al-link">
                {t('dashboard.valueMore', { value: issues.length - 3 })}
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
          <SectionLabel as="h2">{t('common.queue')}</SectionLabel>
          {rates ? (
            <>
              <span>
                {t('common.down')} <span className="al-num dash-data--strong">{formatRate(rates.downloadRate)}</span>
              </span>
              <span>
                {t('dashboard.up2')} <span className="al-num dash-data">{formatRate(rates.uploadRate)}</span>
              </span>
            </>
          ) : null}
        </div>
      }
      actions={
        <Link to="/activity/queue" className="al-link">
          {t('common.activity')}
        </Link>
      }
    >
      {queue.isLoading ? (
        <div className="dash-pad">
          <Skeleton lines={4} />
        </div>
      ) : queue.isError ? (
        <div className="dash-pad">
          <ErrorBlock title={t('dashboard.couldntLoadTheQueue')} onRetry={() => void queue.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <div className="dash-pad">
          <EmptyState title={t('dashboard.queueIsEmpty')}>{t('dashboard.grabbedReleasesShowTheirProgress')}</EmptyState>
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
              <Trail value={r.pct} state={r.trail} label={t('dashboard.titleProgress', { title: r.title })} />
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
      <Pane title={t('common.requests')} className="dash-requests">
        <p className="dash-muted">
          {t('dashboard.askForASeriesOr')}
          <Link to="/requests/mine" className="al-link">
            {t('common.myRequests')}
          </Link>
        </p>
      </Pane>
    );
  }
  const items = list.data?.results ?? [];
  return (
    <Pane
      className="dash-requests"
      title={<SectionLabel as="h2" count={count.data?.pending}>{t('common.requests')}</SectionLabel>}
      actions={
        <Link to="/requests" className="al-link">
          {t('dashboard.reviewAll')}
        </Link>
      }
    >
      {list.isLoading ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('dashboard.couldntLoadRequests')} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="dash-muted">{t('dashboard.noRequestsAreWaitingFor')}</p>
      ) : (
        <ul className="dash-requests__rows">
          {items.map((r) => (
            <li key={r.id}>
              <div className="dash-requests__body">
                <span className="dash-requests__title">{r.mediaTitle}</span>
                <span className="dash-muted">
                  {r.type === 'movie' ? t('common.movie') : t('common.series')}
                  {r.is4k ? t('dashboard.n4k') : ''} · {r.requestedBy.displayName ?? r.requestedBy.username}
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                aria-label={t('dashboard.approveMediatitle', { mediaTitle: r.mediaTitle })}
                loading={approve.isPending && approve.variables?.id === r.id}
                onClick={() => approve.mutate({ id: r.id })}
              >
                {t('common.approve')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

/** The latest daily summary in brief; "Build now" makes the first one. */
function SummaryPane() {
  const latest = useLatestSummary();
  const generate = useGenerateSummary();
  const card = latest.data ? summaryCard(latest.data) : null;
  return (
    <Pane
      className="dash-summary"
      title={t('dashboard.summary.title')}
      actions={
        <Link to="/activity/history" className="al-link">
          {t('common.history')}
        </Link>
      }
    >
      {latest.isLoading ? (
        <Skeleton lines={3} />
      ) : latest.isError ? (
        <ErrorBlock title={t('dashboard.summary.couldntLoad')} onRetry={() => void latest.refetch()} />
      ) : !card ? (
        <EmptyState
          title={t('dashboard.summary.noSummaryYet')}
          action={
            <Button size="sm" variant="secondary" loading={generate.isPending} onClick={() => generate.mutate(false)}>
              {t('dashboard.summary.buildNow')}
            </Button>
          }
        >
          {t('dashboard.summary.noSummaryHint')}
        </EmptyState>
      ) : (
        <div className="dash-summary__body">
          <p className="dash-muted">
            {t('dashboard.summary.built')}{' '}
            <time className="al-num dash-data" dateTime={card.generatedAt} title={formatDateTime(card.generatedAt)}>
              {card.generatedAgo}
            </time>
          </p>
          <dl className="dash-summary__counts">
            {card.counts.map((c) => (
              <div key={c.key} data-tone={c.warn ? 'warn' : undefined}>
                <dt>{c.label}</dt>
                <dd className="al-num">{c.value}</dd>
              </div>
            ))}
          </dl>
          <p className="dash-muted">
            {t('dashboard.summary.killSwitchPauses', { count: card.killSwitch.pauses })}
            {card.killSwitch.pauses > 0 ? (
              <>
                {' · '}
                <span className="al-num dash-data">{card.killSwitch.total}</span>
              </>
            ) : null}
          </p>
          {card.disk.length ? (
            <ul className="dash-storage">
              {card.disk.map((d) => (
                <li key={d.key}>
                  <span className="al-num dash-storage__path">{d.path}</span>
                  <span className="al-num">
                    {d.free} <span data-tone={d.shrinking ? 'warn' : undefined}>{d.change}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="dash-muted">
            {t('dashboard.summary.healthIssues', { count: card.healthIssues })} · {t('dashboard.summary.stillDownloading', { count: card.downloading })}
          </p>
        </div>
      )}
    </Pane>
  );
}

/** Kit Page 01 traces, in each trace box's own coordinates (the pulse rides the same polyline). */
const TRACES = [
  { side: 'left', width: 236, height: 98, points: '0,0.5 138,0.5 234,96.5', path: 'M0 0.5 L138 0.5 L234 96.5', delay: undefined },
  { side: 'right', width: 276, height: 62, points: '275,0.5 117,0.5 57,60.5 1,60.5', path: 'M275 0.5 L117 0.5 L57 60.5 L1 60.5', delay: '2.5s' },
] as const;

/**
 * Two decorative traces from the hero panes toward the spire (kit Page 01 geometry). v1.1: one
 * light packet travels each trace (`.al-trace-pulse` with `--path` set to the polyline), the
 * second 2.5 s behind the first.
 */
function Traces() {
  return (
    <>
      {TRACES.map((tr) => (
        <div key={tr.side} className={`dash-trace dash-trace--${tr.side}`} aria-hidden="true" data-testid="dash-trace">
          <svg width={tr.width} height={tr.height} viewBox={`0 0 ${tr.width} ${tr.height}`} focusable="false">
            <polyline points={tr.points} />
          </svg>
          <i className="al-trace-pulse" style={{ '--path': `path('${tr.path}')`, animationDelay: tr.delay } as CSSProperties} />
        </div>
      ))}
    </>
  );
}

export function DashboardPage() {
  const { isAdmin } = useAuth();
  const now = useNow();
  useEffect(() => {
    document.title = t('dashboard.dashboardArclight');
  }, []);

  return (
    <div className="dash">
      <PageHeader
        index="00"
        title={t('common.dashboard')}
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
        <div className="dash-side">
          <RequestsPane />
          {isAdmin ? <SummaryPane /> : null}
        </div>
      </div>
    </div>
  );
}
