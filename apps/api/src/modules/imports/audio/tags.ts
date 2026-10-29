import { stat } from 'node:fs/promises';
import { parseFile, type IAudioMetadata, type IOptions } from 'music-metadata';
import { nodeExec, type ExecFn, type FfprobeRunner } from '../../media-analysis/runner.js';

// Reading audio tags and stream facts (design 9.1). `music-metadata` is the primary reader
// (in-process, a few ms per file); ffprobe is the fallback when it cannot parse a file and the
// source of truth when the two disagree about duration. Tag keys from ID3v2, Vorbis comments,
// MP4 atoms, APEv2 and RIFF INFO are folded into one `AudioTags` shape by `normalizeTagEntries`.
//
// `AudioTags` / `AudioChapter` are local until `@arclight/shared` ships the music contracts;
// keep the field names aligned with the `audio_files` columns so the swap is mechanical.

export interface AudioChapter {
  title: string;
  startMs: number;
  endMs: number | null;
}

export interface AudioTags {
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  /** As tagged: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (other shapes are kept verbatim). */
  date: string | null;
  trackNo: number | null;
  trackOf: number | null;
  discNo: number | null;
  discOf: number | null;
  compilation: boolean;
  /** MusicBrainz recording id (Vorbis/MP4 `MUSICBRAINZ_TRACKID`, ID3 `UFID`). */
  mbRecordingId: string | null;
  /** MusicBrainz track id (the release-specific track, `MUSICBRAINZ_RELEASETRACKID`). */
  mbReleaseTrackId: string | null;
  mbReleaseId: string | null;
  mbReleaseGroupId: string | null;
  mbArtistId: string | null;
  mbAlbumArtistId: string | null;
  asin: string | null;
  isbn: string | null;
  narrator: string | null;
  /** Composer / writer tag; audiobook rippers often put the narrator here. */
  composer: string | null;
  series: string | null;
  seriesPart: string | null;
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  durationMs: number | null;
  lossless: boolean | null;
  /** Present (possibly empty) for containers that carry chapters; null otherwise. */
  chapters: AudioChapter[] | null;
  /** Which reader produced the tags; `durationSource` differs when ffprobe corrected it. */
  source: 'music-metadata' | 'ffprobe';
  durationSource: 'music-metadata' | 'ffprobe' | null;
}

export interface TagReader {
  read(path: string): Promise<AudioTags>;
}

export class TagReadError extends Error {
  constructor(
    readonly code: 'UNREADABLE' | 'FFPROBE_MISSING' | 'FFPROBE_FAILED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TagReadError';
  }
}

export function emptyAudioTags(source: AudioTags['source'] = 'music-metadata'): AudioTags {
  return {
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    date: null,
    trackNo: null,
    trackOf: null,
    discNo: null,
    discOf: null,
    compilation: false,
    mbRecordingId: null,
    mbReleaseTrackId: null,
    mbReleaseId: null,
    mbReleaseGroupId: null,
    mbArtistId: null,
    mbAlbumArtistId: null,
    asin: null,
    isbn: null,
    narrator: null,
    composer: null,
    series: null,
    seriesPart: null,
    codec: null,
    container: null,
    bitrateKbps: null,
    sampleRateHz: null,
    bitDepth: null,
    channels: null,
    durationMs: null,
    lossless: null,
    chapters: null,
    source,
    durationSource: null,
  };
}

// ---------------------------------------------------------------------------------------
// Tag key normalisation
// ---------------------------------------------------------------------------------------

/** The text-valued tag fields `normalizeTagEntries` fills. */
export type TagField =
  | 'title'
  | 'artist'
  | 'albumArtist'
  | 'album'
  | 'date'
  | 'originalDate'
  | 'track'
  | 'trackOf'
  | 'disc'
  | 'discOf'
  | 'compilation'
  | 'mbRecordingId'
  | 'mbReleaseTrackId'
  | 'mbReleaseId'
  | 'mbReleaseGroupId'
  | 'mbArtistId'
  | 'mbAlbumArtistId'
  | 'asin'
  | 'isbn'
  | 'narrator'
  | 'composer'
  | 'series'
  | 'seriesPart';

// Compact keys (lower case, only letters, digits and ©) per field. Sources:
// ID3v2.3/2.4 frames (and 2.2 three-letter ids), TXXX descriptions, Vorbis comments, MP4
// atoms and iTunes freeform names, APEv2 items, RIFF INFO chunks, and the generic names
// ffprobe reports for all of them.
const KEY_TABLE: ReadonlyArray<[TagField, readonly string[]]> = [
  ['title', ['title', 'tit2', 'tt2', '©nam', 'inam']],
  ['artist', ['artist', 'tpe1', 'tp1', '©art', 'iart']],
  ['albumArtist', ['albumartist', 'tpe2', 'tp2', 'aart', 'band']],
  ['album', ['album', 'talb', 'tal', '©alb', 'iprd']],
  ['date', ['date', 'tdrc', 'tyer', 'tye', '©day', 'year', 'icrd', 'releasedate', 'tdrl']],
  ['originalDate', ['originaldate', 'tdor', 'tory', 'originalyear']],
  ['track', ['track', 'tracknumber', 'trck', 'trk', 'trkn', 'itrk']],
  ['trackOf', ['tracktotal', 'totaltracks']],
  ['disc', ['disc', 'discnumber', 'disk', 'tpos', 'tpa']],
  ['discOf', ['disctotal', 'totaldiscs']],
  ['compilation', ['compilation', 'tcmp', 'tcp', 'cpil']],
  ['mbRecordingId', ['musicbrainztrackid', 'musicbrainzrecordingid']],
  ['mbReleaseTrackId', ['musicbrainzreleasetrackid']],
  ['mbReleaseId', ['musicbrainzalbumid', 'musicbrainzreleaseid']],
  ['mbReleaseGroupId', ['musicbrainzreleasegroupid']],
  ['mbArtistId', ['musicbrainzartistid']],
  ['mbAlbumArtistId', ['musicbrainzalbumartistid']],
  // `CDEK` is the MP4 atom Audible downloads carry the ASIN in.
  ['asin', ['asin', 'audibleasin', 'cdek']],
  ['isbn', ['isbn']],
  ['narrator', ['narrator', 'narratedby', 'reader', '©nrt']],
  ['composer', ['composer', 'tcom', 'tcm', '©wrt', 'wrt']],
  ['series', ['series', 'seriesname', 'mvnm', '©mvn', 'movementname']],
  ['seriesPart', ['seriespart', 'seriesposition', 'mvin', '©mvi', 'movement']],
];

const KEY_INDEX = new Map<string, TagField>(KEY_TABLE.flatMap(([field, keys]) => keys.map((k) => [k, field] as [string, TagField])));

const KEY_PREFIXES = ['----:com.apple.itunes:', 'com.apple.itunes:', 'txxx:', 'wm/', 'id3:'];

/** Fold a raw tag key from any container into the field it carries, or null. */
export function canonicalTagKey(rawKey: string): TagField | null {
  let key = rawKey.trim().toLowerCase();
  for (const prefix of KEY_PREFIXES) if (key.startsWith(prefix)) key = key.slice(prefix.length);
  // UFID frames carry the recording id when owned by musicbrainz.org.
  if (key === 'ufid:http://musicbrainz.org' || key === 'ufid') return 'mbRecordingId';
  const compact = key.replace(/[^a-z0-9©]/g, '');
  return KEY_INDEX.get(compact) ?? null;
}

/** First usable text of a native tag value (strings, numbers, arrays, `{no, of}`, UFID). */
export function tagValueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.replace(/\0+$/g, '').trim() || null;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).replace(/\0+$/g, '').trim() || null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = tagValueText(v);
      if (t) return t;
    }
    return null;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('no' in o) return o['no'] == null ? null : o['of'] ? `${String(o['no'])}/${String(o['of'])}` : String(o['no']);
    if ('identifier' in o) return tagValueText(o['identifier']);
    if ('text' in o) return tagValueText(o['text']);
    if ('value' in o) return tagValueText(o['value']);
  }
  return null;
}

/** "3", "3/12", "03 of 12" -> {no: 3, of: 12}. Vinyl sides ("A1") give no number. */
export function parseNumberPair(text: string | null): { no: number | null; of: number | null } {
  if (!text) return { no: null, of: null };
  const m = /^\s*(\d{1,4})\s*(?:(?:\/|of)\s*(\d{1,4}))?/i.exec(text);
  if (!m) return { no: null, of: null };
  const no = Number(m[1]);
  const of = m[2] ? Number(m[2]) : null;
  return { no: no > 0 ? no : null, of: of && of > 0 ? of : null };
}

function parseBool(text: string | null): boolean {
  return !!text && /^(1|true|yes)$/i.test(text.trim());
}

/** Picard writes several MBIDs as "a; b" or "a/b"; the first is the primary credit. */
function firstMbid(text: string | null): string | null {
  if (!text) return null;
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
  return m ? m[0].toLowerCase() : text.trim() || null;
}

export type NormalizedTags = Pick<
  AudioTags,
  | 'title'
  | 'artist'
  | 'albumArtist'
  | 'album'
  | 'date'
  | 'trackNo'
  | 'trackOf'
  | 'discNo'
  | 'discOf'
  | 'compilation'
  | 'mbRecordingId'
  | 'mbReleaseTrackId'
  | 'mbReleaseId'
  | 'mbReleaseGroupId'
  | 'mbArtistId'
  | 'mbAlbumArtistId'
  | 'asin'
  | 'isbn'
  | 'narrator'
  | 'composer'
  | 'series'
  | 'seriesPart'
>;

/**
 * Fold raw `[key, value]` entries (in priority order: the first value for a field wins) into
 * normalised tags. Works for music-metadata's native lists and for ffprobe's tag dictionaries.
 */
export function normalizeTagEntries(entries: Iterable<readonly [string, unknown]>): NormalizedTags {
  const raw = new Map<TagField, string>();
  for (const [key, value] of entries) {
    // A UFID owned by someone other than MusicBrainz is not a recording id.
    if (key.toUpperCase() === 'UFID' && value && typeof value === 'object' && 'owner_identifier' in value) {
      if (String((value as { owner_identifier: unknown }).owner_identifier) !== 'http://musicbrainz.org') continue;
    }
    const field = canonicalTagKey(key);
    if (!field || raw.has(field)) continue;
    const text = tagValueText(value);
    if (text) raw.set(field, text);
  }
  const get = (f: TagField) => raw.get(f) ?? null;
  const track = parseNumberPair(get('track'));
  const disc = parseNumberPair(get('disc'));
  return {
    title: get('title'),
    artist: get('artist'),
    albumArtist: get('albumArtist'),
    album: get('album'),
    date: get('date') ?? get('originalDate'),
    trackNo: track.no,
    trackOf: track.of ?? parseNumberPair(get('trackOf')).no,
    discNo: disc.no,
    discOf: disc.of ?? parseNumberPair(get('discOf')).no,
    compilation: parseBool(get('compilation')),
    mbRecordingId: firstMbid(get('mbRecordingId')),
    mbReleaseTrackId: firstMbid(get('mbReleaseTrackId')),
    mbReleaseId: firstMbid(get('mbReleaseId')),
    mbReleaseGroupId: firstMbid(get('mbReleaseGroupId')),
    mbArtistId: firstMbid(get('mbArtistId')),
    mbAlbumArtistId: firstMbid(get('mbAlbumArtistId')),
    asin: get('asin'),
    isbn: get('isbn'),
    narrator: get('narrator'),
    composer: get('composer'),
    series: get('series'),
    seriesPart: get('seriesPart'),
  };
}

// ---------------------------------------------------------------------------------------
// music-metadata
// ---------------------------------------------------------------------------------------

// Native tag families in the order their values are trusted.
const NATIVE_PRIORITY = ['ID3v2.4', 'ID3v2.3', 'ID3v2.2', 'vorbis', 'iTunes', 'APEv2', 'asf', 'matroska', 'exif', 'ID3v1'];

function round(n: number | undefined | null, digits = 0): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function chaptersFrom(meta: IAudioMetadata): AudioChapter[] | null {
  const list = meta.format.chapters;
  // Audiobook containers always report a (possibly empty) list; music files report none.
  if (!list) return /m4b/i.test(meta.format.container ?? '') ? [] : null;
  const toMs = (v: number | undefined, scale: number | undefined) => (v == null ? null : Math.round((v / (scale || 1)) * 1000));
  const chapters = list.map((c, i) => ({
    title: c.title || `Chapter ${i + 1}`,
    startMs: toMs(c.start, c.timeScale) ?? 0,
    endMs: toMs(c.end, c.timeScale),
  }));
  // Fill end times from the next chapter (and the duration for the last one).
  const totalMs = meta.format.duration ? Math.round(meta.format.duration * 1000) : null;
  for (let i = 0; i < chapters.length; i++) chapters[i]!.endMs ??= chapters[i + 1]?.startMs ?? totalMs;
  return chapters;
}

/** music-metadata result -> AudioTags. Exported for tests and for callers that parse buffers. */
export function audioTagsFromMusicMetadata(meta: IAudioMetadata): AudioTags {
  const nativeEntries: Array<[string, unknown]> = [];
  const families = Object.keys(meta.native).sort((a, b) => rank(a) - rank(b));
  for (const family of families) for (const tag of meta.native[family] ?? []) nativeEntries.push([tag.id, tag.value]);
  const fromNative = normalizeTagEntries(nativeEntries);
  const c = meta.common;
  const f = meta.format;
  const tags = emptyAudioTags('music-metadata');
  // music-metadata's common mapping is authoritative where it exists; the native fold fills
  // what it does not cover (narrator, series, ISBN, odd TXXX spellings).
  Object.assign(tags, fromNative, {
    title: c.title ?? fromNative.title,
    artist: c.artist ?? fromNative.artist,
    albumArtist: c.albumartist ?? fromNative.albumArtist,
    album: c.album ?? fromNative.album,
    date: c.date ?? c.originaldate ?? (c.year ? String(c.year) : null) ?? fromNative.date,
    trackNo: c.track.no ?? fromNative.trackNo,
    trackOf: c.track.of ?? fromNative.trackOf,
    discNo: c.disk.no ?? fromNative.discNo,
    discOf: c.disk.of ?? fromNative.discOf,
    compilation: c.compilation ?? fromNative.compilation,
    mbRecordingId: c.musicbrainz_recordingid ?? fromNative.mbRecordingId,
    mbReleaseTrackId: c.musicbrainz_trackid ?? fromNative.mbReleaseTrackId,
    mbReleaseId: c.musicbrainz_albumid ?? fromNative.mbReleaseId,
    mbReleaseGroupId: c.musicbrainz_releasegroupid ?? fromNative.mbReleaseGroupId,
    mbArtistId: c.musicbrainz_artistid?.[0] ?? fromNative.mbArtistId,
    mbAlbumArtistId: c.musicbrainz_albumartistid?.[0] ?? fromNative.mbAlbumArtistId,
    asin: c.asin ?? fromNative.asin,
    isbn: fromNative.isbn,
    composer: c.composer?.[0] ?? fromNative.composer,
    series: fromNative.series ?? c.movement ?? null,
    seriesPart: fromNative.seriesPart ?? (c.movementIndex?.no != null ? String(c.movementIndex.no) : null),
    codec: f.codec ?? null,
    container: f.container ?? null,
    bitrateKbps: round(f.bitrate != null ? f.bitrate / 1000 : null),
    sampleRateHz: round(f.sampleRate),
    bitDepth: round(f.bitsPerSample),
    channels: round(f.numberOfChannels),
    durationMs: f.duration != null && f.duration > 0 ? Math.round(f.duration * 1000) : null,
    lossless: f.lossless ?? null,
    chapters: chaptersFrom(meta),
  } satisfies Partial<AudioTags>);
  if (tags.durationMs != null) tags.durationSource = 'music-metadata';
  return tags;
}

function rank(family: string): number {
  const i = NATIVE_PRIORITY.indexOf(family);
  return i === -1 ? NATIVE_PRIORITY.length : i;
}

export const MUSIC_METADATA_OPTIONS: IOptions = {
  // Headers only: cover art is not decoded (covers come from the folder or the metadata).
  skipCovers: true,
  // Compute the duration even when headers lack it (frame scan for VBR MP3 without Xing).
  duration: true,
  includeChapters: true,
};

export interface MusicMetadataReaderOptions {
  parse?: (path: string, options: IOptions) => Promise<IAudioMetadata>;
}

/** In-process reader. Throws TagReadError('UNREADABLE') when the file has no parsable audio. */
export function createMusicMetadataReader(opts: MusicMetadataReaderOptions = {}): TagReader & {
  readWithMeta(path: string): Promise<{ tags: AudioTags; warnings: string[] }>;
} {
  const parse = opts.parse ?? parseFile;
  const readWithMeta = async (path: string) => {
    let meta: IAudioMetadata;
    try {
      meta = await parse(path, MUSIC_METADATA_OPTIONS);
    } catch (err) {
      throw new TagReadError('UNREADABLE', `${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!meta.format.hasAudio || !meta.format.codec) {
      const warning = meta.quality.warnings[0]?.message;
      throw new TagReadError('UNREADABLE', `${path}: no audio stream found${warning ? ` (${warning})` : ''}`);
    }
    return { tags: audioTagsFromMusicMetadata(meta), warnings: meta.quality.warnings.map((w) => w.message) };
  };
  return { read: async (path) => (await readWithMeta(path)).tags, readWithMeta };
}

// ---------------------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------------------

interface FfprobeAudioJson {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    bits_per_raw_sample?: string;
    bits_per_sample?: number;
    bit_rate?: string;
    duration?: string;
    tags?: Record<string, string>;
  }>;
  chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>;
}

const LOSSLESS_CODECS = /^(flac|alac|ape|wavpack|tta|mlp|truehd|pcm_|dsd_)/;

/** ffprobe JSON (`-show_format -show_streams -show_chapters`) -> AudioTags. */
export function audioTagsFromFfprobe(json: string): AudioTags {
  const data = JSON.parse(json) as FfprobeAudioJson;
  const audio = (data.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new TagReadError('UNREADABLE', 'ffprobe found no audio stream');
  // Container tags first (ID3, MP4, FLAC), then stream tags (Ogg/Opus keep them there).
  const entries: Array<[string, unknown]> = [
    ...Object.entries(data.format?.tags ?? {}),
    ...Object.entries(audio.tags ?? {}),
  ];
  const tags = emptyAudioTags('ffprobe');
  Object.assign(tags, normalizeTagEntries(entries));
  const num = (s: string | number | undefined) => {
    const n = Number(s);
    return s === undefined || s === '' || !Number.isFinite(n) ? null : n;
  };
  const duration = num(data.format?.duration) ?? num(audio.duration);
  const bitrate = num(audio.bit_rate) ?? num(data.format?.bit_rate);
  const depth = num(audio.bits_per_raw_sample) || num(audio.bits_per_sample) || null;
  tags.codec = audio.codec_name ?? null;
  tags.container = data.format?.format_name ?? null;
  tags.bitrateKbps = bitrate != null ? Math.round(bitrate / 1000) : null;
  tags.sampleRateHz = num(audio.sample_rate);
  tags.bitDepth = depth;
  tags.channels = audio.channels ?? null;
  tags.durationMs = duration != null && duration > 0 ? Math.round(duration * 1000) : null;
  tags.durationSource = tags.durationMs != null ? 'ffprobe' : null;
  tags.lossless = audio.codec_name ? LOSSLESS_CODECS.test(audio.codec_name) : null;
  if (data.chapters && (data.chapters.length > 0 || /mp4|m4a|m4b|mov/.test(tags.container ?? ''))) {
    tags.chapters = data.chapters.map((ch, i) => ({
      title: ch.tags?.['title'] ?? `Chapter ${i + 1}`,
      startMs: Math.round((num(ch.start_time) ?? 0) * 1000),
      endMs: num(ch.end_time) != null ? Math.round(num(ch.end_time)! * 1000) : null,
    }));
  }
  return tags;
}

export interface FfprobeTagReaderOptions {
  /** The shared runner (`ffprobeRunnerFor(ctx)`); only its binary lookup is used. */
  runner: Pick<FfprobeRunner, 'locate'>;
  exec?: ExecFn;
  timeoutMs?: number;
}

export function createFfprobeTagReader(opts: FfprobeTagReaderOptions): TagReader & { available(): Promise<boolean> } {
  const exec = opts.exec ?? nodeExec;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    available: async () => (await opts.runner.locate()) !== null,
    async read(path) {
      const bin = await opts.runner.locate();
      if (!bin) throw new TagReadError('FFPROBE_MISSING', 'ffprobe was not found (install ffmpeg or set ARCLIGHT_FFPROBE)');
      let stdout: string;
      try {
        ({ stdout } = await exec(
          bin,
          ['-v', 'error', '-hide_banner', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path],
          { timeoutMs },
        ));
      } catch (err) {
        throw new TagReadError('FFPROBE_FAILED', `${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      try {
        return audioTagsFromFfprobe(stdout);
      } catch (err) {
        if (err instanceof TagReadError) throw new TagReadError(err.code, `${path}: ${err.message}`, { cause: err });
        throw new TagReadError('FFPROBE_FAILED', `${path}: unreadable ffprobe output`, { cause: err });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------------------

/** Durations further apart than this go to ffprobe's value. */
export const DURATION_DISAGREEMENT_MS = 2000;

export interface CombinedTagReaderOptions {
  primary?: TagReader & { readWithMeta?(path: string): Promise<{ tags: AudioTags; warnings: string[] }> };
  /** Omit (or pass a reader whose `available()` is false) to run without ffprobe. */
  ffprobe?: (TagReader & { available?(): Promise<boolean> }) | null;
  /**
   * When to ask ffprobe for a second duration opinion:
   * - `suspect` (default): only when music-metadata reports no duration, parse warnings, or a
   *   duration that does not fit the file size and bitrate (cheap; ffprobe costs ~30-80 ms).
   * - `always`: every file (exact, slow on big libraries).
   * - `never`.
   */
  durationCheck?: 'suspect' | 'always' | 'never';
  /** File size lookup for the `suspect` heuristic (tests). */
  sizeOf?: (path: string) => Promise<number | null>;
}

const defaultSizeOf = async (path: string) => {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
};

/** True when size / duration implies a bitrate more than 25% away from the reported one. */
export function durationLooksSuspect(tags: AudioTags, sizeBytes: number | null, warnings: readonly string[] = []): boolean {
  if (tags.durationMs == null || tags.durationMs <= 0) return true;
  if (warnings.length > 0) return true;
  if (!sizeBytes || !tags.bitrateKbps || tags.lossless) return false;
  const impliedKbps = (sizeBytes * 8) / tags.durationMs; // bits per ms == kbit/s
  return Math.abs(impliedKbps - tags.bitrateKbps) / tags.bitrateKbps > 0.25;
}

/**
 * music-metadata first; ffprobe when it throws, and ffprobe's duration when the two disagree
 * by more than 2 s. Without ffprobe the music-metadata result (or its error) stands.
 */
export function createCombinedTagReader(opts: CombinedTagReaderOptions = {}): TagReader {
  const primary = opts.primary ?? createMusicMetadataReader();
  const ffprobe = opts.ffprobe ?? null;
  const check = opts.durationCheck ?? 'suspect';
  const sizeOf = opts.sizeOf ?? defaultSizeOf;
  let ffAvailable: Promise<boolean> | null = null;
  const hasFfprobe = () => {
    if (!ffprobe) return Promise.resolve(false);
    ffAvailable ??= ffprobe.available ? ffprobe.available() : Promise.resolve(true);
    return ffAvailable;
  };

  return {
    async read(path) {
      let result: { tags: AudioTags; warnings: string[] };
      try {
        result = primary.readWithMeta ? await primary.readWithMeta(path) : { tags: await primary.read(path), warnings: [] };
      } catch (err) {
        if (!ffprobe || !(await hasFfprobe())) throw err;
        return ffprobe.read(path);
      }
      const { tags, warnings } = result;
      if (check === 'never' || !ffprobe || !(await hasFfprobe())) return tags;
      if (check === 'suspect' && !durationLooksSuspect(tags, await sizeOf(path), warnings)) return tags;
      let probed: AudioTags;
      try {
        probed = await ffprobe.read(path);
      } catch {
        return tags; // second opinion is best effort
      }
      if (probed.durationMs != null && (tags.durationMs == null || Math.abs(probed.durationMs - tags.durationMs) > DURATION_DISAGREEMENT_MS)) {
        return { ...tags, durationMs: probed.durationMs, durationSource: 'ffprobe' };
      }
      return tags;
    },
  };
}
