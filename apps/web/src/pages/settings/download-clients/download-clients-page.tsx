import { useState } from 'react';
import type {
  DownloadClientImplementationSchema,
  DownloadClientInput,
  DownloadClientResource,
  DownloadClientTestResult,
  RemotePathMapping,
  RemotePathMappingInput,
} from '@media-tron/shared';
import { downloadClientHost } from '@media-tron/shared';
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
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { getPath, setPath } from '../../../components/forms/values.js';
import { categoriesRenderer, cleanCategories } from './categories-field.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { ProtocolBadge } from '../../../components/protocol-badge.js';
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

/** Form values -> create/update body: drop read-only keys (id), omit empty optional numbers. */
export function toDownloadClientBody(values: FormValues, fields: readonly FieldDefinition[] = []): DownloadClientInput {
  const { id: _id, ...rest } = values;
  let body: FormValues = rest;
  for (const f of fields) {
    if (f.type !== 'number') continue;
    const v = getPath(body, f.name);
    if (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v))) body = setPath(body, f.name, undefined);
  }
  // JSON drops undefined keys, but strip them here too so the body is what the api receives.
  const settings = body.settings;
  if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
    const cleaned = Object.fromEntries(Object.entries(settings as FormValues).filter(([, v]) => v !== undefined));
    if (Array.isArray(cleaned.categories)) cleaned.categories = cleanCategories(cleaned.categories);
    body = { ...body, settings: cleaned };
  }
  return body as unknown as DownloadClientInput;
}

export const BUILTIN_DESCRIPTION = "Media-Tron's own BitTorrent engine, running in-process. No separate app or host to configure.";

/** The add-dialog blurb: the api's description, or ours for the built-in engine. */
export function schemaDescription(s: DownloadClientImplementationSchema): string {
  return s.description || (s.implementation === 'builtin' ? BUILTIN_DESCRIPTION : '');
}

/** Second line of a client card: where it lives. */
export function clientLocation(c: DownloadClientResource): string {
  if (c.implementation === 'builtin') return c.settings.savePath ? `built-in engine · ${c.settings.savePath}` : 'built-in engine';
  const s = c.settings;
  return `${s.useSsl ? 'https' : 'http'}://${s.host}:${s.port}${s.urlBase ?? ''}`;
}

/** Add-dialog order: torrent clients first, then usenet, each in the api's order. */
export function sortedSchemas(schemas: readonly DownloadClientImplementationSchema[]): DownloadClientImplementationSchema[] {
  return [...schemas.filter((s) => s.protocol === 'torrent'), ...schemas.filter((s) => s.protocol !== 'torrent')];
}

type Editing = { client: DownloadClientResource; schema: DownloadClientImplementationSchema } | { schema: DownloadClientImplementationSchema };

function DownloadClientEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const existing = 'client' in editing ? editing.client : null;
  const fields = editing.schema.fields as readonly FieldDefinition[];
  const form = useSchemaForm(fields, (existing ?? editing.schema.template) as unknown as FormValues);
  const save = useSaveDownloadClient();
  const remove = useDeleteDownloadClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toDownloadClientBody(form.values, fields) }, { onSuccess: onClose });
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
                    await downloadClientsApi.test({ ...toDownloadClientBody(form.values, fields), ...(existing ? { id: existing.id } : {}) }),
                  )
                }
              />
            }
          />
        }
      >
        {editing.schema.description ? <p className="muted">{editing.schema.description}</p> : null}
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer, 'settings.categories': categoriesRenderer }} inline />
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
  const hosts = [...new Set((clients.data ?? []).map((c) => downloadClientHost(c.settings)))];

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
                    status={
                      <span className="chip-stack">
                        <ProtocolBadge protocol={c.protocol} />
                        <Badge tone={c.enable ? 'ok' : 'neutral'}>{c.enable ? 'enabled' : 'disabled'}</Badge>
                      </span>
                    }
                  >
                    <div className="muted">
                      {schema?.implementationName ?? c.implementation} · priority {c.priority}
                    </div>
                    <div className="muted">{clientLocation(c)}</div>
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
              {sortedSchemas(schemas.data).map((s) => (
                <button
                  key={s.implementation}
                  type="button"
                  className="item-card add-card"
                  onClick={() => {
                    setPicking(false);
                    setEditing({ schema: s });
                  }}
                >
                  <span className="chip-stack">
                    <strong>{s.implementationName}</strong>
                    <ProtocolBadge protocol={s.protocol} />
                  </span>
                  <span className="muted">{schemaDescription(s)}</span>
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
