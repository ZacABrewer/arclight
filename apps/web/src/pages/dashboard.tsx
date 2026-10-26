import { Link } from '@tanstack/react-router';
import { Card } from '../components/card.js';
import { Page } from '../components/page.js';
import { HealthCard } from '../features/health/health-checks.js';
import { PendingRequestsCard } from '../features/requests/pending-requests-card.js';
import { RecentRunsTable } from '../features/jobs/recent-runs-table.js';
import { ScheduledJobsTable } from '../features/jobs/scheduled-jobs-table.js';
import { useSystemStatus } from '../hooks/system.js';
import { useTorrentStatus } from '../hooks/torrent.js';
import { useVpnStatus } from '../hooks/vpn.js';
import { formatRate, formatUptime } from '../lib/format.js';
import { engineBadge, LOCKDOWN_EXPLANATION } from './settings/torrent.js';
import { vpnBadge, VpnStatusFields } from './settings/vpn.js';

function VpnCard() {
  const vpn = useVpnStatus();
  // Hidden until the api answers and VPN monitoring is on.
  if (!vpn.data?.enabled) return null;
  return (
    <Card
      title={<>VPN {vpnBadge(vpn.data)}</>}
      actions={
        <Link to="/settings/vpn" className="link-subtle">
          Settings
        </Link>
      }
    >
      <VpnStatusFields status={vpn.data} />
    </Card>
  );
}

/** Built-in engine rates; hidden when the engine is disabled or the status request fails. */
function TorrentEngineCard() {
  const status = useTorrentStatus();
  const s = status.data;
  if (!s || status.isError || s.state === 'disabled') return null;
  const active = s.torrents.downloading + s.torrents.seeding;
  return (
    <Card
      title={<>Torrent engine {engineBadge(s.state)}</>}
      actions={
        <Link to="/settings/torrent" className="link-subtle">
          Settings
        </Link>
      }
    >
      <dl className="fields" aria-label="Torrent engine activity">
        <div className="fields-row">
          <dt>Download</dt>
          <dd>{formatRate(s.downloadRate)}</dd>
        </div>
        <div className="fields-row">
          <dt>Upload</dt>
          <dd>{formatRate(s.uploadRate)}</dd>
        </div>
        <div className="fields-row">
          <dt>Active torrents</dt>
          <dd>
            {active} ({s.torrents.downloading} downloading, {s.torrents.seeding} seeding) of {s.torrents.total}
          </dd>
        </div>
        <div className="fields-row">
          <dt>Peers</dt>
          <dd>{s.peers}</dd>
        </div>
        {s.state === 'lockdown' ? (
          <div className="fields-row">
            <dt>Lockdown</dt>
            <dd className="field-error-text">{LOCKDOWN_EXPLANATION}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

export function DashboardPage() {
  const status = useSystemStatus();
  return (
    <Page
      title="Dashboard"
      subtitle={status.data ? `v${status.data.version} · up ${formatUptime(status.data.uptimeSeconds)}` : 'connecting…'}
    >
      <div className="grid">
        <HealthCard />
        <PendingRequestsCard />
        <VpnCard />
        <TorrentEngineCard />
        <Card title="Scheduled jobs" flush>
          <ScheduledJobsTable />
        </Card>
        <Card
          title="Recent runs"
          flush
          actions={
            <Link to="/system/tasks" className="link-subtle">
              All tasks
            </Link>
          }
        >
          <RecentRunsTable limit={10} />
        </Card>
      </div>
    </Page>
  );
}
