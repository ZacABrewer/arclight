// OpenLibrary Covers API URL builders. Nothing is fetched: covers.openlibrary.org serves the
// image directly. By default it answers a missing cover with a 1×1 blank; `default=false`
// makes it answer 404 instead, so callers can show their own placeholder.

export const OPENLIBRARY_COVERS_BASE_URL = 'https://covers.openlibrary.org';

/** S ≈ 45 px wide, M ≈ 180 px, L = original-ish. */
export type OlCoverSize = 'S' | 'M' | 'L';

export type OlCoverKey =
  | { id: number }
  | { isbn: string }
  | { olid: string }
  | { oclc: string }
  | { lccn: string };

export interface OlCoverOptions {
  size?: OlCoverSize;
  /** 404 instead of a blank image when there is no cover. Defaults to true. */
  notFoundAs404?: boolean;
  baseUrl?: string;
}

function build(kind: 'b' | 'a', key: string, value: string, options: OlCoverOptions): string {
  const root = (options.baseUrl ?? OPENLIBRARY_COVERS_BASE_URL).replace(/\/+$/, '');
  const size = options.size ?? 'L';
  const suffix = options.notFoundAs404 === false ? '' : '?default=false';
  return `${root}/${kind}/${key}/${encodeURIComponent(value)}-${size}.jpg${suffix}`;
}

function keyOf(cover: OlCoverKey): [string, string] {
  if ('id' in cover) {
    if (!Number.isInteger(cover.id) || cover.id <= 0) {
      throw new RangeError(`${cover.id} is not an OpenLibrary cover id`);
    }
    return ['id', String(cover.id)];
  }
  if ('isbn' in cover) return ['isbn', cover.isbn.replace(/[\s-]/g, '')];
  if ('olid' in cover) return ['olid', cover.olid];
  if ('oclc' in cover) return ['oclc', cover.oclc];
  return ['lccn', cover.lccn];
}

/** Book cover, e.g. `https://covers.openlibrary.org/b/id/12455001-L.jpg?default=false`. */
export function openLibraryCoverUrl(cover: OlCoverKey, options: OlCoverOptions = {}): string {
  const [key, value] = keyOf(cover);
  return build('b', key, value, options);
}

/** Author photo by photo id or author OLID. */
export function openLibraryAuthorPhotoUrl(
  photo: { id: number } | { olid: string },
  options: OlCoverOptions = {},
): string {
  const [key, value] = keyOf(photo);
  return build('a', key, value, options);
}
