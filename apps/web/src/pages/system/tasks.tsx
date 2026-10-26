import { Card } from '../../components/card.js';
import { Page } from '../../components/page.js';
import { RecentRunsTable } from '../../features/jobs/recent-runs-table.js';
import { ScheduledJobsTable } from '../../features/jobs/scheduled-jobs-table.js';

export function SystemTasksPage() {
  return (
    <Page title="Tasks">
      <div className="stack">
        <Card title="Scheduled" flush>
          <ScheduledJobsTable />
        </Card>
        <Card title="History" flush>
          <RecentRunsTable />
        </Card>
      </div>
    </Page>
  );
}
