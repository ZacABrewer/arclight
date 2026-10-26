import { useState } from 'react';
import type { ImportList, ImportListSchema } from '@arclight/shared';
import { IMPORT_LIST_DESCRIPTIONS } from '../../../api/import-lists.js';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Modal, Skeleton } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useAllImportListItems, useImportListSchema, useImportLists, useSyncImportLists } from '../../../hooks/import-lists.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, ItemCard, SettingsSection } from '../shared.js';
import { ExclusionsCard } from './exclusions-card.js';
import { MEDIA_TYPE_LABELS } from './fields.js';
import { ImportListEditor, type Editing } from './import-list-editor.js';
import { ItemsPreviewDialog } from './items-table.js';
import { OptionsCard, useImportListOptions } from './options-card.js';
import './import-lists.css';
import { t } from '../../../i18n/index.js';

function ListCard({
  list,
  schema,
  itemCount,
  intervalHours,
  onEdit,
  onPreview,
}: {
  list: ImportList;
  schema: ImportListSchema | undefined;
  itemCount: number | undefined;
  intervalHours: number | undefined;
  onEdit: () => void;
  onPreview: () => void;
}) {
  const status = list.lastSyncError ? (
    <Chip tone="danger">{t('common.syncFailed')}</Chip>
  ) : list.enabled ? (
    <Chip tone="accent">{t('common.enabled')}</Chip>
  ) : (
    <Chip tone="muted">{t('common.disabled')}</Chip>
  );
  return (
    <ItemCard
      title={list.name}
      onClick={onEdit}
      muted={!list.enabled}
      status={status}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={t('settings.importLists.editName', { name: list.name })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onPreview} aria-label={t('settings.importLists.previewItemsInName', { name: list.name })}>
            {t('settings.importLists.previewItems')}
          </Button>
        </>
      }
    >
      <span>{schema?.implementationName ?? list.implementation}</span>
      <Chip tone="neutral" dot="none">
        {MEDIA_TYPE_LABELS[list.mediaType]}
      </Chip>
      {list.enableAutomaticAdd ? null : <Chip tone="warn">{t('settings.importLists.noAutoAdd')}</Chip>}
      {list.searchOnAdd ? <Chip dot="none">{t('common.searchOnAdd')}</Chip> : null}
      <span className="al-card-line">
        {intervalHours !== undefined ? (
          <>
            {t('settings.importLists.syncs')}
            <span className="al-num" data-testid="sync-interval">
              {t('settings.importLists.everyIntervalhoursH', { intervalHours })}
            </span>
            {' · '}
          </>
        ) : null}
        {t('common.lastSync')}
        {list.lastSyncAt ? (
          <time className="al-num" dateTime={list.lastSyncAt} title={formatDateTime(list.lastSyncAt)}>
            {relativeTime(list.lastSyncAt)}
          </time>
        ) : (
          t('settings.importLists.never')
        )}
        {itemCount !== undefined ? (
          <>
            {' · '}
            <span className="al-num">{itemCount}</span> {t('settings.importLists.items', { itemCount })}
          </>
        ) : null}
      </span>
      {list.lastSyncError ? (
        <p className="al-card-error" role="alert">
          {list.lastSyncError}
        </p>
      ) : null}
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
  const options = useImportListOptions();
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
          title: t('settings.importLists.syncedLists', { lists: r.lists }),
          message: t('settings.importLists.fetchedFetchedAddedAddedSkippedexisting', { fetched: r.fetched, added: r.added, skippedExisting: r.skippedExisting, skippedExcluded: r.skippedExcluded, value: r.errors.length ? `, ${r.errors.length} failed` : '' }),
        }),
    });

  const editorReady = rootFolders.data && profiles.data;

  return (
    <SettingsPage
      title={t('settings.importLists.importLists')}
      description={t('settings.importLists.addSeriesAndMoviesAutomatically')}
      actions={
        <>
          <Button variant="secondary" loading={sync.isPending} onClick={runSync}>
            {t('common.syncNow')}
          </Button>
          <Button variant="primary" onClick={() => setPicking(true)}>
            {t('settings.importLists.addList')}
          </Button>
        </>
      }
      save={options.save}
    >
      <SettingsSection label={t('settings.importLists.lists')} {...(lists.data ? { count: lists.data.length } : {})}>
        {lists.isPending ? (
          <Skeleton lines={3} />
        ) : lists.isError ? (
          <ErrorBlock title={t('settings.importLists.couldNotLoadImportLists')} onRetry={() => void lists.refetch()}>
            {errorMessage(lists.error)}
          </ErrorBlock>
        ) : (
          <CardGrid label={t('settings.importLists.importLists')}>
            {lists.data.map((l) => {
              const schema = schemas.data?.find((s) => s.implementation === l.implementation);
              return (
                <ListCard
                  key={l.id}
                  list={l}
                  schema={schema}
                  itemCount={items.data ? (counts.get(l.id) ?? 0) : undefined}
                  intervalHours={options.saved?.syncIntervalHours}
                  onEdit={() => setEditing({ list: l, schema })}
                  onPreview={() => setPreview(l)}
                />
              );
            })}
            <AddCard label={t('settings.importLists.addImportList')} onClick={() => setPicking(true)} />
          </CardGrid>
        )}
      </SettingsSection>
      <OptionsCard form={options} />
      <ExclusionsCard />
      {picking ? (
        <Modal open size={640} onClose={() => setPicking(false)} title={t('settings.importLists.addImportList')}>
          {schemas.isPending ? (
            <Skeleton lines={4} />
          ) : schemas.isError ? (
            <ErrorBlock title={t('settings.importLists.couldNotLoadListTypes')} onRetry={() => void schemas.refetch()}>
              {errorMessage(schemas.error)}
            </ErrorBlock>
          ) : (
            <div className="al-chooser" role="list" aria-label={t('settings.importLists.listTypes')}>
              {schemas.data.map((s) => (
                <div role="listitem" key={s.implementation}>
                  <button
                    type="button"
                    className="al-chooser__item"
                    onClick={() => {
                      setPicking(false);
                      setEditing({ schema: s });
                    }}
                  >
                    <span className="al-chooser__name">{s.implementationName}</span>
                    <span className="al-chooser__desc">{IMPORT_LIST_DESCRIPTIONS[s.implementation]}</span>
                    <span className="al-chip-row">
                      {s.supportedMediaTypes
                        .filter((m) => m !== 'both')
                        .map((m) => (
                          <Chip key={m} tone="neutral" dot="none">
                            {MEDIA_TYPE_LABELS[m]}
                          </Chip>
                        ))}
                      {s.requiresTraktAuth ? <Chip>{t('settings.importLists.traktAuth')}</Chip> : null}
                    </span>
                  </button>
                </div>
              ))}
            </div>
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
          <Modal open size={560} onClose={() => setEditing(null)} title={t('common.loading')}>
            {rootFolders.isError || profiles.isError ? (
              <ErrorBlock title={t('settings.importLists.couldNotLoadRootFolders')}>{errorMessage(rootFolders.error ?? profiles.error)}</ErrorBlock>
            ) : (
              <Skeleton lines={4} />
            )}
          </Modal>
        )
      ) : null}
      {preview ? <ItemsPreviewDialog id={preview.id} name={preview.name} onClose={() => setPreview(null)} /> : null}
    </SettingsPage>
  );
}
