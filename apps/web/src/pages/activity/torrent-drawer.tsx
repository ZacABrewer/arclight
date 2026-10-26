import type { ReactNode } from 'react';
import type { TorrentDetail, TorrentState } from '@arclight/shared';
import {
  Button,
  Chip,
  Drawer,
  EmptyState,
  ErrorBlock,
  KeyValue,
  Select,
  Skeleton,
  StatusChip,
  Table,
  Tabs,
  Trail,
  type Column,
  type KeyValueItem,
  type TrailState,
} from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { useTorrentAction, useTorrentDetail, useTorrentPriority } from '../../hooks/torrent.js';
import { formatDateTime, formatRate, formatSize } from '../../lib/format.js';
import { formatEta } from './activity-shared.js';

// Detail drawer for queue rows downloaded by the built-in torrent engine. Polls
// GET /torrent/torrents?id=<downloadId> every 3 s while open.

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

/** Engine state → vocabulary chip (error carries its cause). */
function StateChip({ t }: { t: TorrentDetail }) {
  switch (t.state) {
    case 'error':
      return <StatusChip status="failed" cause={t.error || 'engine error'} />;
    case 'paused':
      return <StatusChip status="paused" />;
    case 'queued':
      return <StatusChip status="queued" />;
    case 'seeding':
      return <StatusChip status="downloaded" />;
    default: {
      const extra: Partial<Record<TorrentState, string>> = { checking: 'Checking files', downloadingMetadata: 'Fetching metadata' };
      return extra[t.state] ? <Chip tone="neutral">{extra[t.state]}</Chip> : <StatusChip status="downloading" />;
    }
  }
}

function torrentTrail(t: TorrentDetail): TrailState {
  if (t.state === 'error') return 'failed';
  if (t.state === 'paused') return 'paused';
  if (t.state === 'queued') return 'queued';
  if (t.state === 'seeding' || t.progress >= 1) return 'complete';
  return 'active';
}

function General({ t }: { t: TorrentDetail }) {
  const items: KeyValueItem[] = [
    { label: 'State', value: <StateChip t={t} />, mono: false },
    { label: 'Progress', value: <Trail value={t.progress * 100} state={torrentTrail(t)} showValue label="Torrent progress" /> },
    { label: 'Size', value: `${formatSize(t.wantedBytes)} of ${formatSize(t.totalBytes)} · ${formatSize(t.bytesLeft)} left` },
    { label: 'Transferred', value: `${formatSize(t.downloaded)} down · ${formatSize(t.uploaded)} up` },
    { label: 'Ratio', value: t.ratio.toFixed(2) },
    { label: 'Rates', value: `${formatRate(t.downloadRate)} down · ${formatRate(t.uploadRate)} up` },
    { label: 'ETA', value: t.etaSeconds === undefined ? '—' : formatEta(t.etaSeconds * 1000) },
    { label: 'Peers', value: `${t.connectedPeers} connected (${t.connectedSeeds} seeds) · swarm ${t.swarmSeeds} / ${t.swarmLeechers}` },
    {
      label: 'Pieces',
      value: (
        <span className="al-activity-stack-xs">
          <span>
            {t.piecesHave}/{t.pieceCount}
          </span>
          <Trail value={t.pieceCount > 0 ? (t.piecesHave / t.pieceCount) * 100 : 0} state="complete" label="Pieces" />
        </span>
      ),
    },
    { label: 'Save path', value: t.savePath },
    { label: 'Category', value: t.category || '—' },
    { label: 'Added', value: formatDateTime(t.addedAt) },
    { label: 'Completed', value: t.completedAt ? formatDateTime(t.completedAt) : '—' },
    { label: 'Private', value: t.private ? 'Yes' : 'No', mono: false },
  ];
  return <KeyValue items={items} />;
}

type Peer = TorrentDetail['peers'][number];
type Tracker = TorrentDetail['trackers'][number];
type TorrentFile = TorrentDetail['files'][number];

const PEER_COLUMNS: Column<Peer>[] = [
  { key: 'address', header: 'Address', mono: true, cell: (p) => p.address },
  { key: 'client', header: 'Client', cell: (p) => p.client || '—' },
  { key: 'source', header: 'Source', muted: true, cell: (p) => `${p.source}${p.incoming ? ' (in)' : ''}` },
  {
    key: 'flags',
    header: 'Flags',
    mono: true,
    cell: (p) =>
      [p.amInterested ? 'I' : null, p.peerChoking ? 'C' : null, p.peerInterested ? 'i' : null, p.amChoking ? 'c' : null, p.snubbed ? 'S' : null]
        .filter(Boolean)
        .join(' ') || '—',
  },
  { key: 'progress', header: 'Progress', mono: true, align: 'right', cell: (p) => `${Math.round(p.progress * 100)}%` },
  { key: 'down', header: 'Down', mono: true, align: 'right', cell: (p) => formatRate(p.downloadRate) },
  { key: 'up', header: 'Up', mono: true, align: 'right', cell: (p) => formatRate(p.uploadRate) },
];

const TRACKER_COLUMNS: Column<Tracker>[] = [
  { key: 'url', header: 'URL', mono: true, cell: (tr) => <span className="al-activity-break">{tr.url}</span> },
  { key: 'tier', header: 'Tier', mono: true, cell: (tr) => tr.tier },
  {
    key: 'state',
    header: 'State',
    cell: (tr) => (
      <>
        {tr.state}
        {tr.message ? <div className="al-activity-muted">{tr.message}</div> : null}
      </>
    ),
  },
  { key: 'peers', header: 'Peers', mono: true, align: 'right', cell: (tr) => tr.peers },
  { key: 'swarm', header: 'Seeds / leechers', mono: true, align: 'right', cell: (tr) => `${tr.seeds ?? '—'} / ${tr.leechers ?? '—'}` },
  { key: 'next', header: 'Next announce', mono: true, cell: (tr) => (tr.nextAnnounce ? formatDateTime(tr.nextAnnounce) : '—') },
];

function Peers({ t }: { t: TorrentDetail }) {
  if (t.peers.length === 0) return <EmptyState title="No peers connected" />;
  return <Table caption="Peers" columns={PEER_COLUMNS} rows={t.peers} rowKey={(p) => p.address} sortable={false} />;
}

function Trackers({ t }: { t: TorrentDetail }) {
  if (t.trackers.length === 0) return <EmptyState title="No trackers">Trackerless (DHT / PEX only).</EmptyState>;
  return <Table caption="Trackers" columns={TRACKER_COLUMNS} rows={t.trackers} rowKey={(tr) => `${tr.tier}-${tr.url}`} sortable={false} />;
}

function Files({ t }: { t: TorrentDetail }) {
  const priority = useTorrentPriority(t.id);
  const columns: Column<TorrentFile>[] = [
    { key: 'path', header: 'Path', mono: true, cell: (f) => <span className="al-activity-break">{f.path}</span> },
    { key: 'size', header: 'Size', mono: true, align: 'right', cell: (f) => formatSize(f.length) },
    {
      key: 'progress',
      header: 'Progress',
      width: '140px',
      cell: (f) => <Trail value={f.progress * 100} state={f.progress >= 1 ? 'complete' : f.priority === 0 ? 'paused' : 'active'} showValue />,
    },
    {
      key: 'priority',
      header: 'Priority',
      cell: (f) => (
        <Select
          aria-label={`Priority of ${f.path}`}
          value={priorityOption(f.priority)}
          options={PRIORITY_OPTIONS}
          disabled={priority.isPending}
          onChange={(e) => priority.mutate({ files: [{ index: f.index, priority: Number(e.currentTarget.value) }] })}
        />
      ),
    },
  ];
  return <Table caption="Files" columns={columns} rows={t.files} rowKey={(f) => f.index} sortable={false} />;
}

export function TorrentDrawer({ downloadId, title, onClose }: { downloadId: string; title: string; onClose: () => void }) {
  const detail = useTorrentDetail(downloadId);
  const action = useTorrentAction(downloadId);
  const t = detail.data;
  const busy = (a: 'pause' | 'resume' | 'recheck') => action.isPending && action.variables === a;
  let body: ReactNode;
  if (detail.isPending) body = <Skeleton lines={6} />;
  else if (detail.isError)
    body = (
      <ErrorBlock title="Couldn't load the torrent" onRetry={() => void detail.refetch()}>
        {errorMessage(detail.error)}
      </ErrorBlock>
    );
  else if (!t) body = <EmptyState title="Torrent not found">The built-in engine no longer has this torrent.</EmptyState>;
  else
    body = (
      <Tabs
        aria-label="Torrent details"
        tabs={[
          { id: 'general', label: 'General', content: <General t={t} /> },
          { id: 'peers', label: 'Peers', count: t.peers.length, content: <Peers t={t} /> },
          { id: 'trackers', label: 'Trackers', count: t.trackers.length, content: <Trackers t={t} /> },
          { id: 'files', label: 'Files', count: t.files.length, content: <Files t={t} /> },
        ]}
      />
    );
  return (
    <Drawer
      open
      width={760}
      onClose={onClose}
      title={t?.name ?? title}
      footer={
        <>
          {t ? (
            <>
              {t.state === 'paused' ? (
                <Button variant="secondary" loading={busy('resume')} onClick={() => action.mutate('resume')}>
                  Resume
                </Button>
              ) : (
                <Button variant="secondary" loading={busy('pause')} onClick={() => action.mutate('pause')}>
                  Pause
                </Button>
              )}
              <Button variant="secondary" loading={busy('recheck')} onClick={() => action.mutate('recheck')}>
                Recheck
              </Button>
            </>
          ) : null}
          <span className="al-activity-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {body}
    </Drawer>
  );
}

