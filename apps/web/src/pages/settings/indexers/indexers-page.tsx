import { useMemo, useState } from 'react';
import type { Indexer, IndexerDefinitionSummary, IndexerTemplate, IndexerTestAllItem } from '@media-tron/shared';
import { Tabs } from '../../../components/tabs.js';
import { CatalogueList } from './catalogue.js';
import { DefinitionEditor } from './definition-editor.js';
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

function TemplatePicker({
  onPick,
  onPickDefinition,
  onClose,
}: {
  onPick: (t: IndexerTemplate) => void;
  onPickDefinition: (d: IndexerDefinitionSummary) => void;
  onClose: () => void;
}) {
  const templates = useIndexerTemplates();
  const endpoints = templates.isPending ? (
    <LoadingBlock />
  ) : templates.isError ? (
    <ErrorView error={templates.error} />
  ) : (
    <CardGrid>
      {templates.data
        .filter((t) => t.implementation !== 'definition')
        .map((t) => (
          <button key={t.implementation} type="button" className="item-card add-card" onClick={() => onPick(t)}>
            <strong>{t.implementationName}</strong>
            <span className="muted">{t.protocol}</span>
          </button>
        ))}
    </CardGrid>
  );
  return (
    <Modal open size="lg" onClose={onClose} title="Add indexer">
      <Tabs
        tabs={[
          { id: 'endpoint', label: 'Torznab/Newznab', content: endpoints },
          { id: 'catalogue', label: 'Catalogue', content: <CatalogueList onPick={onPickDefinition} /> },
        ]}
      />
    </Modal>
  );
}

/** "via <definition>" and proxy names shown under an indexer's title. */
export function indexerSourceLine(indexer: Pick<Indexer, 'implementation' | 'definitionName' | 'settings' | 'proxyNames'>): string {
  const parts: string[] = [];
  if (indexer.implementation === 'definition') {
    parts.push(`definition: ${indexer.definitionName ?? indexer.settings.definitionId ?? 'unknown'}`);
  }
  if (indexer.proxyNames?.length) parts.push(`proxy: ${indexer.proxyNames.join(', ')}`);
  return parts.join(' · ');
}

export function IndexersPage() {
  const list = useIndexerList();
  const update = useUpdateIndexer();
  const testAll = useTestAllIndexers();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [definitionEditing, setDefinitionEditing] = useState<{ definition: IndexerDefinitionSummary } | { indexer: Indexer } | null>(null);
  const openIndexer = (indexer: Indexer) =>
    indexer.implementation === 'definition' ? setDefinitionEditing({ indexer }) : setEditing({ indexer });
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
                  onClick={() => openIndexer(indexer)}
                  status={
                    <span title={health.title}>
                      <Badge tone={off ? 'neutral' : health.tone}>{off ? 'disabled' : health.label}</Badge>
                    </span>
                  }
                >
                  <div className="muted">
                    {indexer.implementation} · {indexer.protocol} · priority {indexer.priority}
                  </div>
                  {indexerSourceLine(indexer) ? <div className="muted">{indexerSourceLine(indexer)}</div> : null}
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
          onPickDefinition={(definition) => {
            setPicking(false);
            setDefinitionEditing({ definition });
          }}
        />
      ) : null}
      {definitionEditing ? (
        <DefinitionEditor
          key={'indexer' in definitionEditing ? definitionEditing.indexer.id : definitionEditing.definition.id}
          editing={definitionEditing}
          onClose={() => setDefinitionEditing(null)}
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
