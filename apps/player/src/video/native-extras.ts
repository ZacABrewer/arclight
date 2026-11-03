import type { PlayableItem, PlayerSeriesDetails, ProfileSettings, TrickplayManifest, VideoPauseInfo } from '@arclight/shared';
import { t } from '@web/i18n/index';
import { chipLabels } from '../kit/chips';
import type { NativeEpisodeSeason, NativePauseInfo, NativeTrickplay, NativeVideoPrefs, NativeVideoString, NativeVideoTheme } from '../native/definitions';

// The redesign's extra PlayVideoOptions (spec §5.9), built in JS so the native overlay shows
// translated text and the active theme without its own resources: the pause screen, scrub
// thumbnails, the episodes panel, the profile's playback prefs, colours and the overlay strings.

/** "1h 52m" / "45m". */
export function durationLabel(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** "S2 · E5 · The Long Meridian" (null for movies). */
export function episodeLine(p: Pick<VideoPauseInfo, 'seasonNumber' | 'episodeNumber' | 'episodeTitle'>): string | null {
  if (p.seasonNumber == null && p.episodeNumber == null) return null;
  const parts = [p.seasonNumber != null ? `S${p.seasonNumber}` : null, p.episodeNumber != null ? `E${p.episodeNumber}` : null, p.episodeTitle];
  return parts.filter(Boolean).join(' · ');
}

export function pauseInfo(item: PlayableItem): NativePauseInfo | undefined {
  const p = item.pause;
  if (!p) return undefined;
  const meta: NativePauseInfo['meta'] = [];
  if (p.year) meta.push({ text: String(p.year) });
  if (p.certification) meta.push({ text: p.certification, boxed: true });
  if (item.durationMs > 0) meta.push({ text: durationLabel(item.durationMs) });
  for (const c of chipLabels(p.chips, t)) meta.push({ text: c, chip: true });
  return { title: p.title, episodeLine: episodeLine(p), meta, overview: p.overview, logoUrl: p.logoUrl, backdropUrl: p.backdropUrl ?? item.backdropUrl ?? null };
}

/** Scrub thumbnails, only once the sheets are ready. */
export function trickplayOf(m: TrickplayManifest | null | undefined): NativeTrickplay | null {
  if (!m || m.status !== 'ready' || m.sheets.length === 0) return null;
  const { intervalMs, tileWidth, tileHeight, columns, rows, tileCount, sheets } = m;
  return { intervalMs, tileWidth, tileHeight, columns, rows, tileCount, sheets };
}

export function seasonsOf(show: PlayerSeriesDetails): NativeEpisodeSeason[] {
  return show.seasons.map((s) => ({
    seasonNumber: s.seasonNumber,
    title: s.seasonNumber === 0 ? t('app.video.specials') : t('app.video.season', { n: s.seasonNumber }),
    episodes: s.episodes.map((e) => ({
      itemKey: e.itemKey,
      episodeNumber: e.episodeNumber,
      title: e.title ? `${e.episodeNumber}. ${e.title}` : t('app.video.episode', { n: e.episodeNumber }),
      runtime: e.runtimeMinutes ? `${e.runtimeMinutes}m` : null,
      overview: e.overview,
      thumbUrl: e.thumbUrl && /^https?:/i.test(e.thumbUrl) ? e.thumbUrl : null,
      progress: e.played ? 1 : e.progress && e.progress.durationMs > 0 && e.progress.positionMs > 0 ? Math.min(1, e.progress.positionMs / e.progress.durationMs) : null,
      played: e.played,
    })),
  }));
}

export function prefsOf(s: ProfileSettings): NativeVideoPrefs {
  return { subtitleSize: s.subtitleSize, skipIntros: s.skipIntros, autoplayNext: s.autoplayNext, focusStyle: s.focusStyle, reduceMotion: s.reduceMotion };
}

export function videoStrings(): Record<NativeVideoString, string> {
  return {
    upNext: t('app.video.upNext'),
    playNow: t('app.video.playNow'),
    cancel: t('app.video.cancel'),
    nextIn: t('app.video.nextIn', { s: '{s}' }),
    skipIntro: t('app.video.skipIntro'),
    skipRecap: t('app.video.skipRecap'),
    skipCredits: t('app.video.skipCredits'),
    endsAt: t('app.video.endsAt', { time: '{time}' }),
    audioSubtitles: t('app.video.audioSubtitles'),
    audio: t('app.video.audio'),
    subtitles: t('app.video.subtitles'),
    off: t('app.video.off'),
    episodes: t('app.video.episodes'),
    nextEpisode: t('app.video.nextEpisode'),
    nowPlaying: t('app.video.nowPlaying'),
  };
}

// ---- languages -------------------------------------------------------------------------

/** ISO 639-2 (B and T) to 639-1 for the languages files usually carry. */
const TO_639_1: Record<string, string> = {
  eng: 'en', ger: 'de', deu: 'de', spa: 'es', fre: 'fr', fra: 'fr', dut: 'nl', nld: 'nl', ita: 'it', por: 'pt', swe: 'sv', nor: 'no', nob: 'nb',
  dan: 'da', fin: 'fi', pol: 'pl', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs', hun: 'hu', tur: 'tr', gre: 'el',
  ell: 'el', heb: 'he', ara: 'ar', hin: 'hi', tha: 'th', ukr: 'uk', rum: 'ro', ron: 'ro', ice: 'is', isl: 'is', vie: 'vi', ind: 'id',
};

/** One code per language (639-1 where there is one), lower-case; null for unknown or "und". */
export function normLanguage(code: string | null | undefined): string | null {
  const c = code?.trim().toLowerCase();
  if (!c || c === 'und' || !/^[a-z]{2,3}$/.test(c)) return null;
  return TO_639_1[c] ?? c;
}

export const sameLanguage = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normLanguage(a);
  return x !== null && x === normLanguage(b);
};

/** The audio track in the profile's language, else the file's default. */
export function preferredAudio(item: PlayableItem, s: ProfileSettings | null): number | null {
  const tracks = item.video?.audioTracks ?? [];
  const fallback = tracks.find((a) => a.default)?.index ?? null;
  if (!s?.audioLanguage) return fallback;
  const lang = s.audioLanguage;
  return tracks.find((a) => sameLanguage(a.language, lang) && a.default)?.index ?? tracks.find((a) => sameLanguage(a.language, lang))?.index ?? fallback;
}

/**
 * The text subtitle at start. With a profile language: a full (not forced) track in it, else a
 * forced one in it. Subtitles off (null): only a forced track in the audio's language, which
 * carries the foreign-language lines a film expects you to read.
 */
export function preferredSubtitle(item: PlayableItem, s: ProfileSettings, audioIndex: number | null): string | null {
  const subs = (item.video?.subtitleTracks ?? []).filter((x) => x.text);
  if (s.subtitleLanguage) {
    const lang = s.subtitleLanguage;
    return subs.find((x) => sameLanguage(x.language, lang) && !x.forced)?.id ?? subs.find((x) => sameLanguage(x.language, lang))?.id ?? null;
  }
  const audioLang = item.video?.audioTracks.find((a) => a.index === audioIndex)?.language;
  return subs.find((x) => x.forced && (!audioLang || sameLanguage(x.language, audioLang)))?.id ?? null;
}

// ---- theme -------------------------------------------------------------------------------

/** "#rrggbb", or "#aarrggbb" (Android's order) when translucent, from a computed CSS colour. */
export function toHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const out = (r: number, g: number, b: number, a = 1) => (a >= 1 ? `#${byte(r)}${byte(g)}${byte(b)}` : `#${byte(a * 255)}${byte(r)}${byte(g)}${byte(b)}`);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m?.[1]) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
      return out(r ?? 0, g ?? 0, b ?? 0, a === undefined ? 1 : a / 255);
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return out(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m?.[1]) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const v = parts.map((p, i) => (p.endsWith('%') ? (parseFloat(p) / 100) * (i < 3 ? 255 : 1) : parseFloat(p)));
    if (v.length < 3 || v.some((x) => Number.isNaN(x))) return null;
    return out(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
  }
  m = /^color\(srgb\s+([^)]+)\)$/.exec(s);
  if (m?.[1]) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.some((x) => Number.isNaN(x))) return null;
    return out((parts[0] ?? 0) * 255, (parts[1] ?? 0) * 255, (parts[2] ?? 0) * 255, parts[3] ?? 1);
  }
  return null;
}

/** The design's values, used for any token the page cannot resolve. */
export const CINEMA_THEME: NativeVideoTheme = { bg: '#111316', text: '#eef1f4', text2: '#c3c9d1', text3: '#a9b1bb', accent: '#6ef6ff', primaryBg: '#ffffff', primaryText: '#111111', radiusButton: 8, radiusTile: 10 };

/**
 * The player tokens resolved to colours. `resolve` gives a token's computed colour string (the
 * browser resolves var(), color-mix() and oklch() for us), `length` its length in px.
 */
export function themeFrom(resolve: (token: string) => string, length: (token: string) => number): NativeVideoTheme {
  const c = (token: string, fallback: string) => toHex(resolve(token)) ?? fallback;
  const r = (token: string, fallback: number) => {
    const n = length(token);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    bg: c('--al-pl-bg', CINEMA_THEME.bg),
    text: c('--al-pl-text', CINEMA_THEME.text),
    text2: c('--al-pl-text-2', CINEMA_THEME.text2),
    text3: c('--al-pl-text-3', CINEMA_THEME.text3),
    accent: c('--al-pl-accent', CINEMA_THEME.accent),
    primaryBg: c('--al-pl-primary-bg', CINEMA_THEME.primaryBg),
    primaryText: c('--al-pl-primary-text', CINEMA_THEME.primaryText),
    radiusButton: r('--al-pl-radius', CINEMA_THEME.radiusButton),
    radiusTile: r('--al-pl-radius-lg', CINEMA_THEME.radiusTile),
  };
}

/** In the page: resolve each token on a hidden probe element. */
export function documentTheme(): NativeVideoTheme | undefined {
  if (typeof document === 'undefined' || !document.body) return undefined;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  try {
    return themeFrom(
      (token) => {
        probe.style.color = '';
        probe.style.color = `var(${token})`;
        return probe.style.color ? getComputedStyle(probe).color : '';
      },
      (token) => {
        probe.style.borderRadius = '';
        probe.style.borderRadius = `var(${token})`;
        return probe.style.borderRadius ? parseFloat(getComputedStyle(probe).borderTopLeftRadius) : Number.NaN;
      },
    );
  } finally {
    probe.remove();
  }
}
