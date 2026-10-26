import type { TorrentDetail, TorrentState } from '@media-tron/shared';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Select } from '../../components/form.js';
import { Modal } from '../../components/modal.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Tabs } from '../../components/tabs.js';
import { useTorrentAction, useTorrentDetail, useTorrentPriority } from '../../hooks/torrent.js';
import { formatDateTime, formatRate, formatSize } from '../../lib/format.js';
import { ProgressBar, formatEta } from './activity-shared.js';

// Detail drawer for queue rows downloaded by the built-in torrent engine. Polls
// GET /torrent/torrents?id=<downloadId> every 3 s while open.

const STATE_TONES: Record<TorrentState, BadgeTone> = {
  checking: 'info',
  downloadingMetadata: 'info',
  downloading: 'info',
  seeding: 'ok',
  paused: 'neutral',
  queued: 'neutral',
  error: 'error',
};

export const PRIORITY_OPTIONS = [
  { value: '0', label: 'Skip' },
  { value: '1', label: 'Normal' },
  { value: '4', label: 'High' },
  { value: '7', label: 'Max' },
];

/** Snap any engine priority (0..7) to the nearest option the select offers. */
export function priorityOption(priority: number): string {
  if (priority <= 0) return '0';
  if (priority >= 7) return '7';
  if (priority >= 4) return '4';
  return '1';
}

function Fields({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="fields">
      {rows.map(([label, value]) => (
        <div className="fields-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function General({ t }: { t: TorrentDetail }) {
  return (
    <Fields
      rows={[
        ['State', <Badge tone={STATE_TONES[t.state]}>{t.state}</Badge>],
        ...(t.error ? ([['Problem', <span className="field-error-text">{t.error}</span>]] as Array<[string, React.ReactNode]>) : []),
        ['Progress', <ProgressBar value={t.progress} tone={t.state === 'error' ? 'error' : t.state === 'seeding' ? 'ok' : 'info'} />],
        ['Size', `${formatSize(t.wantedBytes)} wanted of ${formatSize(t.totalBytes)} · ${formatSize(t.bytesLeft)} left`],
        ['Transferred', `${formatSize(t.downloaded)} down · ${formatSize(t.uploaded)} up`],
        ['Ratio', t.ratio.toFixed(2)],
        ['Rates', `${formatRate(t.downloadRate)} down · ${formatRate(t.uploadRate)} up`],
        ['ETA', t.etaSeconds === undefined ? '—' : formatEta(t.etaSeconds * 1000)],
        ['Peers', `${t.connectedPeers} connected (${t.connectedSeeds} seeds) · swarm ${t.swarmSeeds} seeds / ${t.swarmLeechers} leechers`],
        [
          'Pieces',
          <span className="stack-sm">
            <span>
              {t.piecesHave}/{t.pieceCount}
            </span>
            <ProgressBar value={t.pieceCount > 0 ? t.piecesHave / t.pieceCount : 0} />
          </span>,
        ],
        ['Save path', <code>{t.savePath}</code>],
        ['Category', t.category || '—'],
        ['Added', formatDateTime(t.addedAt)],
        ['Completed', t.completedAt ? formatDateTime(t.completedAt) : '—'],
        ['Private', t.private ? 'yes' : 'no'],
      ]}
    />
  );
}

function Peers({ t }: { t: TorrentDetail }) {
  if (t.peers.length === 0) return <EmptyState title="No peers connected" />;
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Peers">
        <thead>
          <tr>
            <th>Address</th>
            <th>Client</th>
            <th>Source</th>
            <th>Flags</th>
            <th className="align-right">Progress</th>
            <th className="align-right">Down</th>
            <th className="align-right">Up</th>
          </tr>
        </thead>
        <tbody>
          {t.peers.map((p) => (
            <tr key={p.address}>
              <td>
                <code>{p.address}</code>
              </td>
              <td>{p.client || '—'}</td>
              <td>
                {p.source}
                {p.incoming ? ' (in)' : ''}
              </td>
              <td>
                {[p.amInterested ? 'I' : null, p.peerChoking ? 'C' : null, p.peerInterested ? 'i' : null, p.amChoking ? 'c' : null, p.snubbed ? 'S' : null]
                  .filter(Boolean)
                  .join(' ') || '—'}
              </td>
              <td className="align-right">{Math.round(p.progress * 100)}%</td>
              <td className="align-right">{formatRate(p.downloadRate)}</td>
              <td className="align-right">{formatRate(p.uploadRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Trackers({ t }: { t: TorrentDetail }) {
  if (t.trackers.length === 0) return <EmptyState title="No trackers">Trackerless (DHT / PEX only).</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Trackers">
        <thead>
          <tr>
            <th>URL</th>
            <th>Tier</th>
            <th>State</th>
            <th className="align-right">Peers</th>
            <th className="align-right">Seeds / leechers</th>
            <th>Next announce</th>
          </tr>
        </thead>
        <tbody>
          {t.trackers.map((tr) => (
            <tr key={`${tr.tier}-${tr.url}`}>
              <td className="break">{tr.url}</td>
              <td>{tr.tier}</td>
              <td>
                {tr.state}
                {tr.message ? <div className="muted">{tr.message}</div> : null}
              </td>
              <td className="align-right">{tr.peers}</td>
              <td className="align-right">
                {tr.seeds ?? '—'} / {tr.leechers ?? '—'}
              </td>
              <td>{tr.nextAnnounce ? formatDateTime(tr.nextAnnounce) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Files({ t }: { t: TorrentDetail }) {
  const priority = useTorrentPriority(t.id);
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Files">
        <thead>
          <tr>
            <th>Path</th>
            <th className="align-right">Size</th>
            <th>Progress</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          {t.files.map((f) => (
            <tr key={f.index}>
              <td className="break">{f.path}</td>
              <td className="align-right">{formatSize(f.length)}</td>
              <td>
                <ProgressBar value={f.progress} />
              </td>
              <td>
                <Select
                  aria-label={`Priority of ${f.path}`}
                  value={priorityOption(f.priority)}
                  options={PRIORITY_OPTIONS}
                  disabled={priority.isPending}
                  onChange={(e) => priority.mutate({ files: [{ index: f.index, priority: Number(e.currentTarget.value) }] })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TorrentDrawer({ downloadId, title, onClose }: { downloadId: string; title: string; onClose: () => void }) {
  const detail = useTorrentDetail(downloadId);
  const action = useTorrentAction(downloadId);
  const t = detail.data;
  const busy = (a: 'pause' | 'resume' | 'recheck') => action.isPending && action.variables === a;
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={t?.name ?? title}
      footer={
        t ? (
          <>
            {t.state === 'paused' ? (
              <Button loading={busy('resume')} onClick={() => action.mutate('resume')}>
                Resume
              </Button>
            ) : (
              <Button loading={busy('pause')} onClick={() => action.mutate('pause')}>
                Pause
              </Button>
            )}
            <Button loading={busy('recheck')} onClick={() => action.mutate('recheck')}>
              Recheck
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        ) : null
      }
    >
      {detail.isPending ? (
        <LoadingBlock />
      ) : detail.isError ? (
        <ErrorView error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !t ? (
        <EmptyState title="Torrent not found">The built-in engine no longer has this torrent.</EmptyState>
      ) : (
        <Tabs
          tabs={[
            { id: 'general', label: 'General', content: <General t={t} /> },
            { id: 'peers', label: `Peers (${t.peers.length})`, content: <Peers t={t} /> },
            { id: 'trackers', label: `Trackers (${t.trackers.length})`, content: <Trackers t={t} /> },
            { id: 'files', label: `Files (${t.files.length})`, content: <Files t={t} /> },
          ]}
        />
      )}
    </Modal>
  );
}
