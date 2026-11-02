import type {
  Album,
  AlbumPrimaryType,
  AlbumRelease,
  AlbumStatistics,
  Artist,
  ArtistLink,
  ArtistStatus,
  AudioFile,
  MonitorNewAlbums,
  MusicImage,
  MusicMonitorOption,
  Track,
} from '@arclight/shared';
import { AlbumPrimaryType as PrimaryTypes, MonitorNewAlbums as NewAlbumOptions, MusicMonitorOption as MonitorOptions } from '@arclight/shared';
import { parseDateish } from '../../../components/media/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the music pages (exported for tests).

/** First image of the preferred types, in order. */
export function musicImage(images: readonly MusicImage[] | undefined, ...types: MusicImage['coverType'][]): string | undefined {
  for (const type of types) {
    const hit = images?.find((i) => i.coverType === type);
    if (hit) return hit.url || hit.remoteUrl || undefined;
  }
  return undefined;
}

export const artistImage = (a: { images: readonly MusicImage[] }) => musicImage(a.images, 'poster', 'cover', 'fanart');
export const artistBackdrop = (a: { images: readonly MusicImage[] }) => musicImage(a.images, 'fanart', 'banner');
export const albumCover = (a: { images: readonly MusicImage[] }) => musicImage(a.images, 'cover', 'disc', 'poster');

/** One letter (or digit) for artwork without an image; '#' for names without either. */
export function initialOf(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name.replace(/^the\s+/i, ''));
  return m ? m[0].toLocaleUpperCase() : '#';
}

/** 3:41, 1:02:07. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export interface TrackProgress {
  have: number;
  total: number;
  /** 0-100. */
  percent: number;
}

/** Tracks on disk over tracks of the selected edition. */
export function trackProgress(stats: Pick<AlbumStatistics, 'trackCount' | 'trackFileCount' | 'totalTrackCount'> | null | undefined): TrackProgress {
  const have = stats?.trackFileCount ?? 0;
  const total = Math.max(stats?.trackCount ?? 0, stats?.totalTrackCount ?? 0);
  return { have, total, percent: total > 0 ? Math.min(100, (have / total) * 100) : 0 };
}

export const progressText = (p: TrackProgress) => `${p.have}/${p.total}`;

/** Some tracks are unwanted (per-track monitoring) and every wanted one is on disk. */
export function wantedTracksComplete(stats: Pick<AlbumStatistics, 'trackCount' | 'monitoredTrackCount' | 'missingTrackCount'> | null | undefined): boolean {
  if (!stats || stats.monitoredTrackCount == null || stats.missingTrackCount == null) return false;
  return stats.trackCount > 0 && stats.monitoredTrackCount > 0 && stats.monitoredTrackCount < stats.trackCount && stats.missingTrackCount === 0;
}

// ---------------------------------------------------------------------------------------
// Album header: format summary ("FLAC · 24/96", "ALBUM · LOSSLESS 24/96")
// ---------------------------------------------------------------------------------------

export interface AlbumFormat {
  /** Most common codec among the album's files, upper-case ("FLAC", "MP3"). */
  codec: string;
  lossless: boolean;
  /** Highest bit depth / sample rate seen on a lossless file. */
  bitDepth: number | null;
  sampleRateHz: number | null;
  /** Mean bitrate of lossy files. */
  bitrateKbps: number | null;
  /** More than one codec on disk. */
  mixed: boolean;
}

const LOSSLESS_CODECS = /^(flac|alac|ape|wavpack|wv|wav|pcm|aiff?|tta|dsd|dsf|dff|tak)/i;

/** The format the album is held in, or null with no files. */
export function albumFormat(files: readonly Pick<AudioFile, 'codec' | 'container' | 'bitDepth' | 'sampleRateHz' | 'bitrateKbps' | 'mediaInfo' | 'quality'>[]): AlbumFormat | null {
  if (files.length === 0) return null;
  const counts = new Map<string, number>();
  for (const f of files) {
    const c = (f.codec ?? f.container ?? f.quality.quality.name).toUpperCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const codec = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const isLossless = (f: (typeof files)[number]) => f.mediaInfo?.lossless ?? LOSSLESS_CODECS.test(f.codec ?? f.container ?? '');
  const lossless = files.every(isLossless);
  const max = (xs: (number | null | undefined)[]) => xs.reduce<number | null>((m, x) => (x != null && x > 0 && (m == null || x > m) ? x : m), null);
  const lossy = files.filter((f) => !isLossless(f) && f.bitrateKbps);
  return {
    codec,
    lossless,
    bitDepth: lossless ? max(files.map((f) => f.bitDepth)) : null,
    sampleRateHz: lossless ? max(files.map((f) => f.sampleRateHz)) : null,
    bitrateKbps: lossy.length > 0 ? Math.round(lossy.reduce((n, f) => n + (f.bitrateKbps ?? 0), 0) / lossy.length) : null,
    mixed: counts.size > 1,
  };
}

/** "16/44.1", "24/96"; null without both values. */
export function resolutionText(f: Pick<AlbumFormat, 'bitDepth' | 'sampleRateHz'>): string | null {
  if (!f.bitDepth || !f.sampleRateHz) return null;
  const khz = f.sampleRateHz / 1000;
  return `${f.bitDepth}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}`;
}

/** Right-aligned mono chip: "FLAC · 24/96", "MP3 · 320", "FLAC +". */
export function formatChipText(f: AlbumFormat): string {
  const detail = f.lossless ? resolutionText(f) : f.bitrateKbps ? String(f.bitrateKbps) : null;
  return [f.mixed ? `${f.codec} +` : f.codec, detail].filter(Boolean).join(' · ');
}

/** Mono eyebrow above the title: "ALBUM · LOSSLESS 24/96", "EP · LOSSY", "SINGLE". */
export function albumEyebrow(type: AlbumPrimaryType, format: AlbumFormat | null): string {
  const kind = albumTypeLabel(type);
  if (!format) return kind;
  const res = format.lossless ? resolutionText(format) : null;
  const quality = format.lossless ? t('music.album.lossless') : t('music.album.lossy');
  return [kind, res ? `${quality} ${res}` : quality].join(' · ');
}

/** Group order on the artist page. */
export const ALBUM_TYPE_ORDER: readonly AlbumPrimaryType[] = PrimaryTypes.options;

export const albumTypeLabel = (type: AlbumPrimaryType) => t('music.primaryType', { type });
export const albumTypeGroupLabel = (type: AlbumPrimaryType) => t('music.albumTypeGroup', { type });
export const artistStatusLabel = (status: ArtistStatus) => t('music.artistStatus', { status });
export const monitorOptionLabel = (option: MusicMonitorOption) => t('music.monitorOption', { option });
export const monitorNewAlbumsLabel = (value: MonitorNewAlbums) => t('music.monitorNewAlbums', { value });

export const MONITOR_OPTIONS = MonitorOptions.options;
export const NEW_ALBUM_OPTIONS = NewAlbumOptions.options;

/** Newest first; undated albums last. */
function byReleaseDesc(a: Album, b: Album): number {
  const da = a.releaseDate ?? (a.year ? String(a.year) : '');
  const db = b.releaseDate ?? (b.year ? String(b.year) : '');
  if (da !== db) return da === '' ? 1 : db === '' ? -1 : db.localeCompare(da);
  return a.title.localeCompare(b.title);
}

export interface AlbumGroup {
  type: AlbumPrimaryType;
  albums: Album[];
}

/** Albums grouped by primary type (Album, EP, Single, Broadcast, Other), newest first inside. */
export function groupAlbums(albums: readonly Album[]): AlbumGroup[] {
  return ALBUM_TYPE_ORDER.map((type) => ({ type, albums: albums.filter((a) => a.primaryType === type).sort(byReleaseDesc) })).filter(
    (g) => g.albums.length > 0,
  );
}

export function albumYear(a: Pick<Album, 'year' | 'releaseDate'>): number | null {
  if (a.year) return a.year;
  const m = /^(\d{4})/.exec(a.releaseDate ?? '');
  return m ? Number(m[1]) : null;
}

/** "CD · XW · 12 tracks · 2011-05-16" for the edition picker. */
export function releaseLabel(r: AlbumRelease): string {
  const parts = [
    r.title,
    r.formats.length ? r.formats.join(' + ') : null,
    r.country ?? null,
    t('music.trackCount', { count: r.trackCount }),
    r.date ?? null,
    r.disambiguation ?? null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export interface DiscGroup {
  medium: number;
  /** "CD", "Digital Media"... from the selected release. */
  format: string | null;
  name: string | null;
  tracks: Track[];
}

/** Tracks per medium, in disc then track order. */
export function groupTracks(tracks: readonly Track[], release?: AlbumRelease | undefined): DiscGroup[] {
  const map = new Map<number, Track[]>();
  for (const tr of tracks) {
    const list = map.get(tr.mediumNumber) ?? [];
    list.push(tr);
    map.set(tr.mediumNumber, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([medium, list]) => {
      const m = release?.media.find((x) => x.position === medium);
      return { medium, format: m?.format ?? null, name: m?.name ?? null, tracks: list.sort((a, b) => a.trackNumber - b.trackNumber) };
    });
}

/** Album status chip on the calendar and wanted lists. */
export type AlbumState = 'downloaded' | 'unaired' | 'wanted' | 'missing';

export function albumState(album: Pick<Album, 'monitored' | 'releaseDate' | 'statistics'>, now: Date = new Date()): AlbumState {
  const p = trackProgress(album.statistics);
  if (p.total > 0 && p.have >= p.total) return 'downloaded';
  if (wantedTracksComplete(album.statistics)) return 'downloaded';
  const released = album.releaseDate ? parseDateish(album.releaseDate) : null;
  if (released && released.getTime() > now.getTime()) return 'unaired';
  return album.monitored ? 'wanted' : 'missing';
}

// ---------------------------------------------------------------------------------------
// Artist index: filters and sort
// ---------------------------------------------------------------------------------------

export type ArtistMonitoredFilter = 'all' | 'monitored' | 'unmonitored';

export interface ArtistFilters {
  search: string;
  monitored: ArtistMonitoredFilter;
  qualityProfileId: number | null;
  status: ArtistStatus | null;
  /** Only artists with tracks missing. */
  missing: boolean;
}

export const DEFAULT_ARTIST_FILTERS: ArtistFilters = { search: '', monitored: 'all', qualityProfileId: null, status: null, missing: false };

export function activeArtistFilterCount(f: ArtistFilters): number {
  return [f.search.trim() !== '', f.monitored !== 'all', f.qualityProfileId !== null, f.status !== null, f.missing].filter(Boolean).length;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterArtists(list: readonly Artist[], f: ArtistFilters): Artist[] {
  const q = fold(f.search.trim());
  return list.filter((a) => {
    if (q && !fold(a.name).includes(q) && !a.aliases.some((x) => fold(x).includes(q))) return false;
    if (f.monitored === 'monitored' && !a.monitored) return false;
    if (f.monitored === 'unmonitored' && a.monitored) return false;
    if (f.qualityProfileId !== null && a.qualityProfileId !== f.qualityProfileId) return false;
    if (f.status !== null && a.status !== f.status) return false;
    if (f.missing) {
      const p = trackProgress(a.statistics);
      if (p.have >= p.total) return false;
    }
    return true;
  });
}

export type ArtistSortKey = 'name' | 'added' | 'albums' | 'tracks' | 'size';

export interface ArtistSort {
  key: ArtistSortKey;
  direction: 'asc' | 'desc';
}

export const ARTIST_SORT_KEYS: readonly ArtistSortKey[] = ['name', 'added', 'albums', 'tracks', 'size'];
export const artistSortLabel = (key: ArtistSortKey) => t('music.sortKey', { key });

function sortValue(a: Artist, key: ArtistSortKey): string | number {
  switch (key) {
    case 'name':
      return a.sortName.toLowerCase();
    case 'added':
      return a.added;
    case 'albums':
      return a.statistics?.albumCount ?? 0;
    case 'tracks':
      return trackProgress(a.statistics).percent;
    case 'size':
      return a.statistics?.sizeOnDisk ?? 0;
  }
}

export function sortArtists(list: readonly Artist[], sort: ArtistSort): Artist[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c !== 0 ? c * dir : a.sortName.localeCompare(b.sortName);
  });
}

/** Destination folder preview for the add dialog: `<root>/<Artist Name>`. */
export function artistFolder(root: string, name: string): string {
  if (!root) return '';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const clean = name.replace(/[<>:"/\\|?*]/g, '').trim();
  return `${root.replace(/[\\/]+$/, '')}${sep}${clean}`;
}

/**
 * MusicBrainz relation types worth a link on the artist page, in display order. MusicBrainz
 * lists dozens per artist (every store, streaming service and database); the page keeps these.
 */
const FEATURED_LINKS: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'official homepage', label: 'Website' },
  { type: 'wikipedia', label: 'Wikipedia' },
  { type: 'wikidata', label: 'Wikidata' },
  { type: 'discogs', label: 'Discogs' },
  { type: 'allmusic', label: 'AllMusic' },
  { type: 'bandcamp', label: 'Bandcamp' },
  { type: 'last.fm', label: 'Last.fm' },
  { type: 'youtube', label: 'YouTube' },
  { type: 'soundcloud', label: 'SoundCloud' },
];

/** The featured links (one per type, MusicBrainz always first), each with a short label. */
export function featuredArtistLinks(links: readonly ArtistLink[], mbArtistId?: string): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = [];
  if (mbArtistId) out.push({ label: 'MusicBrainz', url: `https://musicbrainz.org/artist/${mbArtistId}` });
  for (const f of FEATURED_LINKS) {
    const hit = links.find((l) => l.name.toLowerCase() === f.type);
    if (hit) out.push({ label: f.label, url: hit.url });
  }
  return out;
}
