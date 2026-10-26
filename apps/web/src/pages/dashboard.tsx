import { Link } from '@tanstack/react-router';
import { Card } from '../components/card.js';
import { Page } from '../components/page.js';
import { HealthCard } from '../features/health/health-checks.js';
import { RecentRunsTable } from '../features/jobs/recent-runs-table.js';
import { ScheduledJobsTable } from '../features/jobs/scheduled-jobs-table.js';
import { useSystemStatus } from '../hooks/system.js';
import { useVpnStatus } from '../hooks/vpn.js';
import { formatUptime } from '../lib/format.js';
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

export function DashboardPage() {
  const status = useSystemStatus();
  return (
    <Page
      title="Dashboard"
      subtitle={status.data ? `v${status.data.version} · up ${formatUptime(status.data.uptimeSeconds)}` : 'connecting…'}
    >
      <div className="grid">
        <HealthCard />
        <VpnCard />
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
