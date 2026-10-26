import type { ReactNode } from 'react';
import { Badge } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { useSystemStatus } from '../../hooks/system.js';
import { formatDateTime, formatUptime } from '../../lib/format.js';

function Fields({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="fields">
      {rows.map(([label, value]) => (
        <div key={label} className="fields-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SystemStatusPage() {
  const status = useSystemStatus();
  return (
    <Page title="Status">
      {status.isPending ? (
        <LoadingBlock />
      ) : status.isError ? (
        <ErrorView error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="grid">
          <Card title="About">
            <Fields
              rows={[
                ['Version', status.data.version],
                ['Started', formatDateTime(status.data.startTime)],
                ['Uptime', formatUptime(status.data.uptimeSeconds)],
                ['Docker', status.data.isDocker ? <Badge tone="info">yes</Badge> : <Badge>no</Badge>],
              ]}
            />
          </Card>
          <Card title="Runtime">
            <Fields
              rows={[
                ['Node', status.data.runtime.node],
                ['Platform', status.data.runtime.platform],
                ['Architecture', status.data.runtime.arch],
              ]}
            />
          </Card>
          <Card title="Paths">
            <Fields
              rows={[
                ['Config', <code key="c">{status.data.paths.config}</code>],
                ['Database', <code key="d">{status.data.paths.database}</code>],
                ['Logs', <code key="l">{status.data.paths.logs}</code>],
              ]}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
