import { useMemo, useState } from 'react';
import type { IndexerProxy, IndexerProxyType } from '@media-tron/shared';
import { indexersApi } from '../../../api/indexers.js';
import { Badge } from '../../../components/badge.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer, useTagLabels } from '../../../components/forms/tag-picker.js';
import { TestButton } from '../../../components/forms/test-result.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useDeleteIndexerProxy, useIndexerProxies, useSaveIndexerProxy } from '../../../hooks/indexers.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';
import { newProxy, PROXY_TYPE_LABELS, proxyAddress, proxyFields, proxyTestOutcome, toProxyBody } from './proxy-model.js';

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
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={onChange} renderers={{ tags: tagRenderer }} inline />
        <SaveError error={save.error} />
      </Modal>
      {proxy ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${proxy.name}?`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(proxy.id);
            onClose();
          }}
        />
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
    <Page title="Indexer Proxies" subtitle="FlareSolverr and HTTP/SOCKS5 proxies for indexer requests">
      <Card>
        {list.isPending ? (
          <LoadingBlock />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <CardGrid>
            {list.data.map((p) => (
              <ItemCard key={p.id} title={p.name} onClick={() => setEditing(p)} status={<Badge tone="info">{PROXY_TYPE_LABELS[p.type]}</Badge>}>
                <div className="muted">{proxyAddress(p)}</div>
                <div className="muted">{p.tags.length ? `tags: ${tagLabels(p.tags).join(', ')}` : 'no tags (explicit use only)'}</div>
              </ItemCard>
            ))}
            <AddCard label="Add proxy" onClick={() => setEditing('new')} />
          </CardGrid>
        )}
      </Card>
      {editing ? (
        <ProxyEditor key={editing === 'new' ? 'new' : editing.id} proxy={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Page>
  );
}
