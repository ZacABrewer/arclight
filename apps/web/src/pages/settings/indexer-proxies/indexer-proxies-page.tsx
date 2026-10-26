import { useMemo, useState } from 'react';
import type { IndexerProxy, IndexerProxyType } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { indexersApi } from '../../../api/indexers.js';
import { Button, Chip, EmptyState, ErrorBlock, Modal, Skeleton } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer, useTagLabels } from '../../../components/forms/tag-picker.js';
import { TestButton } from '../../../components/forms/test-result.js';
import { useDeleteIndexerProxy, useIndexerProxies, useSaveIndexerProxy } from '../../../hooks/indexers.js';
import { SettingsPage } from '../settings-layout.js';
import { CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';
import '../indexers/indexers.css';
import { isManagedProxy, newProxy, PROXY_TYPE_LABELS, proxyAddress, proxyFields, proxyTestOutcome, testSavedProxy, toProxyBody } from './proxy-model.js';
import { t } from '../../../i18n/index.js';

function ProxyEditor({ proxy, onClose }: { proxy: IndexerProxy | null; onClose: () => void }) {
  const [type, setType] = useState<IndexerProxyType>(proxy?.type ?? 'flaresolverr');
  const fields = useMemo(() => proxyFields(type), [type]);
  const form = useSchemaForm(fields, proxy ? (proxy as unknown as Record<string, unknown>) : newProxy());
  const save = useSaveIndexerProxy();
  const remove = useDeleteIndexerProxy();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onChange = (next: Record<string, unknown>) => {
    const nextType = next['type'] as IndexerProxyType;
    if (nextType && nextType !== type) setType(nextType);
    form.setValues(next);
  };

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: proxy?.id, body: toProxyBody(form.values) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={proxy ? t('settings.indexerProxies.editName', { name: proxy.name }) : t('settings.indexerProxies.addIndexerProxy')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={proxy ? () => setConfirmDelete(true) : undefined}
            extra={<TestButton beforeTest={form.validate} onTest={async () => proxyTestOutcome(await indexersApi.proxies.test(toProxyBody(form.values)))} />}
          />
        }
      >
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={onChange} renderers={{ tags: tagRenderer }} />
        <SaveError error={save.error} />
      </Modal>
      {proxy ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.indexerProxies.deleteName', { name: proxy.name })}
          confirmLabel={t('settings.indexerProxies.deleteProxy')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(proxy.id);
            onClose();
          }}
        >
          <p>{t('settings.indexerProxies.indexersThatUseNameConnect', { name: proxy.name })}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Settings → Indexer proxies: FlareSolverr and HTTP/SOCKS5 proxies applied by tag or per indexer. */
export function IndexerProxiesPage() {
  const list = useIndexerProxies();
  const tagLabels = useTagLabels();
  const [editing, setEditing] = useState<IndexerProxy | 'new' | null>(null);

  return (
    <SettingsPage
      title={t('settings.indexerProxies.indexerProxies')}
      description={t('settings.indexerProxies.flaresolverrAndHttpSocks5Proxies')}
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('settings.indexerProxies.addProxy')}
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.indexerProxies.couldntLoadIndexerProxies')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title={t('settings.indexerProxies.noProxies')}>{t('settings.indexerProxies.onlyNeededForSitesBehind')}</EmptyState>
      ) : (
        <CardGrid label={t('settings.indexerProxies.indexerProxies')}>
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing(p)}
              status={
                <span className="al-proxy-chips">
                  {isManagedProxy(p) ? (
                    <Chip tone="accent" dot="none" title={t('settings.indexerProxies.createdByArclightsProxyAuto')}>
                      {t('settings.indexerProxies.managed')}
                    </Chip>
                  ) : null}
                  <Chip tone="default" dot="none">
                    {PROXY_TYPE_LABELS[p.type]}
                  </Chip>
                </span>
              }
              actions={
                <>
                  <TestButton size="sm" onTest={async () => proxyTestOutcome(await testSavedProxy(p.id))} />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label={t('settings.indexerProxies.editName', { name: p.name })}>
                    {t('common.edit')}
                  </Button>
                </>
              }
            >
              <span className="al-card-line al-card-line--mono">{proxyAddress(p)}</span>
              {isManagedProxy(p) ? <span className="al-card-line">{t('settings.indexerProxies.addedAutomaticallyByProxyDetection')}</span> : null}
              <span className="al-card-line">{p.tags.length ? t('settings.indexerProxies.tagsTaglabels', { tagLabels: tagLabels(p.tags).join(', ') }) : t('settings.indexerProxies.noTagsUsedOnlyWhere')}</span>
            </ItemCard>
          ))}
        </CardGrid>
      )}
      {editing ? <ProxyEditor key={editing === 'new' ? 'new' : editing.id} proxy={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </SettingsPage>
  );
}
