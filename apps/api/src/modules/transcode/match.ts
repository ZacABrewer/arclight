import type { MediaInfo, TranscodeWhen, TranscodeWindow } from '@arclight/shared';

// Rule matching and schedule windows: pure functions over plain data.

export interface MatchableRule {
  mediaType: 'series' | 'movie' | 'all';
  scope: { kind: 'all' } | { kind: 'tags'; tagIds: number[] } | { kind: 'profiles'; qualityProfileIds: number[] };
  when: TranscodeWhen;
}

export interface MatchableFile {
  mediaType: 'series' | 'movie';
  sizeBytes: number;
  mediaInfo: MediaInfo | null;
}

export interface MatchableParent {
  tags: readonly number[];
  qualityProfileId: number;
}

const CONTAINER_ALIASES: Record<string, string> = { matroska: 'mkv', webm: 'mkv', mov: 'mp4', m4v: 'mp4', mpegts: 'ts' };

export function normalizeContainer(value: string): string {
  const c = value.trim().toLowerCase().replace(/^\./, '').split(',')[0]!.trim();
  return CONTAINER_ALIASES[c] ?? c;
}

const CODEC_ALIASES: Record<string, string> = {
  avc: 'h264',
  x264: 'h264',
  'h.264': 'h264',
  h265: 'hevc',
  'h.265': 'hevc',
  x265: 'hevc',
  av01: 'av1',
  'mpeg-2': 'mpeg2video',
  mpeg2: 'mpeg2video',
  'mpeg-4': 'mpeg4',
  xvid: 'mpeg4',
  divx: 'mpeg4',
  'ac-3': 'ac3',
  'e-ac-3': 'eac3',
  ddp: 'eac3',
  'dts-hd ma': 'dts',
  'true-hd': 'truehd',
};

export function normalizeCodec(value: string): string {
  const c = value.trim().toLowerCase();
  return CODEC_ALIASES[c] ?? c;
}

export function heightOf(info: MediaInfo): number | null {
  if (info.height != null) return info.height;
  const m = /^(\d+)x(\d+)$/.exec(info.resolution ?? '');
  return m ? Number(m[2]) : null;
}

export function isHdr(info: MediaInfo): boolean {
  const range = (info.videoDynamicRangeType ?? info.videoDynamicRange ?? '').trim();
  return range !== '' && range.toUpperCase() !== 'SDR';
}

const GIB = 1024 ** 3;

/** True when every given `when` condition holds for the file. */
export function whenMatches(when: TranscodeWhen, file: MatchableFile): boolean {
  if (when.sizeAboveGb !== undefined && !(file.sizeBytes > when.sizeAboveGb * GIB)) return false;
  const needsInfo =
    when.container !== undefined ||
    when.videoCodec !== undefined ||
    when.audioCodec !== undefined ||
    when.hdr !== undefined ||
    when.resolutionAbove !== undefined ||
    when.bitrateAboveKbps !== undefined;
  if (!needsInfo) return true;
  const info = file.mediaInfo;
  if (!info) return false;
  if (when.container !== undefined && (!info.container || normalizeContainer(info.container) !== normalizeContainer(when.container))) return false;
  if (when.videoCodec !== undefined) {
    const want = normalizeCodec(when.videoCodec);
    const have = [info.videoFormat, info.videoCodec].filter((v): v is string => !!v).map(normalizeCodec);
    if (!have.includes(want)) return false;
  }
  if (when.audioCodec !== undefined) {
    const want = normalizeCodec(when.audioCodec);
    const have = [info.audioFormat, ...(info.audioStreams ?? []).map((s) => s.codec)].filter((v): v is string => !!v).map(normalizeCodec);
    if (!have.includes(want)) return false;
  }
  if (when.hdr !== undefined && isHdr(info) !== when.hdr) return false;
  if (when.resolutionAbove !== undefined) {
    const h = heightOf(info);
    if (h === null || !(h > when.resolutionAbove)) return false;
  }
  if (when.bitrateAboveKbps !== undefined) {
    const bps = info.overallBitrate ?? info.videoBitrate ?? null;
    if (bps === null || !(bps / 1000 > when.bitrateAboveKbps)) return false;
  }
  return true;
}

export function ruleMatches(rule: MatchableRule, file: MatchableFile, parent: MatchableParent | null): boolean {
  if (rule.mediaType !== 'all' && rule.mediaType !== file.mediaType) return false;
  if (rule.scope.kind === 'tags') {
    const ids = new Set(rule.scope.tagIds);
    if (!parent || !parent.tags.some((t) => ids.has(t))) return false;
  } else if (rule.scope.kind === 'profiles') {
    if (!parent || !rule.scope.qualityProfileIds.includes(parent.qualityProfileId)) return false;
  }
  return whenMatches(rule.when, file);
}

// ---- windows ------------------------------------------------------------------------------

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whether `at` (server-local time) falls inside the window. Null is always open; start ==
 * end is open all day; end < start crosses midnight. Start is inclusive, end exclusive.
 */
export function inWindow(window: TranscodeWindow | null | undefined, at: Date): boolean {
  if (!window) return true;
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === end) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}
