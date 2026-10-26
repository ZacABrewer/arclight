import type { ImportListItem } from '@media-tron/shared';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { Table, type Column } from '../../../components/table.js';
import { useAddImportListExclusion, useImportListItems } from '../../../hooks/import-lists.js';

export type PreviewItem = Omit<ImportListItem, 'importListId'>;

/** Items a list returned: title, year, type, and whether each is in the library or excluded. */
export function ItemsTable({ items, onExclude, caption }: { items: readonly PreviewItem[]; onExclude?: (item: PreviewItem) => void; caption: string }) {
  const columns: Array<Column<PreviewItem>> = [
    { key: 'title', header: 'Title', sortValue: (i) => i.title, cell: (i) => i.title },
    { key: 'year', header: 'Year', sortValue: (i) => i.year ?? null, cell: (i) => i.year ?? '—', width: '70px' },
    { key: 'type', header: 'Type', cell: (i) => (i.mediaType === 'series' ? 'Series' : 'Movie'), width: '80px' },
    {
      key: 'state',
      header: 'State',
      cell: (i) =>
        i.excluded ? <Badge tone="warning">Excluded</Badge> : i.inLibrary ? <Badge tone="ok">In library</Badge> : <Badge tone="info">New</Badge>,
    },
  ];
  if (onExclude) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        i.excluded ? null : (
          <Button size="sm" variant="ghost" onClick={() => onExclude(i)} aria-label={`Exclude ${i.title}`}>
            Exclude
          </Button>
        ),
    });
  }
  return (
    <Table
      caption={caption}
      columns={columns}
      rows={items}
      rowKey={(i) => `${i.mediaType}-${i.tmdbId}`}
      sortable
      empty="The list returned no items."
    />
  );
}

/** "Preview items" dialog for a saved list (GET /importlist/:id/items). */
export function ItemsPreviewDialog({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const items = useImportListItems(id);
  const exclude = useAddImportListExclusion();
  return (
    <Modal open size="lg" onClose={onClose} title={`Items in ${name}`}>
      {items.isError ? (
        <ErrorView error={items.error} onRetry={() => void items.refetch()} />
      ) : items.isPending ? (
        <LoadingBlock />
      ) : (
        <>
          <p className="muted">
            {items.data.length} item{items.data.length === 1 ? '' : 's'} from the last sync.
          </p>
          <ItemsTable
            caption={`Items in ${name}`}
            items={items.data}
            onExclude={(i) =>
              exclude.mutate(
                { mediaType: i.mediaType, tmdbId: i.tmdbId, title: i.title, year: i.year ?? null },
                { onSuccess: () => void items.refetch() },
              )
            }
          />
        </>
      )}
    </Modal>
  );
}
