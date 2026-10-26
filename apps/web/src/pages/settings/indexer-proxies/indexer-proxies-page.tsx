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
import { newProxy, PROXY_TYPE_LABELS, proxyAddress, proxyFields, proxyTestOutcome, testSavedProxy, toProxyBody } from './proxy-model.js';

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
        title={proxy ? `Edit ${proxy.name}` : 'Add indexer proxy'}
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
          title={`Delete ${proxy.name}?`}
          confirmLabel="Delete proxy"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(proxy.id);
            onClose();
          }}
        >
          <p>Indexers that use {proxy.name} connect directly afterwards.</p>
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
      title="Indexer proxies"
      description="FlareSolverr and HTTP/SOCKS5 proxies for indexer requests."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add proxy
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load indexer proxies" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title="No proxies">Only needed for sites behind Cloudflare or when indexers must go through a proxy.</EmptyState>
      ) : (
        <CardGrid label="Indexer proxies">
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing(p)}
              status={
                <Chip tone="default" dot="none">
                  {PROXY_TYPE_LABELS[p.type]}
                </Chip>
              }
              actions={
                <>
                  <TestButton size="sm" onTest={async () => proxyTestOutcome(await testSavedProxy(p.id))} />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                    Edit
                  </Button>
                </>
              }
            >
              <span className="al-card-line al-card-line--mono">{proxyAddress(p)}</span>
              <span className="al-card-line">{p.tags.length ? `Tags: ${tagLabels(p.tags).join(', ')}` : 'No tags · used only where an indexer picks it'}</span>
            </ItemCard>
          ))}
        </CardGrid>
      )}
      {editing ? <ProxyEditor key={editing === 'new' ? 'new' : editing.id} proxy={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </SettingsPage>
  );
}
