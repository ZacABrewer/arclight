import { useMemo, useState } from 'react';
import type { Indexer, IndexerDefinitionSummary } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { indexersApi } from '../../../api/indexers.js';
import { Chip, ErrorBlock, Modal, ProtocolBadge, Skeleton } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton } from '../../../components/forms/test-result.js';
import { useCreateIndexer, useDeleteIndexer, useIndexerDefinition, useIndexerProxies, useUpdateIndexer } from '../../../hooks/indexers.js';
import { EditorFooter, SaveError } from '../shared.js';
import { hasSolverProxy } from '../indexer-proxies/proxy-model.js';
import { SolverHint } from './solver-hint.js';
import { definitionBase, definitionFields, definitionNeedsSolver, definitionNotes, definitionValuesOf, PRIVACY_LABELS, PRIVACY_TONES, toDefinitionBody } from './definition-fields.js';
import { indexerTestOutcome } from './indexer-fields.js';
import { IndexerEditorTabs } from './tracker-account.js';
import './indexers.css';
import { t } from '../../../i18n/index.js';

export type DefinitionEditing = { definition: IndexerDefinitionSummary } | { indexer: Indexer };

/** Editor for a catalogue (definition) indexer: fields come from the definition's settings. */
export function DefinitionEditor({ editing, onClose }: { editing: DefinitionEditing; onClose: () => void }) {
  const definitionId = 'definition' in editing ? editing.definition.id : (editing.indexer.settings.definitionId ?? '');
  // A saved indexer needs its definition's field list; a fresh pick already has it.
  const detail = useIndexerDefinition('indexer' in editing ? definitionId : undefined);
  const def = 'definition' in editing ? editing.definition : detail.data;
  const proxies = useIndexerProxies();

  if (!def) {
    return (
      <Modal open size={640} onClose={onClose} title={'indexer' in editing ? t('settings.indexers.definitionEditor.editName', { name: editing.indexer.name }) : t('settings.indexers.definitionEditor.addIndexer')}>
        {detail.isError ? (
          <ErrorBlock title={t('settings.indexers.definitionEditor.couldntLoadTheDefinition')} onRetry={() => void detail.refetch()}>
            {errorMessage(detail.error)}
          </ErrorBlock>
        ) : (
          <Skeleton lines={5} />
        )}
      </Modal>
    );
  }
  return <DefinitionForm def={def} existing={'indexer' in editing ? editing.indexer : null} proxies={proxies.data ?? []} onClose={onClose} />;
}

function DefinitionForm({
  def,
  existing,
  proxies,
  onClose,
}: {
  def: IndexerDefinitionSummary;
  existing: Indexer | null;
  proxies: NonNullable<ReturnType<typeof useIndexerProxies>['data']>;
  onClose: () => void;
}) {
  const fields = useMemo(() => definitionFields(def, proxies), [def, proxies]);
  const form = useSchemaForm(fields, existing ? definitionValuesOf(existing) : definitionBase(def));
  const create = useCreateIndexer();
  const update = useUpdateIndexer({ silent: true });
  const remove = useDeleteIndexer();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const notes = definitionNotes(def);
  const body = () => toDefinitionBody(form.values, def.id);

  const submit = () => {
    if (!form.validate()) return;
    if (existing) update.mutate({ id: existing.id, body: body() }, { onSuccess: onClose });
    else create.mutate(body(), { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={existing ? t('settings.indexers.definitionEditor.editName', { name: existing.name }) : t('settings.indexers.definitionEditor.addName', { name: def.name })}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={create.isPending || update.isPending}
            onDelete={existing ? () => setConfirmDelete(true) : undefined}
            extra={<TestButton beforeTest={form.validate} onTest={async () => indexerTestOutcome(await indexersApi.test(body()))} />}
          />
        }
      >
        <div className="al-def-meta">
          <Chip tone={PRIVACY_TONES[def.privacy]} dot="none">
            {PRIVACY_LABELS[def.privacy]}
          </Chip>
          <ProtocolBadge protocol={def.protocol} />
          {def.tested ? null : (
            <Chip tone="warn" dot="none">
              {t('settings.indexers.definitionEditor.untestedDefinition')}
            </Chip>
          )}
          {def.description ? <span>{def.description}</span> : null}
        </div>
        {definitionNeedsSolver(def) && !hasSolverProxy(proxies) ? <SolverHint /> : null}
        {notes.map((n) => (
          <p key={n.name} className="al-def-note" role="note">
            <strong>{n.label || n.name}</strong>
            {typeof n.default === 'string' && n.default ? <span> {n.default.replace(/<[^>]*>/g, '')}</span> : null}
          </p>
        ))}
        <IndexerEditorTabs indexer={existing} def={def}>
          <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer }} />
          <SaveError error={create.error ?? update.error} />
        </IndexerEditorTabs>
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.indexers.definitionEditor.deleteName', { name: existing.name })}
          confirmLabel={t('settings.indexers.definitionEditor.deleteIndexer')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          <p>{t('settings.indexers.definitionEditor.searchesAndRssStopUsing', { name: existing.name })}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
