import { EmptyState, KeyValue, Pane } from '../../arclight/index.js';
import { useSystemStatus } from '../../hooks/system.js';
import { SystemHeader } from './system-header.js';

/** System → Updates. The api has no update feed yet; this shows the running version. */
export function SystemUpdatesPage() {
  const status = useSystemStatus();
  return (
    <>
      <SystemHeader title="Updates" />
      <div className="sys-cols">
        <Pane title="Installed">
          <KeyValue
            items={[
              { label: 'Version', value: status.data?.version ?? '—' },
              { label: 'Docker', value: status.data ? (status.data.isDocker ? 'Yes' : 'No') : '—' },
            ]}
          />
        </Pane>
        <Pane title="Changelog">
          <EmptyState title="No update information yet">Arclight doesn't check for new versions yet. Update the container or package to upgrade.</EmptyState>
        </Pane>
      </div>
    </>
  );
}
