import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  useIndexerProxies,
  useIndexerTemplates,
  useTestAllIndexers,
  useUpdateIndexer,
} from '../../../hooks/indexers.js';
import { formatDateTime } from '../../../lib/format.js';
import { SettingsPage } from '../settings-layout.js';
import { CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';
import { CatalogueList, TemplateList } from './catalogue.js';
import { DefinitionEditor } from './definition-editor.js';
import { definitionNeedsSolver, filterTemplates } from './definition-fields.js';
import { hasSolverProxy } from '../indexer-proxies/proxy-model.js';
import { settingsKeys } from '../../../hooks/settings-keys.js';
import { SolverHint } from './solver-hint.js';
import { IndexerEditorTabs } from './tracker-account.js';
import { categoryRenderer, indexerFields, indexerTestOutcome, toIndexerBody } from './indexer-fields.js';
import './indexers.css';
import { t } from '../../../i18n/index.js';

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
  if (off) return { tone: 'muted', label: t('common.disabled') };
  const s = indexer.status;
  if (s?.disabledTill && new Date(s.disabledTill).getTime() > now) {
    return {
      tone: 'warn',
      label: t('settings.indexers.backingOffRetryClocktime', { clockTime: clockTime(s.disabledTill) }),
      title: t('settings.indexers.skippedUntilDatetimeAfterFailurecount', { dateTime: formatDateTime(s.disabledTill), failureCount: s.failureCount }),
    };
  }
  if (s && s.failureCount > 0) return { tone: 'danger', label: t('settings.indexers.failedFailurecountRecentFailures', { failureCount: s.failureCount }) };
  return { tone: 'accent', label: t('common.enabled') };
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
        title={existing ? t('settings.indexers.editName', { name: existing.name }) : t('settings.indexers.addValueIndexer', { value: 'template' in editing ? editing.template.implementationName : '' })}
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
        <IndexerEditorTabs indexer={existing}>
          <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={renderers} />
          <SaveError error={create.error ?? update.error} />
        </IndexerEditorTabs>
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.indexers.deleteName', { name: existing.name })}
          confirmLabel={t('settings.indexers.deleteIndexer')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          <p>{t('settings.indexers.searchesAndRssStopUsing', { name: existing.name })}</p>
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
  onPick: (item: IndexerTemplate) => void;
  onPickDefinition: (d: IndexerDefinitionSummary) => void;
  onClose: () => void;
}) {
  const templates = useIndexerTemplates();
  const [text, setText] = useState('');
  const endpoints = templates.isPending ? (
    <Skeleton lines={3} />
  ) : templates.isError ? (
    <ErrorBlock title={t('settings.indexers.couldntLoadEndpointTypes')} onRetry={() => void templates.refetch()}>
      {errorMessage(templates.error)}
    </ErrorBlock>
  ) : (
    <TemplateList templates={filterTemplates(templates.data, text)} onPick={onPick} />
  );
  return (
    <Modal open size={640} onClose={onClose} title={t('settings.indexers.addIndexer')}>
      <div className="al-chooser">
        <Input
          type="search"
          aria-label={t('settings.indexers.searchIndexers')}
          placeholder={t('settings.indexers.searchByNameDescriptionOr')}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Tabs
          aria-label={t('settings.indexers.indexerSources')}
          tabs={[
            { id: 'endpoint', label: t('settings.indexers.torznabNewznab'), content: endpoints },
            { id: 'catalogue', label: t('settings.indexers.catalogue'), content: <CatalogueList text={text} onPick={onPickDefinition} /> },
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

const IMPLEMENTATION_LABELS: Record<string, string> = { get torznab() { return t('settings.indexers.torznab'); }, get newznab() { return t('settings.indexers.newznab'); }, get definition() { return t('settings.indexers.catalogue'); } };

/** One indexer card: name, status chip, protocol, priority (mono), Test / Edit. */
export function IndexerCard({
  indexer,
  onEdit,
  result,
  needsSolver = false,
}: {
  indexer: Indexer;
  onEdit: () => void;
  result?: IndexerTestAllItem | undefined;
  /** Its definition needs a challenge solver and none is configured. */
  needsSolver?: boolean;
}) {
  const health = indexerHealth(indexer);
  const source = indexerSourceLine(indexer);
  return (
    <ItemCard
      title={indexer.name}
      muted={health.tone === 'muted'}
      onClick={onEdit}
      status={
        <Chip tone={health.tone} title={health.title}>
          {health.label}
        </Chip>
      }
      actions={
        <>
          <TestButton size="sm" onTest={async () => indexerTestOutcome(await indexersApi.test(toIndexerBody(indexer as unknown as Record<string, unknown>)))} />
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t('settings.indexers.editName', { name: indexer.name })}>
            {t('common.edit')}
          </Button>
        </>
      }
    >
      <ProtocolBadge protocol={indexer.protocol} />
      <span>{IMPLEMENTATION_LABELS[indexer.implementation] ?? indexer.implementation}</span>
      <span>
        {t('common.priority')} <span className="al-card-priority">{indexer.priority}</span>
      </span>
      {source ? <span className="al-card-line">{source}</span> : null}
      {needsSolver ? <SolverHint as="span" /> : null}
      {result ? (
        <TestResultView
          outcome={{
            ok: result.ok,
            message: result.ok ? t('settings.indexers.valueReleases', { value: result.releaseCount ?? 0 }) : undefined,
            warnings: [],
            errors: result.ok ? [] : [result.error?.message ?? t('settings.indexers.unknownError')],
          }}
        />
      ) : null}
    </ItemCard>
  );
}

/**
 * Ids of definition indexers whose definition needs a challenge solver while no
 * FlareSolverr-type proxy exists. The catalogue is only fetched in that situation.
 */
export function useSolverHints(indexers: readonly Indexer[] | undefined): Set<number> {
  const proxies = useIndexerProxies();
  const definitionIds = (indexers ?? []).filter((i) => i.implementation === 'definition' && i.settings.definitionId);
  const missingSolver = proxies.isSuccess && !hasSolverProxy(proxies.data);
  const catalogue = useQuery({
    queryKey: settingsKeys.indexerDefinitions({}),
    queryFn: () => indexersApi.definitions.list({}),
    staleTime: 60_000,
    enabled: missingSolver && definitionIds.length > 0,
  });
  return useMemo(() => {
    if (!missingSolver || !catalogue.data) return new Set<number>();
    const needs = new Set(catalogue.data.filter(definitionNeedsSolver).map((d) => d.id));
    return new Set(definitionIds.filter((i) => needs.has(i.settings.definitionId ?? '')).map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingSolver, catalogue.data, indexers]);
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
  const needsSolverIds = useSolverHints(list.data);

  return (
    <SettingsPage
      title={t('common.indexers')}
      standalone={{ index: '08', title: t('common.indexers') }}
      actions={
        <>
          <Button
            variant="secondary"
            loading={testAll.isPending}
            disabled={!list.data?.length}
            onClick={() => testAll.mutate(undefined, { onSuccess: (r) => setResults(Object.fromEntries(r.map((x) => [x.id, x]))) })}
          >
            {t('settings.indexers.testAll')}
          </Button>
          <Button variant="primary" onClick={() => setPicking(true)}>
            {t('settings.indexers.addIndexer')}
          </Button>
        </>
      }
    >
      {list.isPending ? (
        <Skeleton lines={4} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.indexers.couldntLoadIndexers')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title={t('settings.indexers.noIndexersYet')}>{t('settings.indexers.addATorznabOrNewznab')}</EmptyState>
      ) : (
        <CardGrid label={t('common.indexers')}>
          {list.data.map((indexer) => (
            <IndexerCard key={indexer.id} indexer={indexer} onEdit={() => openIndexer(indexer)} result={results[indexer.id]} needsSolver={needsSolverIds.has(indexer.id)} />
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
