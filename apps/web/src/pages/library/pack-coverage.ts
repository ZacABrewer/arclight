import type { ReleasePackCoverage } from '@arclight/shared';
import { t } from '../../i18n/index.js';

// What a series pack in a search result holds: "S01-S03, 36 episodes, 24 wanted".

const pad = (n: number) => `S${String(n).padStart(2, '0')}`;

/** Seasons as compact runs: [1,2,3,5] -> "S01-S03, S05". */
export function seasonRuns(seasons: readonly number[]): string {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `${pad(sorted[i]!)}-${pad(sorted[j]!)}` : pad(sorted[i]!));
    i = j + 1;
  }
  return runs.join(', ');
}

/** The coverage line for a pack; null for a single release. */
export function packCoverageLabel(pack: ReleasePackCoverage | undefined): string | null {
  if (!pack) return null;
  let seasons = seasonRuns(pack.seasons);
  if (pack.part) seasons = t('library.interactiveSearch.packPart', { seasons, part: pack.part });
  if (pack.kind === 'completeSeries') seasons = t('library.interactiveSearch.packComplete', { seasons });
  return t('library.interactiveSearch.packCoverage', { seasons, episodeCount: pack.episodeCount, wantedCount: pack.wantedCount });
}
