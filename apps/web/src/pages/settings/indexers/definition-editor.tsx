import { useMemo, useState } from 'react';
import type { Indexer, IndexerDefinitionSummary } from '@media-tron/shared';
import { indexersApi } from '../../../api/indexers.js';
import { Badge } from '../../../components/badge.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton } from '../../../components/forms/test-result.js';
import { Modal } from '../../../components/modal.js';
import { ProtocolBadge } from '../../../components/protocol-badge.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useCreateIndexer, useDeleteIndexer, useIndexerDefinition, useIndexerProxies, useUpdateIndexer } from '../../../hooks/indexers.js';
import { EditorFooter, SaveError } from '../shared.js';
import { definitionBase, definitionFields, definitionNotes, definitionValuesOf, PRIVACY_TONES, toDefinitionBody } from './definition-fields.js';
import { indexerTestOutcome } from './indexer-fields.js';

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
      <Modal open onClose={onClose} title={'indexer' in editing ? `Edit ${editing.indexer.name}` : 'Add indexer'}>
        {detail.isError ? <ErrorView error={detail.error} /> : <LoadingBlock />}
      </Modal>
    );
  }
  return (
    <DefinitionForm
      def={def}
      existing={'indexer' in editing ? editing.indexer : null}
      proxies={proxies.data ?? []}
      onClose={onClose}
    />
  );
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
        size="lg"
        onClose={onClose}
        title={existing ? `Edit ${existing.name}` : `Add ${def.name}`}
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
        <div className="row definition-meta">
          <Badge tone={PRIVACY_TONES[def.privacy]}>{def.privacy}</Badge>
          <ProtocolBadge protocol={def.protocol} />
          {def.tested ? <Badge tone="ok">tested</Badge> : <Badge tone="warning">untested definition</Badge>}
          <span className="muted">{def.description}</span>
        </div>
        {notes.map((n) => (
          <div key={n.name} className="notice notice-info" role="note">
            <strong>{n.label || n.name}</strong>
            {typeof n.default === 'string' && n.default ? <span> {n.default.replace(/<[^>]*>/g, '')}</span> : null}
          </div>
        ))}
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer }} inline />
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
