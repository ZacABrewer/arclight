import type { MediaType } from '@arclight/shared';
import { useFoundInLists } from '../../hooks/import-lists.js';

/** "Found in list" chips for a library item's header (GET /importlist/items?tmdbId=). */
export function FoundInLists({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number | undefined }) {
  const found = useFoundInLists(mediaType, tmdbId);
  const lists = [...new Map((found.data ?? []).map((i) => [i.importListId, i.importListName])).entries()];
  if (lists.length === 0) return null;
  return (
    <div className="chip-group found-in-lists" role="list" aria-label="Found in lists">
      {lists.map(([id, name]) => (
        <span key={id} role="listitem" className="chip chip-on" title={`Found in import list ${name}`}>
          {name}
        </span>
      ))}
    </div>
  );
}
