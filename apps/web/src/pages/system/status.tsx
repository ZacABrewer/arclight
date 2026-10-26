import type { Indexer, TorrentEngineState } from '@arclight/shared';
import { Link } from '@tanstack/react-router';
import { Chip, ErrorBlock, KeyValue, Pane, ProtocolBadge, Skeleton, type ChipTone, type KeyValueItem } from '../../arclight/index.js';
import { useIndexerList } from '../../hooks/indexers.js';
import { useSystemStatus } from '../../hooks/system.js';
import { useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate, formatSpan, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';

const ENGINE_LABEL: Record<TorrentEngineState, [string, ChipTone]> = {
  running: ['Running', 'accent'],
  starting: ['Starting', 'neutral'],
  lockdown: ['Lockdown', 'warn'],
  error: ['Failed', 'danger'],
  disabled: ['Disabled', 'muted'],
};

/** The built-in engine's live numbers (moved here from the old dashboard card). */
function EnginePane() {
  const engine = useTorrentStatus();
  const s = engine.data;
  if (engine.isError || !s) return null;
  const [label, tone] = ENGINE_LABEL[s.state];
  const items: KeyValueItem[] = [{ label: 'State', value: <Chip tone={tone}>{label}</Chip>, mono: false }];
  if (s.state !== 'disabled') {
    items.push(
      { label: 'Download', value: formatRate(s.downloadRate) },
      { label: 'Upload', value: formatRate(s.uploadRate) },
      { label: 'Torrents', value: `${s.torrents.downloading} downloading · ${s.torrents.seeding} seeding · ${s.torrents.total} total` },
      { label: 'Peers', value: String(s.peers) },
    );
  }
  if (s.state === 'lockdown') {
    items.push({ label: 'Cause', value: `VPN down. Torrents are paused and bound to 127.0.0.1${s.lockdownReason ? ` (${s.lockdownReason})` : ''}.`, mono: false });
  }
  return (
    <Pane
      title="Torrent engine"
      actions={
        <Link to="/settings/torrent" className="al-link">
          Settings
        </Link>
      }
    >
      <KeyValue items={items} />
    </Pane>
  );
}

/** Indexer health as a chip: paused until a time, recently failing, or OK. */
export function indexerChip(i: Pick<Indexer, 'status'>, now: number = Date.now()): { tone: ChipTone; label: string } {
  const st = i.status;
  const till = st?.disabledTill ? new Date(st.disabledTill).getTime() : NaN;
  if (Number.isFinite(till) && till > now) return { tone: 'warn', label: `Paused · retry in ${formatSpan(till - now)}` };
  if (st && st.failureCount > 0) return { tone: 'warn', label: `${st.failureCount} recent ${st.failureCount === 1 ? 'failure' : 'failures'}` };
  return { tone: 'accent', label: 'OK' };
}

function IndexersPane() {
  const list = useIndexerList();
  if (list.isError) return null;
  const rows = list.data ?? [];
  return (
    <Pane
      title="Indexers"
      actions={
        <Link to="/indexers" className="al-link">
          Manage
        </Link>
      }
    >
      {list.isLoading ? (
        <Skeleton lines={3} />
      ) : rows.length === 0 ? (
        <p className="sys-muted">No indexers yet.</p>
      ) : (
        <ul className="sys-list">
          {rows.map((i) => {
            const chip = indexerChip(i);
            return (
              <li key={i.id}>
                <span className="sys-list__name">{i.name}</span>
                <ProtocolBadge protocol={i.protocol} />
                <Chip tone={chip.tone}>{chip.label}</Chip>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}

export function SystemStatusPage() {
  const status = useSystemStatus();
  return (
    <>
      <SystemHeader title="Status" />
      {status.isPending ? (
        <Pane>
          <Skeleton lines={5} />
        </Pane>
      ) : status.isError ? (
        <ErrorBlock title="Couldn't read the system status" onRetry={() => void status.refetch()} />
      ) : (
        <div className="sys-cols">
          <Pane title="About">
            <KeyValue
              items={[
                { label: 'Version', value: status.data.version },
                { label: 'Started', value: formatStamp(status.data.startTime) },
                { label: 'Uptime', value: formatSpan(status.data.uptimeSeconds * 1000) },
                { label: 'Docker', value: status.data.isDocker ? 'Yes' : 'No' },
              ]}
            />
          </Pane>
          <Pane title="Runtime">
            <KeyValue
              items={[
                { label: 'Node', value: status.data.runtime.node },
                { label: 'Platform', value: status.data.runtime.platform },
                { label: 'Architecture', value: status.data.runtime.arch },
              ]}
            />
          </Pane>
          <Pane title="Paths">
            <KeyValue
              items={[
                { label: 'Config', value: status.data.paths.config },
                { label: 'Database', value: status.data.paths.database },
                { label: 'Logs', value: status.data.paths.logs },
              ]}
            />
          </Pane>
          <EnginePane />
          <IndexersPane />
        </div>
      )}
    </>
  );
}
