import type { MediaType } from '@arclight/shared';
import { useFoundInLists } from '../../hooks/import-lists.js';
import { Chip } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

/** "Found in list" chips for a library item's header (GET /importlist/items?tmdbId=). */
export function FoundInLists({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number | undefined }) {
  const found = useFoundInLists(mediaType, tmdbId);
  const lists = [...new Map((found.data ?? []).map((i) => [i.importListId, i.importListName])).entries()];
  if (lists.length === 0) return null;
  return (
    <div className="mk-row" role="list" aria-label={t('components.media.foundInLists.foundInLists')} style={{ gap: 8 }}>
      {lists.map(([id, name]) => (
        <Chip key={id} role="listitem" dot="ring" title={t('components.media.foundInLists.foundInImportListName', { name })}>
          {name}
        </Chip>
      ))}
    </div>
  );
}
