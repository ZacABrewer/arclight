import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { CollectionItem, CollectionSyncResult, CollectionSyncState, SmartCollection } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Chip, EmptyState, ErrorBlock, PageHeader, Pane, Table, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useDeleteSmartCollection, useLeavingSoon, useSmartCollections, useSyncCollections } from '../../../hooks/smart-collections.js';
import { t } from '../../../i18n/index.js';
import { formatDateTime } from '../../../lib/format.js';
import { CollectionEditor } from './collection-editor.js';
import { criteriaSummary, mediaTypeLabel, sortLabel } from './collection-model.js';
import './smart-collections.css';

// Library → Smart collections: rule-based collections Arclight keeps on Jellyfin/Emby, plus the
// Leaving Soon collection retention fills. The api does the matching and the sync.

/** One chip per server: items on it, missing titles or the last error. */
function SyncChips({ states }: { states: readonly CollectionSyncState[] }) {
  if (states.length === 0) return <span className="al-caption">{t('smartCollections.notSynced')}</span>;
  return (
    <div className="sc-chips">
      {states.map((s) => (
        <Chip
          key={s.serverId}
          tone={s.lastError ? 'danger' : s.remoteId ? 'accent' : 'muted'}
          title={s.lastError ?? (s.lastSyncAt ? t('smartCollections.syncedAt', { at: formatDateTime(s.lastSyncAt) }) : t('smartCollections.notSynced'))}
        >
          {s.lastError
            ? t('smartCollections.syncError', { server: s.serverName })
            : t('smartCollections.syncState', { server: s.serverName, count: s.itemCount, missing: s.missing })}
        </Chip>
      ))}
    </div>
  );
}

function SyncResult({ result, onDismiss }: { result: CollectionSyncResult; onDismiss: () => void }) {
  return (
    <Banner tone={result.errors.length ? 'warn' : 'info'}>
      <div className="sc-result">
        <span>
          {t('smartCollections.syncResult', {
            collections: result.collections,
            servers: result.servers,
            added: result.added,
            removed: result.removed,
            created: result.created,
            deleted: result.deleted,
          })}
        </span>
        {result.errors.length ? (
          <ul className="sc-result__errors">
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('smartCollections.dismiss')}
        </Button>
      </div>
    </Banner>
  );
}

function CollectionsPane({ onEdit }: { onEdit: (c: SmartCollection | null) => void }) {
  const list = useSmartCollections();
  const del = useDeleteSmartCollection();
  const [deleting, setDeleting] = useState<SmartCollection | null>(null);
  const columns: Column<SmartCollection>[] = [
    {
      key: 'name',
      header: t('common.name'),
      mobile: 'primary',
      cell: (c) => (
        <span className="sc-name">
          <span className="sc-strong">{c.name}</span>
          {c.enabled === false ? (
            <Chip tone="muted" dot="none">
              {t('common.disabled')}
            </Chip>
          ) : null}
        </span>
      ),
    },
    { key: 'type', header: t('common.type'), cell: (c) => mediaTypeLabel(c.mediaType) },
    {
      key: 'criteria',
      header: t('smartCollections.criteria'),
      cell: (c) => {
        const parts = criteriaSummary(c);
        return parts.length ? (
          <div className="sc-chips">
            {parts.map((p) => (
              <Chip key={p} tone="neutral" dot="none">
                {p}
              </Chip>
            ))}
          </div>
        ) : (
          <span className="al-caption">{t('smartCollections.everything')}</span>
        );
      },
    },
    {
      key: 'order',
      header: t('smartCollections.order'),
      muted: true,
      cell: (c) => (c.limit ? t('smartCollections.orderLimit', { sort: sortLabel(c.sort ?? 'added'), limit: c.limit }) : sortLabel(c.sort ?? 'added')),
    },
    { key: 'sync', header: t('smartCollections.servers'), cell: (c) => <SyncChips states={c.sync} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      mobile: 'end',
      cell: (c) => (
        <div className="sc-actions">
          <Button size="sm" variant="secondary" onClick={() => onEdit(c)} aria-label={t('smartCollections.editNamed', { name: c.name })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(c)} aria-label={t('smartCollections.deleteNamed', { name: c.name })}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];
  return (
    <Pane title={t('smartCollections.rules')} aria-label={t('smartCollections.rules')} flush>
      {list.isError ? (
        <ErrorBlock title={t('smartCollections.couldNotLoad')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption={t('smartCollections.rules')}
          columns={columns}
          rows={list.data}
          rowKey={(c) => c.id}
          loading={list.isPending}
          empty={
            <EmptyState
              title={t('smartCollections.none')}
              action={
                <Button variant="primary" onClick={() => onEdit(null)}>
                  {t('smartCollections.add')}
                </Button>
              }
            >
              {t('smartCollections.noneBody')}
            </EmptyState>
          }
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t('smartCollections.deleteNamed', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      >
        {t('smartCollections.deleteWarning')}
      </ConfirmDialog>
    </Pane>
  );
}

function LeavingSoonPane() {
  const ls = useLeavingSoon();
  const columns: Column<CollectionItem>[] = [
    { key: 'title', header: t('common.title'), mobile: 'primary', cell: (i) => <span className="sc-strong">{i.title}</span> },
    { key: 'year', header: t('common.year'), mono: true, muted: true, cell: (i) => i.year },
    { key: 'type', header: t('common.type'), cell: (i) => mediaTypeLabel(i.mediaType) },
    { key: 'removeAt', header: t('smartCollections.leavingSoon.removal'), mono: true, mobile: 'end', cell: (i) => (i.removeAt ? formatDateTime(i.removeAt) : '—') },
  ];
  const title = ls.data ? ls.data.name : t('smartCollections.leavingSoon.title');
  return (
    <Pane
      title={title}
      aria-label={t('smartCollections.leavingSoon.title')}
      flush
      actions={
        <Link to="/settings/statscollections" className="al-link">
          {t('smartCollections.leavingSoon.settings')}
        </Link>
      }
    >
      {ls.isError ? (
        <ErrorBlock title={t('smartCollections.leavingSoon.couldNotLoad')} onRetry={() => void ls.refetch()}>
          {errorMessage(ls.error)}
        </ErrorBlock>
      ) : (
        <>
          {ls.data ? (
            <div className="sc-ls-head">
              <p className="al-caption">
                {ls.data.enabled ? t('smartCollections.leavingSoon.intro', { days: ls.data.days }) : t('smartCollections.leavingSoon.off', { days: ls.data.days })}
              </p>
              {ls.data.enabled ? <SyncChips states={ls.data.sync} /> : null}
            </div>
          ) : null}
          <Table
            caption={t('smartCollections.leavingSoon.title')}
            columns={columns}
            rows={ls.data?.items}
            rowKey={(i) => `${i.mediaType}-${i.id}`}
            loading={ls.isPending}
            density="dense"
            empty={<EmptyState title={t('smartCollections.leavingSoon.empty')}>{t('smartCollections.leavingSoon.emptyBody')}</EmptyState>}
          />
        </>
      )}
    </Pane>
  );
}

export function SmartCollectionsPage() {
  const [editing, setEditing] = useState<{ collection: SmartCollection | null } | null>(null);
  const sync = useSyncCollections();
  const [result, setResult] = useState<CollectionSyncResult | null>(null);
  return (
    <div className="sc-stack">
      <PageHeader
        title={t('smartCollections.title')}
        subtitle={t('smartCollections.subtitle')}
        actions={
          <>
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: setResult })}>
              {t('smartCollections.syncNow')}
            </Button>
            <Button variant="primary" onClick={() => setEditing({ collection: null })}>
              {t('smartCollections.add')}
            </Button>
          </>
        }
      />
      {result ? <SyncResult result={result} onDismiss={() => setResult(null)} /> : null}
      <CollectionsPane onEdit={(collection) => setEditing({ collection })} />
      <LeavingSoonPane />
      <CollectionEditor open={editing !== null} collection={editing?.collection ?? null} onClose={() => setEditing(null)} />
    </div>
  );
}
