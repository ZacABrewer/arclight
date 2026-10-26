import { useState } from 'react';
import type { ImportList, ImportListSchema } from '@media-tron/shared';
import { IMPORT_LIST_DESCRIPTIONS } from '../../../api/import-lists.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useToast } from '../../../components/toast.js';
import { useAllImportListItems, useImportListSchema, useImportLists, useSyncImportLists } from '../../../hooks/import-lists.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { AddCard, CardGrid, ItemCard } from '../shared.js';
import { ExclusionsCard } from './exclusions-card.js';
import { MEDIA_TYPE_LABELS } from './fields.js';
import { ImportListEditor, type Editing } from './import-list-editor.js';
import { ItemsPreviewDialog } from './items-table.js';
import { OptionsCard } from './options-card.js';

function ListCard({
  list,
  schema,
  itemCount,
  onEdit,
  onPreview,
}: {
  list: ImportList;
  schema: ImportListSchema | undefined;
  itemCount: number | undefined;
  onEdit: () => void;
  onPreview: () => void;
}) {
  return (
    <ItemCard
      title={list.name}
      onClick={onEdit}
      muted={!list.enabled}
      status={list.lastSyncError ? <Badge tone="error">Error</Badge> : list.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge>Disabled</Badge>}
    >
      <div className="muted">{schema?.implementationName ?? list.implementation}</div>
      <div className="badge-row">
        <Badge tone="info">{MEDIA_TYPE_LABELS[list.mediaType]}</Badge>
        {list.enableAutomaticAdd ? null : <Badge tone="warning">No auto add</Badge>}
        {list.searchOnAdd ? <Badge>Search on add</Badge> : null}
      </div>
      <div className="muted">
        Last sync:{' '}
        {list.lastSyncAt ? <time dateTime={list.lastSyncAt} title={formatDateTime(list.lastSyncAt)}>{relativeTime(list.lastSyncAt)}</time> : 'never'}
        {itemCount !== undefined ? ` · ${itemCount} item${itemCount === 1 ? '' : 's'}` : null}
      </div>
      {list.lastSyncError ? (
        <p className="inline-error" role="alert">
          {list.lastSyncError}
        </p>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onPreview} aria-label={`Preview items in ${list.name}`}>
        Preview items
      </Button>
    </ItemCard>
  );
}

export function ImportListsPage() {
  const lists = useImportLists();
  const schemas = useImportListSchema();
  const items = useAllImportListItems();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();
  const sync = useSyncImportLists();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [preview, setPreview] = useState<ImportList | null>(null);

  const counts = new Map<number, number>();
  for (const i of items.data ?? []) counts.set(i.importListId, (counts.get(i.importListId) ?? 0) + 1);

  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: (r) =>
        toast.push({
          tone: r.failed || r.errors.length ? 'warning' : 'ok',
          title: `Synced ${r.lists} list${r.lists === 1 ? '' : 's'}`,
          message: `${r.fetched} fetched, ${r.added} added, ${r.skippedExisting} already in library, ${r.skippedExcluded} excluded${r.errors.length ? `, ${r.errors.length} failed` : ''}`,
        }),
    });

  const editorReady = rootFolders.data && profiles.data;

  return (
    <Page
      title="Import Lists"
      subtitle="Add series and movies automatically from TMDB, Trakt, Plex, IMDb and feed lists."
      actions={
        <Button loading={sync.isPending} onClick={runSync}>
          Sync now
        </Button>
      }
    >
      <Card title="Lists">
        {lists.isPending ? (
          <LoadingBlock />
        ) : lists.isError ? (
          <ErrorView error={lists.error} onRetry={() => void lists.refetch()} />
        ) : (
          <CardGrid>
            {lists.data.map((l) => {
              const schema = schemas.data?.find((s) => s.implementation === l.implementation);
              return (
                <ListCard
                  key={l.id}
                  list={l}
                  schema={schema}
                  itemCount={items.data ? (counts.get(l.id) ?? 0) : undefined}
                  onEdit={() => setEditing({ list: l, schema })}
                  onPreview={() => setPreview(l)}
                />
              );
            })}
            <AddCard label="Add list" onClick={() => setPicking(true)} />
          </CardGrid>
        )}
      </Card>
      <ExclusionsCard />
      <OptionsCard />
      {picking ? (
        <Modal open size="lg" onClose={() => setPicking(false)} title="Add import list">
          {schemas.isPending ? (
            <LoadingBlock />
          ) : schemas.isError ? (
            <ErrorView error={schemas.error} onRetry={() => void schemas.refetch()} />
          ) : (
            <CardGrid>
              {schemas.data.map((s) => (
                <button
                  key={s.implementation}
                  type="button"
                  className="item-card add-card"
                  onClick={() => {
                    setPicking(false);
                    setEditing({ schema: s });
                  }}
                >
                  <strong>{s.implementationName}</strong>
                  <span className="muted">{IMPORT_LIST_DESCRIPTIONS[s.implementation]}</span>
                  <span className="badge-row">
                    {s.supportedMediaTypes
                      .filter((m) => m !== 'both')
                      .map((m) => (
                        <Badge key={m}>{MEDIA_TYPE_LABELS[m]}</Badge>
                      ))}
                    {s.requiresTraktAuth ? <Badge tone="info">Trakt auth</Badge> : null}
                  </span>
                </button>
              ))}
            </CardGrid>
          )}
        </Modal>
      ) : null}
      {editing ? (
        editorReady ? (
          <ImportListEditor
            key={'list' in editing ? editing.list.id : editing.schema.implementation}
            editing={editing}
            rootFolders={rootFolders.data}
            profiles={profiles.data}
            onClose={() => setEditing(null)}
          />
        ) : (
          <Modal open onClose={() => setEditing(null)} title="Loading…">
            {rootFolders.isError || profiles.isError ? <ErrorView error={rootFolders.error ?? profiles.error} /> : <LoadingBlock />}
          </Modal>
        )
      ) : null}
      {preview ? <ItemsPreviewDialog id={preview.id} name={preview.name} onClose={() => setPreview(null)} /> : null}
    </Page>
  );
}
