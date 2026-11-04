import type { ActiveStream, ActiveStreamClientKind, ActiveStreamMethod } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Chip, EmptyState, ErrorBlock, Meter, PageHeader, Pane, Poster, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useActiveStreams } from '../../hooks/active-streams.js';
import { formatDecimal, t } from '../../i18n/index.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { ProfileAvatar } from '../settings/users/user-profiles.js';
import { hwaccelLabel } from '../settings/transcode/transcode-model.js';
import { useDocumentTitle } from './activity-shared.js';
import './activity.css';

// Activity -> Now playing: what Arclight's own player is streaming right now (GET
// /activity/streams, polled every 5 s). One row per device and item: who, what, the client, its
// address, how it plays and where it is. View only.

export function clientKindLabel(kind: ActiveStreamClientKind): string {
  switch (kind) {
    case 'web':
      return t('activity.streams.clientWeb');
    case 'app':
      return t('activity.streams.clientApp');
    case 'tv':
      return t('activity.streams.clientTv');
    case 'other':
      return t('activity.streams.clientOther');
  }
}

export function methodLabel(method: ActiveStreamMethod): string {
  switch (method) {
    case 'direct':
      return t('activity.streams.direct');
    case 'remux':
      return t('activity.streams.remux');
    case 'transcode':
      return t('activity.streams.transcode');
  }
}

const METHOD_TONES: Record<ActiveStreamMethod, ChipTone> = { direct: 'default', remux: 'neutral', transcode: 'warn' };

/** "1:02:03" or "4:05". */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The title line and the line under it: series and S01E02 · episode, artist · album, book and chapter. */
export function streamTitle(item: ActiveStream['item']): { main: string; sub: string | null } {
  switch (item.kind) {
    case 'episode': {
      const code = item.seasonNumber !== null && item.episodeNumber !== null ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}` : null;
      return { main: item.seriesTitle ?? item.title, sub: [code, item.title].filter(Boolean).join(' · ') || null };
    }
    case 'track':
      return { main: item.title, sub: [item.artist, item.album].filter(Boolean).join(' · ') || null };
    case 'audiobook':
      return { main: item.title, sub: [item.chapter, item.artist].filter(Boolean).join(' · ') || null };
    default:
      return { main: item.title, sub: item.year !== null ? String(item.year) : null };
  }
}

/** "1080p · 8,000 kbps · Intel Quick Sync (QSV) · 1.4×", "Opus · 128 kbps", "via Jellyfin". */
export function playbackDetail(p: ActiveStream['playback']): string {
  const parts: string[] = [];
  if (p.rung) parts.push(`${p.rung.height}p`);
  if (p.audioFormat) parts.push(p.audioFormat.toUpperCase());
  if (p.bitrateKbps) parts.push(t('activity.streams.kbps', { value: formatDecimal(p.bitrateKbps, 0) }));
  if (p.method === 'transcode' && p.hwaccel) parts.push(hwaccelLabel(p.hwaccel));
  if (p.encodeSpeed !== null) parts.push(`${formatDecimal(p.encodeSpeed, 1)}×`);
  if (p.delivery === 'hls') parts.push('HLS');
  if (p.backend === 'jellyfin') parts.push(t('activity.streams.viaJellyfin'));
  return parts.join(' · ');
}

function Who({ s }: { s: ActiveStream }) {
  const name = s.profile?.name ?? s.user.username;
  return (
    <span className="al-streams-who">
      {s.profile ? <ProfileAvatar profile={s.profile} size={28} /> : null}
      <span className="al-activity-title">
        <span className="al-activity-title__main">{name}</span>
        {name !== s.user.username ? <span className="al-activity-title__sub">{s.user.username}</span> : null}
      </span>
    </span>
  );
}

function What({ s }: { s: ActiveStream }) {
  const { main, sub } = streamTitle(s.item);
  return (
    <span className="al-streams-what">
      <Poster src={s.item.artworkUrl} title={main} width={40} className="al-streams-art" />
      <span className="al-activity-title">
        <span className="al-activity-title__main">{main}</span>
        {sub ? <span className="al-activity-title__sub">{sub}</span> : null}
      </span>
    </span>
  );
}

function Client({ s }: { s: ActiveStream }) {
  const c = s.client;
  const detail = [c.platform === 'ios' ? 'iOS' : c.platform === 'android' ? 'Android' : null, c.appVersion].filter(Boolean).join(' · ');
  return (
    <span className="al-activity-title">
      <span className="al-activity-title__main">{c.deviceName ?? clientKindLabel(c.kind)}</span>
      <span className="al-activity-title__sub">{[c.deviceName ? clientKindLabel(c.kind) : null, detail || null].filter(Boolean).join(' · ')}</span>
    </span>
  );
}

function Playback({ s }: { s: ActiveStream }) {
  const detail = playbackDetail(s.playback);
  return (
    <span className="al-activity-stack-xs al-streams-stack">
      {s.playback.method ? <Chip tone={METHOD_TONES[s.playback.method]}>{methodLabel(s.playback.method)}</Chip> : <span className="al-caption">—</span>}
      {detail ? <span className="al-num al-activity-muted al-activity-break">{detail}</span> : null}
    </span>
  );
}

function Position({ s }: { s: ActiveStream }) {
  const pct = s.durationMs > 0 ? Math.min(100, (s.positionMs / s.durationMs) * 100) : 0;
  const { main } = streamTitle(s.item);
  return (
    <span className="al-activity-stack-xs al-streams-stack">
      <Chip tone={s.state === 'playing' ? 'accent' : 'muted'}>{s.state === 'playing' ? t('activity.streams.playing') : t('activity.streams.paused')}</Chip>
      <Meter
        value={pct}
        live={s.state === 'playing'}
        label={t('activity.streams.positionOf', { title: main })}
        valueText={s.durationMs > 0 ? `${clockOf(s.positionMs)} / ${clockOf(s.durationMs)}` : clockOf(s.positionMs)}
      />
    </span>
  );
}

export function StreamsPage() {
  useDocumentTitle(t('nav.nowPlaying'));
  const streams = useActiveStreams();
  const rows = streams.data?.streams;

  const columns: Column<ActiveStream>[] = [
    { key: 'title', header: t('common.title'), mobile: 'primary', cell: (s) => <What s={s} /> },
    { key: 'who', header: t('common.user'), cell: (s) => <Who s={s} /> },
    { key: 'client', header: t('activity.streams.client'), cell: (s) => <Client s={s} /> },
    {
      key: 'address',
      header: t('activity.streams.address'),
      cell: (s) => (
        <span className="al-activity-stack-xs al-streams-stack">
          <span className="al-num al-activity-break">{s.address.ip}</span>
          <Chip tone={s.address.remote ? 'neutral' : 'muted'} dot="none">
            {s.address.remote ? t('activity.streams.remote') : t('activity.streams.local')}
          </Chip>
        </span>
      ),
    },
    { key: 'playback', header: t('activity.streams.playback'), cell: (s) => <Playback s={s} /> },
    { key: 'progress', header: t('common.progress'), cell: (s) => <Position s={s} /> },
    {
      key: 'started',
      header: t('activity.streams.started'),
      mono: true,
      align: 'right',
      cell: (s) => (
        <time dateTime={s.startedAt} title={formatDateTime(s.startedAt)}>
          {relativeTime(s.startedAt)}
        </time>
      ),
    },
  ];

  return (
    <div className="al-activity">
      <PageHeader index="06" title={t('nav.nowPlaying')} subtitle={rows ? t('activity.streams.count', { count: rows.length }) : undefined} />
      <Pane flush bare className="al-activity-pane">
        {streams.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.streams.couldNotLoad')} onRetry={() => void streams.refetch()}>
              {errorMessage(streams.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption={t('nav.nowPlaying')}
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            loading={streams.isPending}
            density="rich"
            sortable={false}
            empty={<EmptyState title={t('activity.streams.empty')}>{t('activity.streams.emptyBody')}</EmptyState>}
          />
        )}
      </Pane>
    </div>
  );
}
