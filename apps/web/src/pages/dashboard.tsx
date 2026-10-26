import { Link } from '@tanstack/react-router';
import { Card } from '../components/card.js';
import { Page } from '../components/page.js';
import { HealthCard } from '../features/health/health-checks.js';
import { RecentRunsTable } from '../features/jobs/recent-runs-table.js';
import { ScheduledJobsTable } from '../features/jobs/scheduled-jobs-table.js';
import { useSystemStatus } from '../hooks/system.js';
import { formatUptime } from '../lib/format.js';

export function DashboardPage() {
  const status = useSystemStatus();
  return (
    <Page
      title="Dashboard"
      subtitle={status.data ? `v${status.data.version} · up ${formatUptime(status.data.uptimeSeconds)}` : 'connecting…'}
    >
      <div className="grid">
        <HealthCard />
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
