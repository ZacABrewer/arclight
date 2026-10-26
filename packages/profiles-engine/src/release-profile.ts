import type { ReleaseProfile } from '@arclight/shared';

const termCache = new Map<string, (value: string) => boolean>();

/**
 * Build a matcher for a term. `/pattern/` or `/pattern/flags` is a regex (always
 * case-insensitive); anything else is a case-insensitive substring. A regex that does
 * not compile matches nothing.
 */
export function termMatcher(term: string): (value: string) => boolean {
  const cached = termCache.get(term);
  if (cached) return cached;

  let matcher: (value: string) => boolean;
  const regexForm = /^\/(.+)\/([a-z]*)$/s.exec(term);
  if (regexForm) {
    const [, body = '', flags = ''] = regexForm;
    try {
      const re = new RegExp(body, flags.includes('i') ? flags : `${flags}i`);
      matcher = (value) => re.test(value);
    } catch {
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

export function isValidTerm(term: string): boolean {
  const regexForm = /^\/(.+)\/([a-z]*)$/s.exec(term);
  if (!regexForm) return term.trim().length > 0;
  try {
    new RegExp(regexForm[1] ?? '', regexForm[2] ?? '');
    return true;
  } catch {
    return false;
  }
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
