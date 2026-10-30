import { z } from 'zod';

// Universal search (topbar search, command palette) and GET /search/universal. The matcher is
// shared so the server-side lookups and the browser rank the same way: exact, then prefix,
// then word-prefix, substring and finally loose (subsequence) matches.

/** Lower case, accents dropped, everything but letters and digits turned into single spaces. */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of a query, normalized. */
export function searchWords(query: string): string[] {
  const n = normalizeSearch(query);
  return n ? n.split(' ') : [];
}

/** True when every character of `token` appears in `word` in order, starting with its first. */
function isSubsequence(token: string, word: string): boolean {
  if (!token || token[0] !== word[0]) return false;
  let i = 0;
  for (const ch of word) if (ch === token[i]) i += 1;
  return i >= token.length;
}

/** How well one query word matches one text word: 4 exact, 3 prefix, 2 substring, 1 loose, 0 none. */
export function scoreWord(token: string, word: string): number {
  if (!token || !word) return 0;
  if (word === token) return 4;
  if (word.startsWith(token)) return 3;
  if (token.length >= 3 && word.includes(token)) return 2;
  if (token.length >= 2 && isSubsequence(token, word)) return 1;
  return 0;
}

/** Best score of `token` against any of `words`. */
export function bestWordScore(token: string, words: readonly string[]): number {
  let best = 0;
  for (const w of words) {
    const s = scoreWord(token, w);
    if (s > best) best = s;
    if (best === 4) break;
  }
  return best;
}

/**
 * How well `query` matches `text` (plus optional extra keywords): 0 when some query word
 * matches nothing. Higher is better; whole-text exact and prefix matches rank first, shorter
 * texts break ties.
 */
export function matchScore(query: string, text: string, keywords: readonly string[] = []): number {
  const q = normalizeSearch(query);
  if (!q) return 0;
  const t = normalizeSearch(text);
  const tokens = q.split(' ');
  const words = [...(t ? t.split(' ') : []), ...keywords.flatMap((k) => searchWords(k))];
  let sum = 0;
  for (const token of tokens) {
    const s = bestWordScore(token, words);
    if (s === 0) return 0;
    sum += s;
  }
  let score = sum * 10;
  if (t === q) score += 1000;
  else if (t.startsWith(q)) score += 600;
  else if (t.includes(q)) score += 200;
  // Shorter texts first among equals (at most a few points, never above a word step).
  return score + Math.max(0, 5 - t.length / 20);
}

/** Items that match `query`, best first (stable for equal scores). */
export function rankMatches<T>(query: string, items: readonly T[], text: (item: T) => string, keywords?: (item: T) => readonly string[]): Array<{ item: T; score: number }> {
  const out: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const score = matchScore(query, text(item), keywords?.(item) ?? []);
    if (score > 0) out.push({ item, score, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.map(({ item, score }) => ({ item, score }));
}

// ---------------------------------------------------------------------------------------
// GET /search/universal
// ---------------------------------------------------------------------------------------

export const UniversalSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** Hits per kind (the total is counted up to `UNIVERSAL_SEARCH_SCAN` candidates). */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type UniversalSearchQuery = z.infer<typeof UniversalSearchQuery>;
export type UniversalSearchQueryInput = z.input<typeof UniversalSearchQuery>;

/** Candidates read per kind before ranking. */
export const UNIVERSAL_SEARCH_SCAN = 200;

export const UniversalSearchKind = z.enum([
  // Library
  'series',
  'movie',
  'episode',
  'artist',
  'album',
  'author',
  'book',
  // Settings entities
  'indexer',
  'downloadClient',
  'notification',
  'importList',
  'qualityProfile',
  'customFormat',
  'user',
  'tag',
  // System
  'task',
  // Activity
  'queue',
  'history',
  // Requests and issues
  'request',
  'issue',
]);
export type UniversalSearchKind = z.infer<typeof UniversalSearchKind>;

export const UniversalSearchHit = z.object({
  kind: UniversalSearchKind,
  /** Row id; scheduled tasks use their name. */
  id: z.union([z.number().int(), z.string()]),
  title: z.string(),
  /** Year, parent title ("Severance · S01E02"), state… */
  subtitle: z.string().nullable(),
  /** Poster / cover URL as the library stores it. */
  poster: z.string().nullable(),
  /** Short machine status ("monitored", "missing", "pending", "downloading"…). */
  status: z.string().nullable(),
  /** Parent row: the series of an episode, the artist of an album, the author of a book. */
  parentId: z.number().int().nullable(),
  score: z.number(),
});
export type UniversalSearchHit = z.infer<typeof UniversalSearchHit>;

export const UniversalSearchKindResult = z.object({
  kind: UniversalSearchKind,
  /** Matches found (of at most UNIVERSAL_SEARCH_SCAN candidates). */
  total: z.number().int(),
  hits: z.array(UniversalSearchHit),
});
export type UniversalSearchKindResult = z.infer<typeof UniversalSearchKindResult>;

export const UniversalSearchResponse = z.object({
  query: z.string(),
  /** Only kinds the caller may see and that matched something. */
  results: z.array(UniversalSearchKindResult),
});
export type UniversalSearchResponse = z.infer<typeof UniversalSearchResponse>;
