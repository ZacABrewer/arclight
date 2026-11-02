import type { MusicPlaylist, PlaylistEntryStatus, PlaylistSource, PlaylistSyncStatus } from '@arclight/shared';
import type { ChipTone } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the Playlists page (source form, labels, tones).

export type SourceKind = PlaylistSource['kind'];
export const SOURCE_KINDS: readonly SourceKind[] = ['spotify', 'deezer', 'listenbrainz', 'listenbrainzCreatedFor', 'lastfm'];
export const LASTFM_PERIODS = ['7day', '1month', '3month', '6month', '12month', 'overall'] as const;

/** Every field any source kind uses; the form keeps them all so switching kinds loses nothing. */
export interface SourceDraft {
  kind: SourceKind;
  url: string;
  user: string;
  patch: string;
  chart: 'top' | 'loved';
  period: (typeof LASTFM_PERIODS)[number];
  limit: number;
}

export function sourceDraft(source?: PlaylistSource): SourceDraft {
  const d: SourceDraft = { kind: 'spotify', url: '', user: '', patch: '', chart: 'top', period: '3month', limit: 50 };
  if (!source) return d;
  switch (source.kind) {
    case 'spotify':
    case 'deezer':
    case 'listenbrainz':
      return { ...d, kind: source.kind, url: source.url };
    case 'listenbrainzCreatedFor':
      return { ...d, kind: source.kind, user: source.user, patch: source.patch };
    case 'lastfm':
      return { ...d, kind: source.kind, user: source.user, chart: source.chart, period: source.period as SourceDraft['period'], limit: source.limit };
  }
}

/** The source for the api, or null while a required field is empty. */
export function sourceFromDraft(d: SourceDraft): PlaylistSource | null {
  switch (d.kind) {
    case 'spotify':
    case 'deezer':
    case 'listenbrainz':
      return d.url.trim() ? { kind: d.kind, url: d.url.trim() } : null;
    case 'listenbrainzCreatedFor':
      return d.user.trim() ? { kind: d.kind, user: d.user.trim(), patch: d.patch.trim() } : null;
    case 'lastfm':
      return d.user.trim() ? { kind: d.kind, user: d.user.trim(), chart: d.chart, period: d.period, limit: Math.min(200, Math.max(1, Math.round(d.limit) || 50)) } : null;
  }
}

export function sourceKindLabel(kind: SourceKind): string {
  return t(`musicPlaylists.source.${kind}`);
}

/** One line naming where the playlist comes from. */
export function sourceSummary(source: PlaylistSource): string {
  switch (source.kind) {
    case 'spotify':
    case 'deezer':
    case 'listenbrainz':
      return source.url;
    case 'listenbrainzCreatedFor':
      return source.patch ? `${source.user} · ${source.patch}` : source.user;
    case 'lastfm':
      return source.chart === 'loved' ? `${source.user} · ${t('musicPlaylists.chartLoved')}` : `${source.user} · ${t('musicPlaylists.chartTop')} · ${source.period}`;
  }
}

export const SYNC_TONE: Record<PlaylistSyncStatus, ChipTone> = {
  never: 'muted',
  running: 'accent',
  ok: 'default',
  partial: 'warn',
  failed: 'danger',
};

export const ENTRY_TONE: Record<PlaylistEntryStatus, ChipTone> = {
  available: 'default',
  wanted: 'accent',
  artistAdded: 'accent',
  notMonitored: 'neutral',
  matched: 'muted',
  unmatched: 'danger',
};

export function syncStatusLabel(status: PlaylistSyncStatus): string {
  return t(`musicPlaylists.sync.${status}`);
}

export function entryStatusLabel(status: PlaylistEntryStatus): string {
  return t(`musicPlaylists.entry.${status}`);
}

export function targetLabel(target: string, servers: ReadonlyArray<{ id: string; name: string }>): string {
  if (target === 'navidrome') return 'Navidrome';
  const id = target.startsWith('server:') ? target.slice('server:'.length) : target;
  return servers.find((s) => s.id === id)?.name ?? id;
}

/** "12 / 40" available of total, for the list. */
export function availability(p: MusicPlaylist): { have: number; total: number; percent: number } {
  const { available, total } = p.counts;
  return { have: available, total, percent: total > 0 ? (available / total) * 100 : 0 };
}
