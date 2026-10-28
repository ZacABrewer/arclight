// Client-side naming preview: renders a naming format against canned sample data so the
// FormRow caption ("→ Severance - S02E09 - The After Hours [WEBDL-2160p].mkv") updates as
// the user types. The server stays the authority on the real file names.
import { t } from '../../../i18n/index.js';

export type PreviewKind =
  | 'episode'
  | 'daily'
  | 'anime'
  | 'seriesFolder'
  | 'seasonFolder'
  | 'specialsFolder'
  | 'movie'
  | 'movieFolder'
  | 'artistFolder'
  | 'albumFolder'
  | 'track'
  | 'multiDiscTrack';

/** Sample values keyed by the normalised token name (lower case, no separators). */
export const SAMPLE_TOKENS: Readonly<Record<string, string | number>> = {
  seriestitle: 'Severance',
  seriestitleyear: 'Severance (2022)',
  seriescleantitle: 'Severance',
  seriestitlethe: 'Severance',
  seriescleantitleyear: 'Severance 2022',
  season: 2,
  episode: 9,
  absoluteepisode: 19,
  absolute: 19,
  episodetitle: 'The After Hours',
  episodecleantitle: 'The After Hours',
  qualityfull: 'WEBDL-2160p',
  qualitytitle: 'WEBDL-2160p',
  qualityproper: '',
  airdate: '2025-03-14',
  'air-date': '2025-03-14',
  releasegroup: 'NTb',
  mediainfosimple: 'h265 EAC3',
  mediainfovideocodec: 'h265',
  mediainfoaudiocodec: 'EAC3',
  mediainfovideodynamicrange: 'HDR',
  mediainfovideodynamicrangetype: 'DV HDR10',
  customformats: 'DV HDR10',
  imdbid: 'tt11280740',
  tvdbid: 371980,
  tmdbid: 95396,
  movietitle: 'Dune Part Two',
  movietitleyear: 'Dune Part Two (2024)',
  moviecleantitle: 'Dune Part Two',
  moviecleantitleyear: 'Dune Part Two 2024',
  releaseyear: 2024,
  year: 2024,
};

const MOVIE_OVERRIDES: Readonly<Record<string, string | number>> = {
  imdbid: 'tt15239678',
  tmdbid: 693134,
};

/** Music sample: a two-disc album, track 3 (disc 2 for the multi-disc format). */
const MUSIC_TOKENS: Readonly<Record<string, string | number>> = {
  artistname: 'Daft Punk',
  artistcleanname: 'Daft Punk',
  artistnamethe: 'Daft Punk',
  artistdisambiguation: '',
  albumtitle: 'Discovery',
  albumcleantitle: 'Discovery',
  albumtype: 'Album',
  albumdisambiguation: '',
  releaseyear: 2001,
  year: 2001,
  medium: 1,
  track: 3,
  tracktitle: 'Digital Love',
  trackcleantitle: 'Digital Love',
  trackartistname: 'Daft Punk',
  qualitytitle: 'FLAC',
  qualityfull: 'FLAC',
  releasegroup: 'GRP',
};

const MUSIC_KINDS: ReadonlySet<PreviewKind> = new Set(['artistFolder', 'albumFolder', 'track', 'multiDiscTrack']);

const FILE_KINDS: ReadonlySet<PreviewKind> = new Set(['episode', 'daily', 'anime', 'movie', 'track', 'multiDiscTrack']);

const extensionOf = (kind: PreviewKind): string => (MUSIC_KINDS.has(kind) ? '.flac' : '.mkv');

export interface PreviewOptions {
  /** Version tag `{Version}` renders as; unversioned (empty) by default. */
  version?: string | undefined;
}

function lookup(rawName: string, kind: PreviewKind, opts: PreviewOptions = {}): string | number | undefined {
  const name = rawName.trim().toLowerCase();
  const key = name.replace(/[\s._-]+/g, '');
  if (key === 'version') return opts.version ?? '';
  if (MUSIC_KINDS.has(kind)) {
    if (key === 'medium' && kind === 'multiDiscTrack') return 2;
    return MUSIC_TOKENS[key];
  }
  if (kind === 'movie' || kind === 'movieFolder') {
    if (key in MOVIE_OVERRIDES) return MOVIE_OVERRIDES[key];
  }
  if (name === 'air-date' || key === 'airdate') return SAMPLE_TOKENS.airdate;
  return SAMPLE_TOKENS[key];
}

/** Word separator implied by the token spelling: {Series.Title} → ".", {Series_Title} → "_". */
function separatorOf(name: string): string {
  const m = /[._]/.exec(name);
  return m ? m[0] : ' ';
}

/** Render one format against the sample data. Unknown tokens are left as written. */
export function renderPreview(format: string, kind: PreviewKind, opts: PreviewOptions = {}): string {
  const out = format.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    const [name = '', pad] = inner.split(':');
    const value = lookup(name, kind, opts);
    if (value === undefined) return whole;
    if (typeof value === 'number') {
      const width = pad && /^0+$/.test(pad) ? pad.length : 0;
      return String(value).padStart(width, '0');
    }
    const sep = separatorOf(name);
    return sep === ' ' ? value : value.split(' ').join(sep);
  });
  const tidy = out
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s+-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!tidy) return '';
  return FILE_KINDS.has(kind) ? `${tidy}${extensionOf(kind)}` : tidy;
}

/** The FormRow caption: "→ <name>", or a plain hint when the format is empty. */
export function previewCaption(format: string, kind: PreviewKind): string {
  const name = renderPreview(format, kind);
  return name ? `→ ${name}` : t('settings.mediaManagement.namingPreview.enterAFormatToSee');
}

// ---- multi-version items (naming.versionLayout, {Version}) --------------------------------

export type VersionLayout = 'sideBySide' | 'subfolder';

const VERSION_TOKEN = /\{\s*version\s*(?::[^{}]*)?\}/i;

/** True when a format places the version itself (so sideBySide appends nothing). */
export function hasVersionToken(format: string): boolean {
  return VERSION_TOKEN.test(format);
}

/**
 * Sample path of a file kept in version slot `tag`: the folders, then (subfolder layout) the
 * tag folder, then the file name; sideBySide appends " - <tag>" when the file format has no
 * {Version} token (docs/API.md "Multi-version library").
 */
export function versionedPreview(
  file: { format: string; kind: PreviewKind },
  folders: ReadonlyArray<{ format: string; kind: PreviewKind }>,
  layout: VersionLayout,
  tag: string,
): string {
  let name = renderPreview(file.format, file.kind, { version: tag });
  if (layout === 'sideBySide' && name && !hasVersionToken(file.format)) {
    const ext = FILE_KINDS.has(file.kind) ? extensionOf(file.kind) : '';
    name = `${name.slice(0, name.length - ext.length)} - ${tag}${ext}`;
  }
  const parts = folders.map((f) => renderPreview(f.format, f.kind, { version: tag }));
  if (layout === 'subfolder') parts.push(tag);
  parts.push(name);
  return parts.filter(Boolean).join('/');
}

// ---- music (naming.artistFolderFormat ... multiDiscStyle) --------------------------------

export type MultiDiscStyle = 'prefix' | 'subfolder';

/**
 * Sample path of a music track: artist folder / album folder / file, using the multi-disc
 * format (prefix style) or `Disc {medium}/` + track format (subfolder style) when `multiDisc`.
 */
export function musicPreview(
  formats: { artistFolderFormat: string; albumFolderFormat: string; trackFormat: string; multiDiscTrackFormat: string },
  style: MultiDiscStyle,
  multiDisc: boolean,
): string {
  const artist = renderPreview(formats.artistFolderFormat, 'artistFolder');
  const album = renderPreview(formats.albumFolderFormat, 'albumFolder');
  const file = !multiDisc
    ? renderPreview(formats.trackFormat, 'track')
    : style === 'subfolder'
      ? `Disc 2/${renderPreview(formats.trackFormat, 'track')}`
      : renderPreview(formats.multiDiscTrackFormat, 'multiDiscTrack');
  return [artist, album, file].filter(Boolean).join('/');
}
