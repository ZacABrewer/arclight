// Top-bar search: library items whose title matches what is typed. Pure for testing.

export interface LibraryMatch {
  kind: 'series' | 'movie';
  id: number;
  title: string;
  year: number | null;
}

interface Titled {
  id: number;
  title: string;
  year?: number | null | undefined;
  sortTitle?: string | undefined;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every word of the query must appear in the title. Titles starting with the query rank
 * first, then alphabetical. Series before movies on ties.
 */
export function libraryMatches(query: string, series: readonly Titled[], movies: readonly Titled[], limit = 8): LibraryMatch[] {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored: Array<{ m: LibraryMatch; starts: boolean; key: string }> = [];
  const add = (kind: LibraryMatch['kind'], list: readonly Titled[]) => {
    for (const item of list) {
      const t = normalize(item.title);
      if (!words.every((w) => t.includes(w))) continue;
      scored.push({ m: { kind, id: item.id, title: item.title, year: item.year ?? null }, starts: t.startsWith(q), key: t });
    }
  };
  add('series', series);
  add('movie', movies);
  scored.sort((a, b) => Number(b.starts) - Number(a.starts) || a.key.localeCompare(b.key) || (a.m.kind === b.m.kind ? 0 : a.m.kind === 'series' ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.m);
}
