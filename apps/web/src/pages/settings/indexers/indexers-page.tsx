import { useMemo, useState } from 'react';
import type { Indexer, IndexerTemplate, IndexerTestAllItem } from '@media-tron/shared';
import { indexersApi } from '../../../api/indexers.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Toggle } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton } from '../../../components/forms/test-result.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import {
  useCreateIndexer,
  useDeleteIndexer,
  useIndexerCategories,
  useIndexerList,
  useIndexerTemplates,
  useTestAllIndexers,
  useUpdateIndexer,
} from '../../../hooks/indexers.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';
import { categoryRenderer, indexerFields, indexerTestOutcome, toIndexerBody } from './indexer-fields.js';

export function indexerHealth(indexer: Pick<Indexer, 'status'>, now = Date.now()): { tone: 'ok' | 'warning' | 'error'; label: string; title?: string } {
  const s = indexer.status;
  if (s?.disabledTill && new Date(s.disabledTill).getTime() > now) {
    return { tone: 'error', label: `disabled ${relativeTime(s.disabledTill, now).replace(/^in /, 'for ')}`, title: `Disabled until ${formatDateTime(s.disabledTill)} after ${s.failureCount} failures` };
  }
  if (s && s.failureCount > 0) return { tone: 'warning', label: `failing (${s.failureCount})` };
  return { tone: 'ok', label: 'ok' };
}

type Editing = { indexer: Indexer } | { template: IndexerTemplate };

function IndexerEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const implementation = 'indexer' in editing ? editing.indexer.implementation : editing.template.implementation;
  const fields = useMemo(() => indexerFields(implementation), [implementation]);
  const base = 'indexer' in editing ? editing.indexer : { ...editing.template.template, name: editing.template.implementationName };
  const form = useSchemaForm(fields, base as unknown as Record<string, unknown>);
  const categories = useIndexerCategories();
  const create = useCreateIndexer();
  const update = useUpdateIndexer({ silent: true });
  const remove = useDeleteIndexer();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const existing = 'indexer' in editing ? editing.indexer : null;

  const renderers = useMemo(() => {
    const cats = categoryRenderer(categories.data ?? []);
    return { tags: tagRenderer, 'settings.categories': cats, 'settings.animeCategories': cats };
  }, [categories.data]);

  const submit = () => {
    if (!form.validate()) return;
    const body = toIndexerBody(form.values);
    if (existing) update.mutate({ id: existing.id, body }, { onSuccess: onClose });
    else create.mutate(body, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        title={existing ? `Edit ${existing.name}` : `Add ${'template' in editing ? editing.template.implementationName : ''} indexer`}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={create.isPending || update.isPending}
            onDelete={existing ? () => setConfirmDelete(true) : undefined}
            extra={<TestButton beforeTest={form.validate} onTest={async () => indexerTestOutcome(await indexersApi.test(toIndexerBody(form.values)))} />}
          />
        }
      >
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={renderers} inline />
        <SaveError error={create.error ?? update.error} />
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${existing.name}?`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

function TemplatePicker({ onPick, onClose }: { onPick: (t: IndexerTemplate) => void; onClose: () => void }) {
  const templates = useIndexerTemplates();
  return (
    <Modal open onClose={onClose} title="Add indexer">
      {templates.isPending ? (
        <LoadingBlock />
      ) : templates.isError ? (
        <ErrorView error={templates.error} />
      ) : (
        <CardGrid>
          {templates.data.map((t) => (
            <button key={t.implementation} type="button" className="item-card add-card" onClick={() => onPick(t)}>
              <strong>{t.implementationName}</strong>
              <span className="muted">{t.protocol}</span>
            </button>
          ))}
        </CardGrid>
      )}
    </Modal>
  );
}

export function IndexersPage() {
  const list = useIndexerList();
  const update = useUpdateIndexer();
  const testAll = useTestAllIndexers();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [results, setResults] = useState<Record<number, IndexerTestAllItem>>({});

  const toggle = (indexer: Indexer, key: 'enableRss' | 'enableAutomaticSearch' | 'enableInteractiveSearch', value: boolean) =>
    update.mutate({ id: indexer.id, body: { [key]: value } });

  return (
    <Page
      title="Indexers"
      actions={
        <Button
          loading={testAll.isPending}
          disabled={!list.data?.length}
          onClick={() => testAll.mutate(undefined, { onSuccess: (r) => setResults(Object.fromEntries(r.map((x) => [x.id, x]))) })}
        >
          Test all
        </Button>
      }
    >
      <Card>
        {list.isPending ? (
          <LoadingBlock />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <CardGrid>
            {list.data.map((indexer) => {
              const health = indexerHealth(indexer);
              const result = results[indexer.id];
              const off = !indexer.enableRss && !indexer.enableAutomaticSearch && !indexer.enableInteractiveSearch;
              return (
                <ItemCard
                  key={indexer.id}
                  title={indexer.name}
                  muted={off}
                  onClick={() => setEditing({ indexer })}
                  status={
                    <span title={health.title}>
                      <Badge tone={off ? 'neutral' : health.tone}>{off ? 'disabled' : health.label}</Badge>
                    </span>
                  }
                >
                  <div className="muted">
                    {indexer.implementation} · {indexer.protocol} · priority {indexer.priority}
                  </div>
                  <div className="toggle-row">
                    <Toggle label="RSS" checked={indexer.enableRss} onChange={(e) => toggle(indexer, 'enableRss', e.currentTarget.checked)} />
                    <Toggle
                      label="Automatic"
                      checked={indexer.enableAutomaticSearch}
                      onChange={(e) => toggle(indexer, 'enableAutomaticSearch', e.currentTarget.checked)}
                    />
                    <Toggle
                      label="Interactive"
                      checked={indexer.enableInteractiveSearch}
                      onChange={(e) => toggle(indexer, 'enableInteractiveSearch', e.currentTarget.checked)}
                    />
                  </div>
                  {result ? (
                    <div className={result.ok ? 'text-ok' : 'text-error'}>
                      {result.ok ? `Test passed (${result.releaseCount ?? 0} releases)` : `Test failed: ${result.error?.message ?? 'unknown error'}`}
                    </div>
                  ) : null}
                </ItemCard>
              );
            })}
            <AddCard label="Add indexer" onClick={() => setPicking(true)} />
          </CardGrid>
        )}
      </Card>
      {picking ? (
        <TemplatePicker
          onClose={() => setPicking(false)}
          onPick={(template) => {
            setPicking(false);
            setEditing({ template });
          }}
        />
      ) : null}
      {editing ? (
        <IndexerEditor
          key={'indexer' in editing ? editing.indexer.id : editing.template.implementation}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}
