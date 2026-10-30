import {
  LANGUAGE_PROFILE_CUTOFF_ANY,
  type LanguageProfile,
  type LanguageProfileItem,
  type SubtitleLanguageRef,
} from '@arclight/shared';
import { parseLanguageTag, type HiPreference, type WantedLanguage } from '@arclight/subtitles';

// Pure wanted computation (spec section 3): which profile languages a media file still lacks.

/** One desired entry of a profile: a profile item expanded to a concrete (forced, HI) request. */
export interface DesiredEntry {
  /** Profile item code this entry came from. */
  code: string;
  tag: string;
  forced: boolean;
  hi: HiPreference;
}

/** A subtitle present for a file (external or embedded). */
export interface PresentSubtitle {
  language: string;
  forced: boolean;
  hi: boolean;
  embedded: boolean;
}

export interface MissingOptions {
  /** Embedded tracks satisfy wanted entries (embedded mode `present`). */
  countEmbedded: boolean;
}

export function normalizeTag(code: string): string {
  return parseLanguageTag(code) ?? code.trim().toLowerCase();
}

function hiFor(mode: LanguageProfileItem['hi']): HiPreference {
  if (mode === 'only') return 'required';
  if (mode === 'never') return 'excluded';
  return 'normal';
}

/** Expand profile items: forced also = full + forced entries; HI mode maps to the search mode. */
export function desiredEntries(profile: Pick<LanguageProfile, 'languages'>): DesiredEntry[] {
  const out: DesiredEntry[] = [];
  for (const item of profile.languages) {
    const tag = normalizeTag(item.code);
    if (item.forced !== 'only') out.push({ code: item.code, tag, forced: false, hi: hiFor(item.hi) });
    if (item.forced !== 'never') out.push({ code: item.code, tag, forced: true, hi: 'normal' });
  }
  return out;
}

/** Same language: equal tags, or the desired base tag is satisfied by a regional variant (en <- en-US). */
export function languageMatches(desiredTag: string, presentTag: string): boolean {
  const d = normalizeTag(desiredTag);
  const p = normalizeTag(presentTag);
  if (d === p) return true;
  return !d.includes('-') && p.split('-')[0] === d;
}

/** R3.6 matching rules between one desired entry and one present subtitle. */
export function satisfies(entry: DesiredEntry, sub: PresentSubtitle): boolean {
  if (!languageMatches(entry.tag, sub.language)) return false;
  if (entry.forced !== sub.forced) return false;
  if (entry.forced) return true;
  if (entry.hi === 'required') return sub.hi;
  if (entry.hi === 'excluded') return !sub.hi;
  return true;
}

export function toRef(entry: DesiredEntry): SubtitleLanguageRef {
  return { language: entry.tag, forced: entry.forced, hi: !entry.forced && entry.hi === 'required' };
}

export function toWantedLanguage(entry: DesiredEntry): WantedLanguage {
  return { tag: entry.tag, forced: entry.forced, hi: entry.hi };
}

/** R1.4 language string: "en", "en:forced", "en:hi". */
export function languageKey(ref: { language: string; forced: boolean; hi: boolean }): string {
  if (ref.forced) return `${ref.language}:forced`;
  if (ref.hi) return `${ref.language}:hi`;
  return ref.language;
}

let englishNames: Intl.DisplayNames | null | undefined;

/** English name of a language tag ("pt-BR" -> "Brazilian Portuguese"), the tag itself when unknown. */
export function languageDisplayName(tag: string): string {
  if (englishNames === undefined) {
    try {
      englishNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      englishNames = null;
    }
  }
  try {
    return englishNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Entries still missing for a file. Cutoff (R3.8): when the cutoff item (or, with `*`, any
 * item) is satisfied nothing is wanted; null cutoff wants every entry.
 */
export function missingEntries(
  profile: Pick<LanguageProfile, 'languages' | 'cutoff'> | null,
  present: readonly PresentSubtitle[],
  opts: MissingOptions,
): DesiredEntry[] {
  if (!profile) return [];
  const counted = present.filter((s) => opts.countEmbedded || !s.embedded);
  const desired = desiredEntries(profile);
  const isSatisfied = (e: DesiredEntry) => counted.some((s) => satisfies(e, s));
  if (profile.cutoff) {
    const candidates =
      profile.cutoff === LANGUAGE_PROFILE_CUTOFF_ANY
        ? desired
        : desired.filter((e) => normalizeTag(e.code) === normalizeTag(profile.cutoff ?? ''));
    if (candidates.some(isSatisfied)) return [];
  }
  return desired.filter((e) => !isSatisfied(e));
}

/** Language entries still desired by the profile for upgrades (R8.4). */
export function desiredForUpgrade(profile: Pick<LanguageProfile, 'languages'>, ref: SubtitleLanguageRef): DesiredEntry | undefined {
  return desiredEntries(profile).find((e) => satisfies(e, { ...ref, embedded: false }));
}

// ---------------------------------------------------------------------------------------
// Adaptive backoff (R3.22-R3.26)
// ---------------------------------------------------------------------------------------

export interface AttemptState {
  firstAttempt: string;
  lastAttempt: string;
}

export interface BackoffSettings {
  adaptiveSearching: boolean;
  adaptiveDelayMs: number;
  adaptiveDeltaMs: number;
}

/**
 * Whether a language may be searched now: no attempt yet, still inside the intensive window
 * after the first attempt, or the last attempt is at least `delta` ago. Unparsable state searches.
 */
export function shouldSearch(state: AttemptState | undefined, settings: BackoffSettings, now: number): boolean {
  if (!settings.adaptiveSearching || !state) return true;
  const first = Date.parse(state.firstAttempt);
  const last = Date.parse(state.lastAttempt);
  if (Number.isNaN(first) || Number.isNaN(last)) return true;
  if (now < first + settings.adaptiveDelayMs) return true;
  return last + settings.adaptiveDeltaMs <= now;
}
