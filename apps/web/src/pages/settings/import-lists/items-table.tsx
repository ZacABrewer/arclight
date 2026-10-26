import type { ImportListItem } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Modal, Skeleton, Table, type Column } from '../../../arclight/index.js';
import { useAddImportListExclusion, useImportListItems } from '../../../hooks/import-lists.js';
import { t } from '../../../i18n/index.js';

export type PreviewItem = Omit<ImportListItem, 'importListId'>;

/** Items a list returned: title, year, type, and whether each is in the library or excluded. */
export function ItemsTable({ items, onExclude, caption }: { items: readonly PreviewItem[]; onExclude?: (item: PreviewItem) => void; caption: string }) {
  const columns: Array<Column<PreviewItem>> = [
    { key: 'title', header: t('common.title'), sortValue: (i) => i.title, cell: (i) => i.title },
    { key: 'year', header: t('common.year'), sortValue: (i) => i.year ?? null, cell: (i) => i.year ?? '—', width: '80px', mono: true },
    { key: 'type', header: t('common.type'), cell: (i) => (i.mediaType === 'series' ? t('common.series') : t('common.movie')), width: '90px', muted: true },
    {
      key: 'state',
      header: t('common.state'),
      cell: (i) =>
        i.excluded ? <Chip tone="warn">{t('settings.importLists.itemsTable.excluded')}</Chip> : i.inLibrary ? <Chip tone="accent">{t('common.inLibrary')}</Chip> : <Chip tone="neutral">{t('settings.importLists.itemsTable.new')}</Chip>,
    },
  ];
  if (onExclude) {
    columns.push({
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (i) =>
        i.excluded ? null : (
          <Button size="sm" variant="ghost" onClick={() => onExclude(i)} aria-label={t('settings.importLists.itemsTable.excludeTitle', { title: i.title })}>
            {t('settings.importLists.itemsTable.exclude')}
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
      empty={t('settings.importLists.itemsTable.theListReturnedNoItems')}
    />
  );
}

/** "Preview items" dialog for a saved list (GET /importlist/:id/items). */
export function ItemsPreviewDialog({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const items = useImportListItems(id);
  const exclude = useAddImportListExclusion();
  return (
    <Modal open size={640} onClose={onClose} title={t('settings.importLists.itemsTable.itemsInName', { name })}>
      {items.isError ? (
        <ErrorBlock title={t('settings.importLists.itemsTable.couldNotLoadListItems')} onRetry={() => void items.refetch()}>
          {errorMessage(items.error)}
        </ErrorBlock>
      ) : items.isPending ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="al-caption">
            <span className="al-num">{items.data.length}</span> {t('settings.importLists.itemsTable.itemsFromTheLastSync', { dataCount: items.data.length })}
          </p>
          <ItemsTable
            caption={t('settings.importLists.itemsTable.itemsInName', { name })}
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
