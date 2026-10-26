import { baseTag, languageName, parseLanguageTag } from '@arclight/subtitles';
import type { MediaInfo, MediaVersion } from '@arclight/shared';

// Pure language helpers for "Add additional…" (no database). Shared by the releases decision
// engine (required audio languages), the library cutoff check, imports (version slot choice)
// and the subtitles wanted computation, so they live in one file without module imports.
//
// Every language is compared by its base tag: "pt-BR" audio satisfies a "pt" requirement and
// the other way round, because release names and container tags rarely carry the region.

const UNKNOWN = new Set(['und', 'unknown', 'zxx', 'mis', 'mul', 'qaa', '']);

/** Any spelling ("spa", "Spanish", "es", "Spanish (Latino)", "pt_br") to a tag; null when unknown. */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (UNKNOWN.has(s.toLowerCase())) return null;
  const direct = parseLanguageTag(s);
  if (direct) return direct;
  // Parser names like "Spanish (Latino)" / "Portuguese (Brazil)": the base name is enough.
  const paren = s.indexOf(' (');
  if (paren > 0) return parseLanguageTag(s.slice(0, paren)) ?? null;
  return null;
}

/** Base tag of a normalised language ("pt-BR" -> "pt"). */
export function languageBase(tag: string): string {
  return baseTag(tag);
}

/** De-duplicated base tags of a list of spellings; unknown entries dropped. */
export function baseLanguages(list: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const tag = normalizeLanguage(raw);
    if (!tag) continue;
    const b = baseTag(tag);
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

export function displayLanguage(tag: string): string {
  return languageName(tag);
}

/**
 * Audio languages of a library file from its media analysis (ffprobe stream tags), as base
 * tags. Null when unknown: not analysed yet, or every track is untagged. With `fallback`, an
 * unanalysed file falls back to the languages parsed from its release name at import.
 */
export function fileAudioLanguages(
  file: { mediaInfo?: MediaInfo | null | undefined; languages?: readonly string[] | undefined },
  opts: { fallback?: boolean } = {},
): string[] | null {
  const info = file.mediaInfo;
  if (info) {
    const streams = info.audioStreams?.map((a) => a.language) ?? [];
    const langs = baseLanguages(streams.length > 0 ? streams : (info.audioLanguages ?? []));
    if (langs.length > 0) return langs;
  }
  if (opts.fallback) {
    const parsed = baseLanguages(file.languages ?? []);
    if (parsed.length > 0) return parsed;
  }
  return null;
}

// "MULTi.Subs" / "Dual.Subs" are about subtitles, not audio.
const MULTI_TAG = /(?<![a-z0-9])(?:multi(?:[ ._-]?(?:audio|lang(?:uage)?s?))?|multilang|dual(?:[ ._-]?audio)?)(?![a-z0-9])(?![ ._-]?sub)/i;
const DUAL_TAG = /(?<![a-z0-9])dual(?:[ ._-]?audio)?(?![a-z0-9])/i;

/**
 * Audio languages a release carries, judged from its name (base tags). The parser's languages
 * come first; a release that names none is in the title's original language. A MULTi / Dual
 * Audio tag adds the original language (dual audio with nothing else named is the original
 * plus English, the usual anime/foreign-film pairing).
 */
export function releaseAudioLanguages(title: string, parsedLanguages: readonly string[], originalLanguage: string | null | undefined): string[] {
  const original = normalizeLanguage(originalLanguage ?? '') ? baseTag(normalizeLanguage(originalLanguage ?? '')!) : null;
  const named = baseLanguages(parsedLanguages.map((l) => (l === 'original' ? (originalLanguage ?? null) : l)));
  const out = [...named];
  const add = (l: string | null) => {
    if (l && !out.includes(l)) out.push(l);
  };
  if (MULTI_TAG.test(title)) {
    add(original);
    if (DUAL_TAG.test(title) && named.length === 0 && original !== 'en') add('en');
  }
  if (out.length === 0) add(original);
  return out;
}

/** Required languages (any spelling) missing from `have` (base tags), as base tags. */
export function missingLanguages(required: readonly string[], have: readonly string[]): string[] {
  const set = new Set(have.map((h) => baseTag(h)));
  return baseLanguages(required).filter((r) => !set.has(r));
}

// ---- scopes ---------------------------------------------------------------------------------

export interface ScopeRow {
  mediaType: 'series' | 'movie';
  movieId: number | null;
  seriesId: number | null;
  seasonNumber: number | null;
  episodeId: number | null;
}

/** Key of one saved scope (see schema.ts). */
export function scopeKeyOf(s: Pick<ScopeRow, 'movieId' | 'seriesId' | 'seasonNumber' | 'episodeId'>): string {
  if (s.movieId !== null) return `movie:${s.movieId}`;
  if (s.episodeId !== null) return `series:${s.seriesId}:e${s.episodeId}`;
  if (s.seasonNumber !== null) return `series:${s.seriesId}:s${s.seasonNumber}`;
  return `series:${s.seriesId}`;
}

/** What a file / release / item covers, for matching saved scopes. */
export interface CoveredItem {
  movieId?: number | null | undefined;
  seriesId?: number | null | undefined;
  /** Episodes with their season (a multi-episode file or a season pack covers several). */
  episodes?: ReadonlyArray<{ id: number; seasonNumber: number }> | undefined;
}

/** Whether a saved row applies to (any part of) an item. A series-wide row applies to every episode. */
export function scopeApplies(row: ScopeRow, item: CoveredItem): boolean {
  if (row.movieId !== null) return item.movieId === row.movieId;
  if (row.seriesId === null || item.seriesId !== row.seriesId) return false;
  if (row.episodeId === null && row.seasonNumber === null) return true;
  const eps = item.episodes ?? [];
  // Asking about the series as a whole (no episodes): narrower rows still "apply" to part of it.
  if (eps.length === 0) return true;
  if (row.episodeId !== null) return eps.some((e) => e.id === row.episodeId);
  return eps.some((e) => e.seasonNumber === row.seasonNumber);
}

// ---- required audio ---------------------------------------------------------------------------

export interface AudioRequirementRow extends ScopeRow {
  kind: 'audio' | 'subtitle';
  language: string;
  mode: 'replace' | 'version' | null;
}

export interface RequiredAudio {
  /** Base tags a release must carry. */
  languages: string[];
  /** Also require every language the existing file(s) being replaced have (replace mode). */
  keepExisting: boolean;
}

/**
 * Audio a release must carry to fill an item's slot: the slot's own `audioLanguages` (version
 * mode), else every saved replace-mode requirement that applies to the item. Null = none.
 */
export function requiredAudioFor(
  rows: readonly AudioRequirementRow[],
  item: CoveredItem,
  slot: Pick<MediaVersion, 'audioLanguages'> | null | undefined,
): RequiredAudio | null {
  const own = baseLanguages(slot?.audioLanguages ?? []);
  if (own.length > 0) return { languages: own, keepExisting: false };
  const langs = baseLanguages(rows.filter((r) => r.kind === 'audio' && r.mode === 'replace' && scopeApplies(r, item)).map((r) => r.language));
  return langs.length > 0 ? { languages: langs, keepExisting: true } : null;
}

/**
 * Version slot preference for a release or file with these audio languages: 2 = the slot asks
 * for languages and all are present (it wins), 1 = the slot asks for none, 0 = it asks for a
 * language that is missing.
 */
export function slotLanguageFit(slot: Pick<MediaVersion, 'audioLanguages'>, have: readonly string[]): 0 | 1 | 2 {
  const want = slot.audioLanguages ?? [];
  if (want.length === 0) return 1;
  return missingLanguages(want, have).length === 0 ? 2 : 0;
}
