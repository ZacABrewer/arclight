import type { PlaybackProgress, PlayerAlbum, PlayerTrack } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Small pure helpers for the browse pages (durations, grouping, shuffling).

/** Track-style clock: "3:07", "1:02:03". */
export function clockTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Album or book length: "1 h 23 m", "48 m", under a minute "1 m". */
export function lengthLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('player.browse.time.minutes', { m: Math.max(1, m) });
  return t('player.browse.time.hoursMinutes', { h, m });
}

/** Share of the item heard, 0..1 (0 without progress). */
export function progressShare(progress: PlaybackProgress | null | undefined, durationMs?: number): number {
  if (!progress) return 0;
  if (progress.played) return 1;
  const total = progress.durationMs || durationMs || 0;
  return total > 0 ? Math.min(1, Math.max(0, progress.positionMs / total)) : 0;
}

/** "2 h 5 m left" from the stored position. */
export function timeLeftLabel(progress: PlaybackProgress | null | undefined, durationMs: number): string {
  const total = progress?.durationMs || durationMs;
  const left = Math.max(0, total - (progress?.positionMs ?? 0));
  return t('player.browse.time.left', { time: lengthLabel(left) });
}

/** In progress: started, not finished. */
export function isInProgress(progress: PlaybackProgress | null | undefined): boolean {
  return !!progress && !progress.played && progress.positionMs > 0;
}

/** A new shuffled copy (Fisher-Yates). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface DiscGroup {
  disc: number;
  tracks: Array<{ track: PlayerTrack; index: number }>;
}

/** Tracks split by disc, keeping each track's index in the flat (play) order. */
export function groupByDisc(tracks: readonly PlayerTrack[]): DiscGroup[] {
  const groups = new Map<number, DiscGroup>();
  tracks.forEach((track, index) => {
    const disc = track.discNumber ?? 1;
    const g = groups.get(disc) ?? { disc, tracks: [] };
    g.tracks.push({ track, index });
    groups.set(disc, g);
  });
  return [...groups.values()].sort((a, b) => a.disc - b.disc);
}

export type AlbumGroup = 'album' | 'ep' | 'single' | 'other';
export const ALBUM_GROUPS: readonly AlbumGroup[] = ['album', 'ep', 'single', 'other'];

export function albumGroup(albumType: string | null): AlbumGroup {
  const v = (albumType ?? '').toLowerCase().trim();
  if (v === 'album' || v === 'lp') return 'album';
  if (v === 'ep') return 'ep';
  if (v === 'single') return 'single';
  return 'other';
}

/** Albums by release type, newest first inside each group; empty groups dropped. */
export function groupAlbums(albums: readonly PlayerAlbum[]): Array<{ group: AlbumGroup; albums: PlayerAlbum[] }> {
  return ALBUM_GROUPS.map((group) => ({
    group,
    albums: albums.filter((a) => albumGroup(a.albumType) === group).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
  })).filter((g) => g.albums.length > 0);
}

/** "A".."Z" plus "#" for digits and symbols (the BrowseQuery letter values). */
export const LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** Joined names, or null when there are none. */
export function names(list: readonly string[]): string | null {
  return list.length ? list.join(', ') : null;
}
