import type { ImportListItem } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Modal, Skeleton, Table, type Column } from '../../../arclight/index.js';
import { useAddImportListExclusion, useImportListItems } from '../../../hooks/import-lists.js';

export type PreviewItem = Omit<ImportListItem, 'importListId'>;

/** Items a list returned: title, year, type, and whether each is in the library or excluded. */
export function ItemsTable({ items, onExclude, caption }: { items: readonly PreviewItem[]; onExclude?: (item: PreviewItem) => void; caption: string }) {
  const columns: Array<Column<PreviewItem>> = [
    { key: 'title', header: 'Title', sortValue: (i) => i.title, cell: (i) => i.title },
    { key: 'year', header: 'Year', sortValue: (i) => i.year ?? null, cell: (i) => i.year ?? '—', width: '80px', mono: true },
    { key: 'type', header: 'Type', cell: (i) => (i.mediaType === 'series' ? 'Series' : 'Movie'), width: '90px', muted: true },
    {
      key: 'state',
      header: 'State',
      cell: (i) =>
        i.excluded ? <Chip tone="warn">Excluded</Chip> : i.inLibrary ? <Chip tone="accent">In library</Chip> : <Chip tone="neutral">New</Chip>,
    },
  ];
  if (onExclude) {
    columns.push({
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
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
      density="dense"
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
    <Modal open size={640} onClose={onClose} title={`Items in ${name}`}>
      {items.isError ? (
        <ErrorBlock title="Could not load list items" onRetry={() => void items.refetch()}>
          {errorMessage(items.error)}
        </ErrorBlock>
      ) : items.isPending ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="al-caption">
            <span className="al-num">{items.data.length}</span> item{items.data.length === 1 ? '' : 's'} from the last sync.
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
