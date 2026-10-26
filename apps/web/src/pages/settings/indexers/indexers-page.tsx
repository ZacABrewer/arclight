import { useMemo, useState } from 'react';
import type { Indexer, IndexerDefinitionSummary, IndexerTemplate, IndexerTestAllItem } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { indexersApi } from '../../../api/indexers.js';
import { Button, Chip, EmptyState, ErrorBlock, Input, Modal, ProtocolBadge, Skeleton, Tabs, type ChipTone } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton, TestResultView } from '../../../components/forms/test-result.js';
import {
  useCreateIndexer,
  useDeleteIndexer,
  useIndexerCategories,
  useIndexerList,
  useIndexerTemplates,
  useTestAllIndexers,
  useUpdateIndexer,
} from '../../../hooks/indexers.js';
import { formatDateTime } from '../../../lib/format.js';
import { SettingsPage } from '../settings-layout.js';
import { CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';
import { CatalogueList, TemplateList } from './catalogue.js';
import { DefinitionEditor } from './definition-editor.js';
import { filterTemplates } from './definition-fields.js';
import { categoryRenderer, indexerFields, indexerTestOutcome, toIndexerBody } from './indexer-fields.js';
import './indexers.css';

/** "20:55" — local 24h clock time for retry hints. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Status chip for an indexer card: always a label plus the cause, never colour alone.
 * Enabled (accent) · Disabled (muted) · Backing off · retry 20:55 (warn) · Failed · 3 recent failures (danger).
 */
export function indexerHealth(
  indexer: Pick<Indexer, 'status'> & Partial<Pick<Indexer, 'enableRss' | 'enableAutomaticSearch' | 'enableInteractiveSearch'>>,
  now = Date.now(),
): { tone: ChipTone; label: string; title?: string } {
  const off = indexer.enableRss === false && indexer.enableAutomaticSearch === false && indexer.enableInteractiveSearch === false;
  if (off) return { tone: 'muted', label: 'Disabled' };
  const s = indexer.status;
  if (s?.disabledTill && new Date(s.disabledTill).getTime() > now) {
    return {
      tone: 'warn',
      label: `Backing off · retry ${clockTime(s.disabledTill)}`,
      title: `Skipped until ${formatDateTime(s.disabledTill)} after ${s.failureCount} failures`,
    };
  }
  if (s && s.failureCount > 0) return { tone: 'danger', label: `Failed · ${s.failureCount} recent ${s.failureCount === 1 ? 'failure' : 'failures'}` };
  return { tone: 'accent', label: 'Enabled' };
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
        size={640}
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
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={renderers} />
        <SaveError error={create.error ?? update.error} />
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${existing.name}?`}
          confirmLabel="Delete indexer"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          <p>Searches and RSS stop using {existing.name}.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Add chooser (640): one search field over Torznab/Newznab endpoints and the site catalogue. */
export function IndexerChooser({
  onPick,
  onPickDefinition,
  onClose,
}: {
  onPick: (t: IndexerTemplate) => void;
  onPickDefinition: (d: IndexerDefinitionSummary) => void;
  onClose: () => void;
}) {
  const templates = useIndexerTemplates();
  const [text, setText] = useState('');
  const endpoints = templates.isPending ? (
    <Skeleton lines={3} />
  ) : templates.isError ? (
    <ErrorBlock title="Couldn't load endpoint types" onRetry={() => void templates.refetch()}>
      {errorMessage(templates.error)}
    </ErrorBlock>
  ) : (
    <TemplateList templates={filterTemplates(templates.data, text)} onPick={onPick} />
  );
  return (
    <Modal open size={640} onClose={onClose} title="Add indexer">
      <div className="al-chooser">
        <Input
          type="search"
          aria-label="Search indexers"
          placeholder="Search by name, description or language"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Tabs
          aria-label="Indexer sources"
          tabs={[
            { id: 'endpoint', label: 'Torznab/Newznab', content: endpoints },
            { id: 'catalogue', label: 'Catalogue', content: <CatalogueList text={text} onPick={onPickDefinition} /> },
          ]}
        />
      </div>
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

const IMPLEMENTATION_LABELS: Record<string, string> = { torznab: 'Torznab', newznab: 'Newznab', definition: 'Catalogue' };

/** One indexer card: name, status chip, protocol, priority (mono), Test / Edit. */
export function IndexerCard({ indexer, onEdit, result }: { indexer: Indexer; onEdit: () => void; result?: IndexerTestAllItem | undefined }) {
  const health = indexerHealth(indexer);
  const source = indexerSourceLine(indexer);
  return (
    <ItemCard
      title={indexer.name}
      muted={health.label === 'Disabled'}
      onClick={onEdit}
      status={
        <Chip tone={health.tone} title={health.title}>
          {health.label}
        </Chip>
      }
      actions={
        <>
          <TestButton size="sm" onTest={async () => indexerTestOutcome(await indexersApi.test(toIndexerBody(indexer as unknown as Record<string, unknown>)))} />
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${indexer.name}`}>
            Edit
          </Button>
        </>
      }
    >
      <ProtocolBadge protocol={indexer.protocol} />
      <span>{IMPLEMENTATION_LABELS[indexer.implementation] ?? indexer.implementation}</span>
      <span>
        Priority <span className="al-card-priority">{indexer.priority}</span>
      </span>
      {source ? <span className="al-card-line">{source}</span> : null}
      {result ? (
        <TestResultView
          outcome={{
            ok: result.ok,
            message: result.ok ? `${result.releaseCount ?? 0} releases` : undefined,
            warnings: [],
            errors: result.ok ? [] : [result.error?.message ?? 'Unknown error'],
          }}
        />
      ) : null}
    </ItemCard>
  );
}

/** Settings → Indexers (also /indexers): card grid + add chooser + editors. */
export function IndexersPage() {
  const list = useIndexerList();
  const testAll = useTestAllIndexers();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [definitionEditing, setDefinitionEditing] = useState<{ definition: IndexerDefinitionSummary } | { indexer: Indexer } | null>(null);
  const openIndexer = (indexer: Indexer) => (indexer.implementation === 'definition' ? setDefinitionEditing({ indexer }) : setEditing({ indexer }));
  const [results, setResults] = useState<Record<number, IndexerTestAllItem>>({});

  return (
    <SettingsPage
      title="Indexers"
      standalone={{ index: '08', title: 'Indexers' }}
      actions={
        <>
          <Button
            variant="secondary"
            loading={testAll.isPending}
            disabled={!list.data?.length}
            onClick={() => testAll.mutate(undefined, { onSuccess: (r) => setResults(Object.fromEntries(r.map((x) => [x.id, x]))) })}
          >
            Test all
          </Button>
          <Button variant="primary" onClick={() => setPicking(true)}>
            Add indexer
          </Button>
        </>
      }
    >
      {list.isPending ? (
        <Skeleton lines={4} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load indexers" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title="No indexers yet">Add a Torznab or Newznab endpoint, or pick a site from the catalogue.</EmptyState>
      ) : (
        <CardGrid label="Indexers">
          {list.data.map((indexer) => (
            <IndexerCard key={indexer.id} indexer={indexer} onEdit={() => openIndexer(indexer)} result={results[indexer.id]} />
          ))}
        </CardGrid>
      )}
      {picking ? (
        <IndexerChooser
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
        <IndexerEditor key={'indexer' in editing ? editing.indexer.id : editing.template.implementation} editing={editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsPage>
  );
}
