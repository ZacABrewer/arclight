import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { Page } from '../../components/page.js';
import { useSystemStatus } from '../../hooks/system.js';

/**
 * Log viewer. TODO(contract): there is no log endpoint yet; this renders the table frame and
 * points at the log folder. Wire it to a paged /log route (time, level, logger, message) when
 * one exists.
 */
export function SystemLogsPage() {
  const status = useSystemStatus();
  return (
    <Page title="Logs">
      <Card flush>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Log entries</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Component</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <EmptyState title="Log viewer not available yet">
          <p className="muted">
            Logs are written to {status.data ? <code>{status.data.paths.logs}</code> : 'the log folder'}. An in-app viewer arrives with the
            log api.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
