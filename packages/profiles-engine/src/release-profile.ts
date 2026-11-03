import type { ReleaseProfile } from '@arclight/shared';
import { LruCache, describeRegexProblem, regexPatternProblem, reportUnsafeRegex } from '@arclight/shared';

/** Compiled term matchers, bounded so one-off terms cannot grow the cache forever. */
const termCache = new LruCache<string, (value: string) => boolean>(512);
/** Longest value a regex term is run against; release titles are far shorter. */
const MAX_MATCH_INPUT = 1024;

const REGEX_TERM = /^\/(.+)\/([a-z]*)$/s;

function regexFlags(flags: string): string {
  return flags.includes('i') ? flags : `${flags}i`;
}

/**
 * Build a matcher for a term. `/pattern/` or `/pattern/flags` is a regex (always
 * case-insensitive); anything else is a case-insensitive substring. A regex that does
 * not compile matches nothing, and so does one that could backtrack catastrophically
 * (stored before such terms were refused), with a logged warning.
 */
export function termMatcher(term: string): (value: string) => boolean {
  const cached = termCache.get(term);
  if (cached) return cached;

  let matcher: (value: string) => boolean;
  const regexForm = REGEX_TERM.exec(term);
  if (regexForm) {
    const [, body = '', flags = ''] = regexForm;
    const problem = regexPatternProblem(body, regexFlags(flags));
    if (problem === null) {
      const re = new RegExp(body, regexFlags(flags));
      matcher = (value) => {
        re.lastIndex = 0;
        return re.test(value.length > MAX_MATCH_INPUT ? value.slice(0, MAX_MATCH_INPUT) : value);
      };
    } else {
      if (problem !== 'invalid') reportUnsafeRegex(body, problem, 'release profile term');
      matcher = () => false;
    }
  } else {
    const needle = term.toLowerCase();
    matcher = (value) => value.toLowerCase().includes(needle);
  }
  termCache.set(term, matcher);
  return matcher;
}

export function matchesTerm(term: string, value: string): boolean {
  return termMatcher(term)(value);
}

/** Terms from the list that match the value. */
export function matchingTerms(terms: ReadonlyArray<string>, value: string): string[] {
  return terms.filter((t) => matchesTerm(t, value));
}

/** Why a term cannot be saved, or null when it can. */
export function termProblem(term: string): string | null {
  const regexForm = REGEX_TERM.exec(term);
  if (!regexForm) return term.trim().length > 0 ? null : 'term is empty';
  const problem = regexPatternProblem(regexForm[1] ?? '', regexFlags(regexForm[2] ?? ''));
  return problem === null ? null : describeRegexProblem(problem);
}

export function isValidTerm(term: string): boolean {
  return termProblem(term) === null;
}

export interface ReleaseProfileSubject {
  title: string;
  /** Tags on the series/movie the release is for. */
  tags: ReadonlyArray<number>;
  indexerId?: number;
}

/** The enabled profiles that apply to an item with these tags, from this indexer. */
export function applicableReleaseProfiles(
  profiles: ReadonlyArray<ReleaseProfile>,
  subject: Pick<ReleaseProfileSubject, 'tags' | 'indexerId'>,
): ReleaseProfile[] {
  return profiles.filter((p) => {
    if (!p.enabled) return false;
    if (p.indexerId !== undefined && p.indexerId !== subject.indexerId) return false;
    return p.tags.length === 0 || p.tags.some((t) => subject.tags.includes(t));
  });
}

export interface ReleaseProfileResult {
  pass: boolean;
  /** Human-readable reasons for each failure; empty when it passes. */
  reasons: string[];
}

/**
 * A title passes when every applicable profile with required terms has at least one of
 * them present, and no applicable profile has an ignored term present.
 */
export function matchesReleaseProfiles(profiles: ReadonlyArray<ReleaseProfile>, subject: ReleaseProfileSubject): ReleaseProfileResult {
  const reasons: string[] = [];

  for (const profile of applicableReleaseProfiles(profiles, subject)) {
    if (profile.required.length > 0 && matchingTerms(profile.required, subject.title).length === 0) {
      reasons.push(`[${profile.name}] missing required term: ${profile.required.join(', ')}`);
    }
    const ignored = matchingTerms(profile.ignored, subject.title);
    if (ignored.length > 0) {
      reasons.push(`[${profile.name}] contains ignored term: ${ignored.join(', ')}`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}
