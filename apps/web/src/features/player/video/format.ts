import { PLAYED_THRESHOLD, RESUME_MIN as SHARED_RESUME_MIN, type PlayableChapter, type VideoAudioTrack, type VideoProgress, type VideoSegment, type VideoSubtitleTrack } from '@arclight/shared';
import { getLocale, t } from '../../../i18n/index.js';
import { formatTime } from '../../../i18n/format.js';

// Pure helpers for the Movies & TV pages and the video player: resume rules, track labels,
// where the playhead is among chapters and segments, WebVTT parsing.

/** The resume prompt shows from RESUME_MIN up to (not including) RESUME_MAX of the runtime; at
 * RESUME_MAX (90 %) the server counts the item as watched, so there is nothing left to resume. */
export const RESUME_MIN = SHARED_RESUME_MIN;
export const RESUME_MAX = PLAYED_THRESHOLD;

/** A saved place worth offering to resume (2 % up to 90 % in, not finished). */
export function resumePoint(progress: VideoProgress | null | undefined, durationMs?: number): number | null {
  if (!progress || progress.played) return null;
  const total = progress.durationMs || durationMs || 0;
  if (total <= 0) return null;
  const share = progress.positionMs / total;
  return share >= RESUME_MIN && share < RESUME_MAX ? progress.positionMs : null;
}

/** 0..1 watched share for a progress bar (1 when played). */
export function watchedShare(progress: VideoProgress | null | undefined, played = false): number {
  if (played || progress?.played) return 1;
  if (!progress || progress.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, progress.positionMs / progress.durationMs));
}

/** Clock time "1:02:03" / "4:05". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Runtime "1 h 52 m" / "48 m". */
export function runtimeLabel(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? t('player.browse.time.hoursMinutes', { h, m }) : t('player.browse.time.minutes', { m });
}

/** "Ends at 22:41" for a remaining time from now. */
export function endsAtLabel(remainingMs: number, now = Date.now()): string {
  return t('player.video.endsAt', { time: formatTime(new Date(now + Math.max(0, remainingMs))) });
}

/** "S1 · E2" */
export function episodeCode(season: number | null | undefined, episode: number | null | undefined): string {
  return t('player.video.episodeCode', { season: season ?? 0, episode: episode ?? 0 });
}

const languageNames = new Map<string, Intl.DisplayNames | null>();

/** ISO 639-1/2 → the language's name in the UI locale ("eng" → "English"); the code itself when unknown. */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const tag = ISO_639_2[code.toLowerCase()] ?? code.toLowerCase();
  if (tag === 'und' || tag === 'zxx') return null;
  const locale = getLocale();
  let dn = languageNames.get(locale);
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      dn = null;
    }
    languageNames.set(locale, dn);
  }
  try {
    const name = dn?.of(tag);
    return name && name.toLowerCase() !== tag ? name : code;
  } catch {
    return code;
  }
}

// The three-letter codes ffprobe reports for common languages, mapped to BCP 47.
const ISO_639_2: Record<string, string> = {
  eng: 'en', ger: 'de', deu: 'de', spa: 'es', fre: 'fr', fra: 'fr', dut: 'nl', nld: 'nl', ita: 'it', por: 'pt', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', swe: 'sv', nor: 'no', nob: 'nb', dan: 'da', fin: 'fi', pol: 'pl', cze: 'cs',
  ces: 'cs', hun: 'hu', gre: 'el', ell: 'el', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
  ukr: 'uk', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', ice: 'is', isl: 'is',
  may: 'ms', msa: 'ms', fil: 'fil', tam: 'ta', tel: 'te', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', und: 'und', zxx: 'zxx',
};

/** "5.1" / "Stereo" / "Mono". */
export function channelLabel(channels: number | null): string | null {
  if (!channels) return null;
  if (channels === 1) return t('player.video.mono');
  if (channels === 2) return t('player.video.stereo');
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return t('player.video.channels', { count: channels });
}

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'TrueHD', dts: 'DTS', flac: 'FLAC', opus: 'Opus', mp3: 'MP3',
  vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM',
};

/** "English · Dolby Digital+ 5.1 · Commentary". */
export function audioTrackLabel(track: VideoAudioTrack): { name: string; detail: string } {
  const name = languageName(track.language) ?? t('player.video.trackNumber', { n: track.index + 1 });
  const codec = CODEC_NAMES[track.codec.toLowerCase()] ?? track.codec.toUpperCase();
  const detail = [codec, channelLabel(track.channels), track.title].filter(Boolean).join(' · ');
  return { name, detail };
}

/** "English (Forced)", "Spanish · SDH". */
export function subtitleTrackLabel(track: VideoSubtitleTrack): { name: string; detail: string } {
  const base = languageName(track.language) ?? track.title ?? t('player.video.trackNumber', { n: 1 });
  const flags = [track.forced ? t('player.video.forced') : null, track.hearingImpaired ? t('player.video.sdh') : null, track.text ? null : t('player.video.burnedIn')];
  const detail = [track.source === 'external' ? t('player.video.external') : null, ...flags, track.title && track.title !== base ? track.title : null].filter(Boolean).join(' · ');
  return { name: base, detail };
}

/** The chapter the playhead is in (-1: none). */
export function chapterAt(chapters: readonly PlayableChapter[], ms: number): number {
  let found = -1;
  chapters.forEach((c, i) => {
    if (ms >= c.startMs) found = i;
  });
  return found;
}

/** The intro/recap/credits range the playhead is in. */
export function segmentAt(segments: readonly VideoSegment[] | undefined, ms: number): VideoSegment | null {
  return segments?.find((s) => ms >= s.startMs && ms < s.endMs - 1000) ?? null;
}

/** When the up-next card shows: the credits, else the last 30 s. */
export function upNextFrom(segments: readonly VideoSegment[] | undefined, durationMs: number): number {
  const credits = segments?.find((s) => s.type === 'credits' && s.startMs > durationMs * 0.5);
  return credits ? credits.startMs : Math.max(0, durationMs - 30_000);
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

function vttTime(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]!.padEnd(3, '0'));
}

/** Cues of a WebVTT file, as plain text (markup tags dropped, line breaks kept). */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, rest] = lines[at]!.split('-->');
    const start = vttTime(a ?? '');
    const end = vttTime((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(at + 1)
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (body) cues.push({ startMs: start, endMs: end, text: body });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}

/** Text of the cues showing at media time `ms` (cues are sorted). */
export function cueTextAt(cues: readonly Cue[], ms: number): string {
  const out: string[] = [];
  for (const c of cues) {
    if (c.startMs > ms) break;
    if (ms < c.endMs) out.push(c.text);
  }
  return out.join('\n');
}
