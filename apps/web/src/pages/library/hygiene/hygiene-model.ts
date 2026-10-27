import type { DuplicateReason, Episode, HygieneFinding, HygieneMapRequestInput, HygieneParsedGuess, HygieneSuggestion, MediaType } from '@arclight/shared';
import { episodeCode } from '../../../components/media/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for Library → Hygiene: guesses, suggestions, duplicate groups, map requests.

/** Last path segment (either separator). */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Folder part of a path, without the trailing separator. */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}

/** "Severance (2022) · S01E03-E04 · WEBDL-1080p · NTb", or "No guess". */
export function guessLabel(parsed: HygieneParsedGuess | null): string {
  if (!parsed || (!parsed.title && parsed.seasonNumber === null && parsed.episodeNumbers.length === 0)) return t('library.hygiene.noGuess');
  const parts: string[] = [];
  if (parsed.title) parts.push(parsed.year ? `${parsed.title} (${parsed.year})` : parsed.title);
  if (parsed.seasonNumber !== null && parsed.episodeNumbers.length) {
    const [first, ...rest] = parsed.episodeNumbers;
    const last = rest.at(-1);
    parts.push(`${episodeCode(parsed.seasonNumber, first ?? 0)}${last !== undefined ? `-E${String(last).padStart(2, '0')}` : ''}`);
  } else if (parsed.seasonNumber !== null) {
    parts.push(t('library.hygiene.seasonSeasonnumber', { seasonNumber: parsed.seasonNumber }));
  }
  if (parsed.quality) parts.push(parsed.quality);
  if (parsed.releaseGroup) parts.push(parsed.releaseGroup);
  return parts.join(' · ');
}

/** Highest-scoring suggestion, if any. */
export function bestSuggestion(f: Pick<HygieneFinding, 'suggestions'>): HygieneSuggestion | undefined {
  let best: HygieneSuggestion | undefined;
  for (const s of f.suggestions) if (!best || s.score > best.score) best = s;
  return best;
}

/** "Severance (2022) · 92%" ; "in folder" when the file sits inside the item's folder. */
export function suggestionLabel(s: HygieneSuggestion): string {
  const match = s.score >= 1 ? 'in folder' : `${Math.round(s.score * 100)}%`;
  return `${s.title} (${s.year}) · ${match}`;
}

export interface MapDraft {
  mediaType: MediaType;
  seriesId: number | null;
  episodeIds: number[];
  movieId: number | null;
  importMode: 'auto' | 'move' | 'copy';
}

/** The Map dialog's starting point: best suggestion, else the parser's media type. */
export function initialMapDraft(f: Pick<HygieneFinding, 'suggestions' | 'parsed'>): MapDraft {
  const s = bestSuggestion(f);
  const mediaType: MediaType = s?.mediaType ?? f.parsed?.mediaType ?? 'series';
  return {
    mediaType,
    seriesId: s?.mediaType === 'series' ? (s.seriesId ?? null) : null,
    episodeIds: s?.mediaType === 'series' ? [...(s.episodeIds ?? [])] : [],
    movieId: s?.mediaType === 'movie' ? (s.movieId ?? null) : null,
    importMode: 'move',
  };
}

/** Body for POST /library/hygiene/:id/map, or why it cannot be sent yet. */
export function buildMapRequest(d: MapDraft): { ok: true; body: HygieneMapRequestInput } | { ok: false; error: string } {
  if (d.mediaType === 'movie') {
    if (d.movieId === null) return { ok: false, error: t('library.hygiene.pickAMovie') };
    return { ok: true, body: { mediaType: 'movie', movieId: d.movieId, importMode: d.importMode } };
  }
  if (d.seriesId === null) return { ok: false, error: t('library.hygiene.pickASeries') };
  if (d.episodeIds.length === 0) return { ok: false, error: t('library.hygiene.pickAtLeastOneEpisode') };
  return { ok: true, body: { mediaType: 'series', seriesId: d.seriesId, episodeIds: [...d.episodeIds].sort((a, b) => a - b), importMode: d.importMode } };
}

/** Episodes grouped by season (ascending), for the checkbox list. */
export function episodesBySeason(episodes: readonly Episode[]): Array<{ season: number; episodes: Episode[] }> {
  const map = new Map<number, Episode[]>();
  for (const e of episodes) {
    const list = map.get(e.seasonNumber) ?? [];
    list.push(e);
    map.set(e.seasonNumber, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, list]) => ({ season, episodes: list.sort((a, b) => a.episodeNumber - b.episodeNumber) }));
}

export interface DuplicateEntry {
  path: string;
  /** The finding for this path (deletable), absent for a copy the scan only referenced. */
  finding?: HygieneFinding;
}

export interface DuplicateGroup {
  key: string;
  reason: DuplicateReason | null;
  entries: DuplicateEntry[];
  sizeBytes: number;
}

/**
 * Groups duplicate findings: a finding plus its `duplicateOf` paths form one group, so every
 * file of a set shows once. Groups are ordered by size (biggest first).
 */
export function groupDuplicates(records: readonly HygieneFinding[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  const byPath = new Map<string, HygieneFinding>();
  for (const r of records) if (r.type === 'duplicate') byPath.set(r.path, r);
  for (const r of records) {
    if (r.type !== 'duplicate') continue;
    const paths = [...new Set([r.path, ...r.duplicateOf])].sort();
    const key = paths.join('\n');
    if (groups.has(key)) continue;
    const entries = paths.map((path) => {
      const finding = byPath.get(path);
      return finding ? { path, finding } : { path };
    });
    groups.set(key, { key, reason: r.duplicateReason, entries, sizeBytes: r.sizeBytes });
  }
  return [...groups.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || a.key.localeCompare(b.key));
}

/** The path to keep by default: the library copy (a path with no finding, or the finding that is a media file). */
export function defaultKeep(group: DuplicateGroup): string {
  const reference = group.entries.find((e) => !e.finding);
  if (reference) return reference.path;
  const library = group.entries.find((e) => e.finding?.mediaFileId !== null && e.finding?.mediaFileId !== undefined);
  return (library ?? group.entries[0])?.path ?? '';
}

/**
 * "Delete all duplicates": every set keeps its default copy (the library's), and no path that
 * any set keeps is deleted, even when it also appears as a spare copy in another set.
 */
export function bulkDuplicateDeletion(groups: readonly DuplicateGroup[]): { findings: HygieneFinding[]; sets: number } {
  const keep = new Set(groups.map((g) => defaultKeep(g)));
  const out = new Map<number, HygieneFinding>();
  let sets = 0;
  for (const g of groups) {
    const spare = g.entries.filter((e) => e.finding && !keep.has(e.path)).map((e) => e.finding as HygieneFinding);
    if (spare.length > 0) sets++;
    for (const f of spare) out.set(f.id, f);
  }
  return { findings: [...out.values()], sets };
}

/** Findings deleted by "Delete others" when `keep` is kept. */
export function deletableExcept(group: DuplicateGroup, keep: string): HygieneFinding[] {
  return group.entries.filter((e) => e.path !== keep && e.finding).map((e) => e.finding as HygieneFinding);
}

export const DUPLICATE_REASON_LABEL: Record<DuplicateReason, string> = {
  get episode() {
    return t('library.hygiene.sameEpisode');
  },
  get movie() {
    return t('library.hygiene.sameMovie');
  },
  get content() {
    return t('library.hygiene.identicalContent');
  },
};
