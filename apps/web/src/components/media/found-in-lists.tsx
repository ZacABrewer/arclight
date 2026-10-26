import type { MediaType } from '@arclight/shared';
import { useFoundInLists } from '../../hooks/import-lists.js';
import { Chip } from '../../arclight/index.js';

/** "Found in list" chips for a library item's header (GET /importlist/items?tmdbId=). */
export function FoundInLists({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number | undefined }) {
  const found = useFoundInLists(mediaType, tmdbId);
  const lists = [...new Map((found.data ?? []).map((i) => [i.importListId, i.importListName])).entries()];
  if (lists.length === 0) return null;
  return (
    <div className="mk-row" role="list" aria-label="Found in lists" style={{ gap: 8 }}>
      {lists.map(([id, name]) => (
        <Chip key={id} role="listitem" dot="ring" title={`Found in import list ${name}`}>
          {name}
        </Chip>
      ))}
    </div>
  );
}
