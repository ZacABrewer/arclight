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
import { LimitsPanel, PeerConnectionBadges, WebSeeds } from './torrent-extras.js';
import { t } from '../../i18n/index.js';

// Detail drawer for queue rows downloaded by the built-in torrent engine. Polls
// GET /torrent/torrents?id=<downloadId> every 3 s while open.

export const PRIORITY_OPTIONS = [
  { value: '0', get label() { return t('activity.torrentDrawer.skip'); } },
  { value: '1', get label() { return t('activity.torrentDrawer.normal'); } },
  { value: '4', get label() { return t('activity.torrentDrawer.high'); } },
  { value: '7', get label() { return t('common.max'); } },
];

/** Snap any engine priority (0..7) to the nearest option the select offers. */
export function priorityOption(priority: number): string {
  if (priority <= 0) return '0';
  if (priority >= 7) return '7';
  if (priority >= 4) return '4';
  return '1';
}

/** Engine state → vocabulary chip (error carries its cause). */
function StateChip({ t: item }: { t: TorrentDetail }) {
  switch (item.state) {
    case 'error':
      return <StatusChip status="failed" cause={item.error || t('activity.torrentDrawer.engineError')} />;
    case 'paused':
      return <StatusChip status="paused" />;
    case 'queued':
      return <StatusChip status="queued" />;
    case 'seeding':
      return <StatusChip status="downloaded" />;
    default: {
      const extra: Partial<Record<TorrentState, string>> = { checking: t('activity.torrentDrawer.checkingFiles'), downloadingMetadata: t('activity.torrentDrawer.fetchingMetadata') };
      return extra[item.state] ? <Chip tone="neutral">{extra[item.state]}</Chip> : <StatusChip status="downloading" />;
    }
  }
}

function torrentTrail(entry: TorrentDetail): TrailState {
  if (entry.state === 'error') return 'failed';
  if (entry.state === 'paused') return 'paused';
  if (entry.state === 'queued') return 'queued';
  if (entry.state === 'seeding' || entry.progress >= 1) return 'complete';
  return 'active';
}

function General({ t: row }: { t: TorrentDetail }) {
  const items: KeyValueItem[] = [
    { label: t('common.state'), value: <StateChip t={row} />, mono: false },
    { label: t('common.progress'), value: <Trail value={row.progress * 100} state={torrentTrail(row)} showValue label={t('activity.torrentDrawer.torrentProgress')} /> },
    { label: t('common.size'), value: `${formatSize(row.wantedBytes)} of ${formatSize(row.totalBytes)} · ${formatSize(row.bytesLeft)} left` },
    { label: t('activity.torrentDrawer.transferred'), value: `${formatSize(row.downloaded)} down · ${formatSize(row.uploaded)} up` },
    { label: t('activity.torrentDrawer.ratio'), value: row.ratio.toFixed(2) },
    { label: t('activity.torrentDrawer.rates'), value: `${formatRate(row.downloadRate)} down · ${formatRate(row.uploadRate)} up` },
    { label: t('activity.torrentDrawer.eta'), value: row.etaSeconds === undefined ? '—' : formatEta(row.etaSeconds * 1000) },
    { label: t('common.peers'), value: `${row.connectedPeers} connected (${row.connectedSeeds} seeds) · swarm ${row.swarmSeeds} / ${row.swarmLeechers}` },
    {
      label: t('activity.torrentDrawer.pieces'),
      value: (
        <span className="al-activity-stack-xs">
          <span>
            {row.piecesHave}/{row.pieceCount}
          </span>
          <Trail value={row.pieceCount > 0 ? (row.piecesHave / row.pieceCount) * 100 : 0} state="complete" label={t('activity.torrentDrawer.pieces')} />
        </span>
      ),
    },
    { label: t('activity.torrentDrawer.savePath'), value: row.savePath },
    { label: t('activity.torrentDrawer.category'), value: row.category || '—' },
    { label: t('common.added'), value: formatDateTime(row.addedAt) },
    { label: t('common.completed'), value: row.completedAt ? formatDateTime(row.completedAt) : '—' },
    { label: t('common.private'), value: row.private ? t('common.yes') : t('common.no'), mono: false },
  ];
  return <KeyValue items={items} />;
}

type Peer = TorrentDetail['peers'][number];
type Tracker = TorrentDetail['trackers'][number];
type TorrentFile = TorrentDetail['files'][number];

const PEER_COLUMNS: Column<Peer>[] = [
  { key: 'address', get header() { return t('common.address'); }, mono: true, cell: (p) => p.address },
  { key: 'client', get header() { return t('activity.torrentDrawer.client'); }, cell: (p) => p.client || '—' },
  { key: 'source', get header() { return t('common.source'); }, muted: true, cell: (p) => `${p.source}${p.incoming ? ' (in)' : ''}` },
  {
    key: 'flags',
    get header() {
      return t('activity.torrentDrawer.flags');
    },
    mono: true,
    cell: (p) =>
      [p.amInterested ? 'I' : null, p.peerChoking ? 'C' : null, p.peerInterested ? 'i' : null, p.amChoking ? 'c' : null, p.snubbed ? 'S' : null]
        .filter(Boolean)
        .join(' ') || '—',
  },
  { key: 'connection', get header() { return t('activity.torrentDrawer.connection'); }, cell: (p) => <PeerConnectionBadges peer={p} /> },
  { key: 'progress', get header() { return t('common.progress'); }, mono: true, align: 'right', cell: (p) => `${Math.round(p.progress * 100)}%` },
  { key: 'down', get header() { return t('common.down'); }, mono: true, align: 'right', cell: (p) => formatRate(p.downloadRate) },
  { key: 'up', get header() { return t('activity.torrentDrawer.up'); }, mono: true, align: 'right', cell: (p) => formatRate(p.uploadRate) },
];

const TRACKER_COLUMNS: Column<Tracker>[] = [
  { key: 'url', get header() { return t('common.url'); }, mono: true, cell: (tr) => <span className="al-activity-break">{tr.url}</span> },
  { key: 'tier', get header() { return t('activity.torrentDrawer.tier'); }, mono: true, cell: (tr) => tr.tier },
  {
    key: 'state',
    get header() {
      return t('common.state');
    },
    cell: (tr) => (
      <>
        {tr.state}
        {tr.message ? <div className="al-activity-muted">{tr.message}</div> : null}
      </>
    ),
  },
  { key: 'peers', get header() { return t('common.peers'); }, mono: true, align: 'right', cell: (tr) => tr.peers },
  { key: 'swarm', get header() { return t('activity.torrentDrawer.seedsLeechers'); }, mono: true, align: 'right', cell: (tr) => `${tr.seeds ?? '—'} / ${tr.leechers ?? '—'}` },
  { key: 'next', get header() { return t('activity.torrentDrawer.nextAnnounce'); }, mono: true, cell: (tr) => (tr.nextAnnounce ? formatDateTime(tr.nextAnnounce) : '—') },
];

function Peers({ t: el }: { t: TorrentDetail }) {
  if (el.peers.length === 0) return <EmptyState title={t('activity.torrentDrawer.noPeersConnected')} />;
  return <Table caption={t('common.peers')} columns={PEER_COLUMNS} rows={el.peers} rowKey={(p) => p.address} sortable={false} />;
}

function Trackers({ t: t4 }: { t: TorrentDetail }) {
  if (t4.trackers.length === 0) return <EmptyState title={t('activity.torrentDrawer.noTrackers')}>{t('activity.torrentDrawer.trackerlessDhtPexOnly')}</EmptyState>;
  return <Table caption={t('activity.torrentDrawer.trackers')} columns={TRACKER_COLUMNS} rows={t4.trackers} rowKey={(tr) => `${tr.tier}-${tr.url}`} sortable={false} />;
}

function Files({ t: t5 }: { t: TorrentDetail }) {
  const priority = useTorrentPriority(t5.id);
  const columns: Column<TorrentFile>[] = [
    { key: 'path', header: t('common.path'), mono: true, cell: (f) => <span className="al-activity-break">{f.path}</span> },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (f) => formatSize(f.length) },
    {
      key: 'progress',
      header: t('common.progress'),
      width: '140px',
      cell: (f) => <Trail value={f.progress * 100} state={f.progress >= 1 ? 'complete' : f.priority === 0 ? 'paused' : 'active'} showValue />,
    },
    {
      key: 'priority',
      header: t('common.priority'),
      cell: (f) => (
        <Select
          aria-label={t('activity.torrentDrawer.priorityOfPath', { path: f.path })}
          value={priorityOption(f.priority)}
          options={PRIORITY_OPTIONS}
          disabled={priority.isPending}
          onChange={(e) => priority.mutate({ files: [{ index: f.index, priority: Number(e.currentTarget.value) }] })}
        />
      ),
    },
  ];
  return <Table caption={t('common.files')} columns={columns} rows={t5.files} rowKey={(f) => f.index} sortable={false} />;
}

export function TorrentDrawer({ downloadId, title, onClose }: { downloadId: string; title: string; onClose: () => void }) {
  const detail = useTorrentDetail(downloadId);
  const action = useTorrentAction(downloadId);
  const t6 = detail.data;
  const busy = (a: 'pause' | 'resume' | 'recheck') => action.isPending && action.variables === a;
  let body: ReactNode;
  if (detail.isPending) body = <Skeleton lines={6} />;
  else if (detail.isError)
    body = (
      <ErrorBlock title={t('activity.torrentDrawer.couldntLoadTheTorrent')} onRetry={() => void detail.refetch()}>
        {errorMessage(detail.error)}
      </ErrorBlock>
    );
  else if (!t6) body = <EmptyState title={t('activity.torrentDrawer.torrentNotFound')}>{t('activity.torrentDrawer.theBuiltInEngineNo')}</EmptyState>;
  else
    body = (
      <Tabs
        aria-label={t('activity.torrentDrawer.torrentDetails')}
        tabs={[
          { id: 'general', label: t('common.general'), content: <General t={t6} /> },
          { id: 'peers', label: t('common.peers'), count: t6.peers.length, content: <Peers t={t6} /> },
          { id: 'trackers', label: t('activity.torrentDrawer.trackers'), count: t6.trackers.length, content: <Trackers t={t6} /> },
          { id: 'files', label: t('common.files'), count: t6.files.length, content: <Files t={t6} /> },
          { id: 'webseeds', label: t('activity.torrentDrawer.webSeeds'), count: t6.webSeeds?.length ?? 0, content: <WebSeeds torrent={t6} /> },
          { id: 'limits', label: t('activity.torrentDrawer.limits'), content: <LimitsPanel key={t6.id} torrent={t6} /> },
        ]}
      />
    );
  return (
    <Drawer
      open
      width={760}
      onClose={onClose}
      title={t6?.name ?? title}
      footer={
        <>
          {t6 ? (
            <>
              {t6.state === 'paused' ? (
                <Button variant="secondary" loading={busy('resume')} onClick={() => action.mutate('resume')}>
                  {t('activity.torrentDrawer.resume')}
                </Button>
              ) : (
                <Button variant="secondary" loading={busy('pause')} onClick={() => action.mutate('pause')}>
                  {t('activity.torrentDrawer.pause')}
                </Button>
              )}
              <Button variant="secondary" loading={busy('recheck')} onClick={() => action.mutate('recheck')}>
                {t('activity.torrentDrawer.recheck')}
              </Button>
            </>
          ) : null}
          <span className="al-activity-spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {body}
    </Drawer>
  );
}

