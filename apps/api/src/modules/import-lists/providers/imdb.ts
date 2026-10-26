import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getText, imdbIdOf, int, str } from './http.js';
import { wants, type FetchedItem, type Provider } from './types.js';

export function imdbExportUrl(listId: string): string {
  return listId.startsWith('ur')
    ? `https://www.imdb.com/user/${listId}/watchlist/export`
    : `https://www.imdb.com/list/${listId}/export`;
}

/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF or LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** IMDb title types to library kinds; shorts, episodes, games etc. are skipped. */
function kindOf(titleType: string | null): 'series' | 'movie' | null {
  const t = (titleType ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'tvseries' || t === 'tvminiseries') return 'series';
  if (t === 'movie' || t === 'tvmovie' || t === 'feature' || t === 'video' || t === '') return 'movie';
  return null;
}

/** Parse an IMDb list export: CSV (Const, Title, Year, Title Type) or a JSON array of the same. */
export function parseImdbExport(text: string): FetchedItem[] {
  const trimmed = text.trim();
  const out: FetchedItem[] = [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (cause) {
      throw new ImportListFetchError('bad-response', 'IMDb export is not valid JSON', { cause });
    }
    const rows = Array.isArray(json) ? json : asArray(asRecord(json)?.['items']);
    for (const raw of rows) {
      const r = asRecord(raw);
      const imdbId = imdbIdOf(r?.['const'] ?? r?.['Const'] ?? r?.['imdbId'] ?? r?.['id']);
      const kind = kindOf(str(r?.['titleType'] ?? r?.['Title Type'] ?? r?.['type']));
      if (!r || !imdbId || !kind) continue;
      out.push({ mediaType: kind, imdbId, title: str(r['title'] ?? r['Title']) ?? imdbId, year: int(r['year'] ?? r['Year']) });
    }
    return out;
  }
  const [header, ...rows] = parseCsv(trimmed);
  if (!header) return out;
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const iConst = col('const');
  const iTitle = col('title');
  const iYear = col('year');
  const iType = col('title type');
  if (iConst < 0) throw new ImportListFetchError('bad-response', 'IMDb export has no Const column');
  for (const r of rows) {
    const imdbId = imdbIdOf(r[iConst]);
    const kind = kindOf(iType >= 0 ? (r[iType] ?? null) : null);
    if (!imdbId || !kind) continue;
    out.push({
      mediaType: kind,
      imdbId,
      title: (iTitle >= 0 ? str(r[iTitle]) : null) ?? imdbId,
      year: iYear >= 0 ? int(r[iYear]) : null,
    });
  }
  return out;
}

export const imdbList: Provider<'imdbList'> = async (settings, mediaType, ctx) => {
  const text = await getText(ctx, 'IMDb', imdbExportUrl(settings.listId), { headers: { Accept: 'text/csv, application/json' } });
  return parseImdbExport(text).filter((i) => wants(mediaType, i.mediaType));
};
