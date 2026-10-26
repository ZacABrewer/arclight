import { useState } from 'react';
import type {
  DownloadClientImplementationSchema,
  DownloadClientInput,
  DownloadClientResource,
  DownloadClientTestResult,
  RemotePathMapping,
  RemotePathMappingInput,
} from '@media-tron/shared';
import { downloadClientsApi } from '../../../api/download-clients.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FormValues } from '../../../components/forms/types.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import {
  useDeleteDownloadClient,
  useDeleteRemotePathMapping,
  useDownloadClientList,
  useDownloadClientSchema,
  useRemotePathMappings,
  useSaveDownloadClient,
  useSaveRemotePathMapping,
  useTestAllDownloadClients,
} from '../../../hooks/download-clients.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError } from '../shared.js';

export function downloadClientTestOutcome(r: DownloadClientTestResult): TestOutcome {
  return {
    ok: r.ok,
    message: r.version ? `version ${r.version}${r.apiVersion ? ` (API ${r.apiVersion})` : ''}` : undefined,
    warnings: r.warnings,
    errors: r.error ? [`${r.error.message} (${r.error.code})`] : [],
  };
}

/** Form values -> create/update body: drop read-only keys (id). */
export function toDownloadClientBody(values: FormValues): DownloadClientInput {
  const { id: _id, ...rest } = values;
  return rest as unknown as DownloadClientInput;
}

type Editing = { client: DownloadClientResource; schema: DownloadClientImplementationSchema } | { schema: DownloadClientImplementationSchema };

function DownloadClientEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const existing = 'client' in editing ? editing.client : null;
  const fields = editing.schema.fields;
  const form = useSchemaForm(fields, (existing ?? editing.schema.template) as unknown as FormValues);
  const save = useSaveDownloadClient();
  const remove = useDeleteDownloadClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toDownloadClientBody(form.values) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        title={existing ? `Edit ${existing.name}` : `Add ${editing.schema.implementationName}`}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={existing ? () => setConfirmDelete(true) : undefined}
            extra={
              <TestButton
                beforeTest={form.validate}
                onTest={async () =>
                  downloadClientTestOutcome(
                    await downloadClientsApi.test({ ...toDownloadClientBody(form.values), ...(existing ? { id: existing.id } : {}) }),
                  )
                }
              />
            }
          />
        }
      >
        {editing.schema.description ? <p className="muted">{editing.schema.description}</p> : null}
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer }} inline />
        <SaveError error={save.error} />
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

function MappingEditor({ mapping, onClose }: { mapping: RemotePathMapping | null; onClose: () => void }) {
  const [draft, setDraft] = useState<RemotePathMappingInput>(
    mapping ? { host: mapping.host, remotePath: mapping.remotePath, localPath: mapping.localPath } : { host: '', remotePath: '', localPath: '' },
  );
  const [error, setError] = useState<string>();
  const save = useSaveRemotePathMapping();
  const remove = useDeleteRemotePathMapping();
  const clients = useDownloadClientList();
  const hosts = [...new Set((clients.data ?? []).map((c) => c.settings.host))];

  const submit = () => {
    if (!draft.host.trim() || !draft.remotePath || !draft.localPath.trim()) return setError('Host, remote path and local path are all required');
    setError(undefined);
    save.mutate({ id: mapping?.id, body: draft }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mapping ? 'Edit remote path mapping' : 'Add remote path mapping'}
      footer={
        <EditorFooter
          onCancel={onClose}
          onSave={submit}
          saving={save.isPending}
          onDelete={mapping ? () => remove.mutate(mapping.id, { onSuccess: onClose }) : undefined}
        />
      }
    >
      <FormField label="Host" hint="The download client host this mapping applies to." error={error}>
        <Input list="rpm-hosts" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.currentTarget.value })} />
      </FormField>
      <datalist id="rpm-hosts">
        {hosts.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      <FormField label="Remote path" hint="The path as the download client reports it.">
        <Input value={draft.remotePath} onChange={(e) => setDraft({ ...draft, remotePath: e.currentTarget.value })} />
      </FormField>
      <FormField label="Local path" hint="The same directory as Media-Tron sees it.">
        <Input value={draft.localPath} onChange={(e) => setDraft({ ...draft, localPath: e.currentTarget.value })} />
      </FormField>
      <SaveError error={save.error} />
    </Modal>
  );
}

function RemotePathMappingsCard() {
  const list = useRemotePathMappings();
  const [editing, setEditing] = useState<RemotePathMapping | 'new' | null>(null);
  return (
    <Card
      title="Remote path mappings"
      flush
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          Add
        </Button>
      }
    >
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No mappings">Only needed when the download client sees paths differently from Media-Tron (e.g. Docker).</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Remote path</th>
                <th>Local path</th>
                <th className="align-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={m.id}>
                  <td>{m.host}</td>
                  <td>
                    <code>{m.remotePath}</code>
                  </td>
                  <td>
                    <code>{m.localPath}</code>
                  </td>
                  <td className="align-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <MappingEditor key={editing === 'new' ? 'new' : editing.id} mapping={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

export function DownloadClientsPage() {
  const list = useDownloadClientList();
  const schemas = useDownloadClientSchema();
  const testAll = useTestAllDownloadClients();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [results, setResults] = useState<Record<number, TestOutcome>>({});

  const schemaFor = (impl: string) => schemas.data?.find((s) => s.implementation === impl);

  return (
    <Page
      title="Download Clients"
      actions={
        <Button
          loading={testAll.isPending}
          disabled={!list.data?.length}
          onClick={() =>
            testAll.mutate(undefined, {
              onSuccess: (r) => setResults(Object.fromEntries(r.map((x) => [x.id, downloadClientTestOutcome(x)]))),
            })
          }
        >
          Test all
        </Button>
      }
    >
      <div className="stack">
        <Card>
          {list.isPending ? (
            <LoadingBlock />
          ) : list.isError ? (
            <ErrorView error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <CardGrid>
              {list.data.map((c) => {
                const schema = schemaFor(c.implementation);
                const result = results[c.id];
                return (
                  <ItemCard
                    key={c.id}
                    title={c.name}
                    muted={!c.enable}
                    onClick={schema ? () => setEditing({ client: c, schema }) : undefined}
                    status={<Badge tone={c.enable ? 'ok' : 'neutral'}>{c.enable ? 'enabled' : 'disabled'}</Badge>}
                  >
                    <div className="muted">
                      {schema?.implementationName ?? c.implementation} · {c.protocol} · priority {c.priority}
                    </div>
                    <div className="muted">
                      {c.settings.useSsl ? 'https' : 'http'}://{c.settings.host}:{c.settings.port}
                      {c.settings.urlBase ?? ''}
                    </div>
                    {result ? (
                      <div className={result.ok ? 'text-ok' : 'text-error'}>
                        {result.ok ? `Test passed${result.message ? ` · ${result.message}` : ''}` : `Test failed: ${result.errors.join('; ')}`}
                      </div>
                    ) : null}
                  </ItemCard>
                );
              })}
              <AddCard label="Add download client" onClick={() => setPicking(true)} />
            </CardGrid>
          )}
        </Card>
        <RemotePathMappingsCard />
      </div>
      {picking ? (
        <Modal open onClose={() => setPicking(false)} title="Add download client">
          {schemas.isPending ? (
            <LoadingBlock />
          ) : schemas.isError ? (
            <ErrorView error={schemas.error} />
          ) : (
            <CardGrid>
              {schemas.data.map((s) => (
                <button
                  key={s.implementation}
                  type="button"
                  className="item-card add-card"
                  onClick={() => {
                    setPicking(false);
                    setEditing({ schema: s });
                  }}
                >
                  <strong>{s.implementationName}</strong>
                  <span className="muted">{s.description}</span>
                </button>
              ))}
            </CardGrid>
          )}
        </Modal>
      ) : null}
      {editing ? (
        <DownloadClientEditor
          key={'client' in editing ? editing.client.id : editing.schema.implementation}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}
