import { useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type {
  DownloadClientImplementationSchema,
  DownloadClientInput,
  DownloadClientResource,
  DownloadClientTestResult,
  RemotePathMapping,
  RemotePathMappingInput,
} from '@arclight/shared';
import { downloadClientHost } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { downloadClientsApi } from '../../../api/download-clients.js';
import { Button, Chip, EmptyState, ErrorBlock, Field, Input, Modal, ProtocolBadge, Skeleton, Table, buttonClass, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton, TestResultView, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { getPath, setPath } from '../../../components/forms/values.js';
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
import { SettingsPage } from '../settings-layout.js';
import { CardGrid, EditorFooter, ItemCard, SaveError, SettingsSection } from '../shared.js';
import { categoriesRenderer, cleanCategories } from './categories-field.js';
import '../indexers/indexers.css';
import './download-clients.css';

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

export const BUILTIN_DESCRIPTION = "Arclight's own BitTorrent engine, running in-process. No separate app or host to configure.";

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
  const description = schemaDescription(editing.schema);

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toDownloadClientBody(form.values, fields) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
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
        {description ? <p className="al-caption al-dc-desc">{description}</p> : null}
        <SchemaForm
          fields={fields}
          values={form.values}
          errors={form.errors}
          onChange={form.setValues}
          renderers={{ tags: tagRenderer, 'settings.categories': categoriesRenderer }}
        />
        <SaveError error={save.error} />
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${existing.name}?`}
          confirmLabel="Delete download client"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          <p>Arclight stops sending releases to {existing.name}.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Add chooser (640): torrent clients first, each row with its protocol badge and description. */
function ClientChooser({ onPick, onClose }: { onPick: (s: DownloadClientImplementationSchema) => void; onClose: () => void }) {
  const schemas = useDownloadClientSchema();
  return (
    <Modal open size={640} onClose={onClose} title="Add download client">
      {schemas.isPending ? (
        <Skeleton lines={4} />
      ) : schemas.isError ? (
        <ErrorBlock title="Couldn't load client types" onRetry={() => void schemas.refetch()}>
          {errorMessage(schemas.error)}
        </ErrorBlock>
      ) : (
        <ul className="al-chooser__list" aria-label="Client types">
          {sortedSchemas(schemas.data).map((s) => (
            <li key={s.implementation}>
              <button type="button" className="al-chooser__row" onClick={() => onPick(s)}>
                <span className="al-chooser__head">
                  <span className="al-chooser__name">{s.implementationName}</span>
                  <ProtocolBadge protocol={s.protocol} />
                </span>
                {schemaDescription(s) ? <span className="al-chooser__desc">{schemaDescription(s)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function MappingEditor({ mapping, onClose }: { mapping: RemotePathMapping | null; onClose: () => void }) {
  const [draft, setDraft] = useState<RemotePathMappingInput>(
    mapping ? { host: mapping.host, remotePath: mapping.remotePath, localPath: mapping.localPath } : { host: '', remotePath: '', localPath: '' },
  );
  const [error, setError] = useState<string>();
  const save = useSaveRemotePathMapping();
  const clients = useDownloadClientList();
  const hosts = [...new Set((clients.data ?? []).filter((c) => c.implementation !== 'builtin').map((c) => downloadClientHost(c.settings)))];
  const hostId = useId();
  const remoteId = useId();
  const localId = useId();
  const listId = useId();

  const submit = () => {
    if (!draft.host.trim() || !draft.remotePath || !draft.localPath.trim()) return setError('Host, remote path and local path are all required');
    setError(undefined);
    save.mutate({ id: mapping?.id, body: draft }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={mapping ? 'Edit remote path mapping' : 'Add remote path mapping'}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} />}
    >
      <div className="al-schema-form__stack">
        <Field label="Host" htmlFor={hostId} hint="The download client host this mapping applies to." error={error}>
          <Input id={hostId} mono list={listId} value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.currentTarget.value })} />
        </Field>
        <datalist id={listId}>
          {hosts.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        <Field label="Remote path" htmlFor={remoteId} hint="The path as the download client reports it.">
          <Input id={remoteId} mono value={draft.remotePath} onChange={(e) => setDraft({ ...draft, remotePath: e.currentTarget.value })} />
        </Field>
        <Field label="Local path" htmlFor={localId} hint="The same folder as Arclight sees it.">
          <Input id={localId} mono value={draft.localPath} onChange={(e) => setDraft({ ...draft, localPath: e.currentTarget.value })} />
        </Field>
      </div>
      <SaveError error={save.error} />
    </Modal>
  );
}

/** REMOTE PATH MAPPINGS: host, remote path (mono), local path (mono), Edit / Delete. */
function RemotePathMappingsSection() {
  const list = useRemotePathMappings();
  const remove = useDeleteRemotePathMapping();
  const [editing, setEditing] = useState<RemotePathMapping | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RemotePathMapping | null>(null);

  const columns: Column<RemotePathMapping>[] = [
    { key: 'host', header: 'Host', cell: (m) => m.host, mono: true },
    { key: 'remote', header: 'Remote path', cell: (m) => m.remotePath, mono: true },
    { key: 'local', header: 'Local path', cell: (m) => m.localPath, mono: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (m) => (
        <span className="al-dc-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(m)} aria-label={`Edit mapping ${m.remotePath}`}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(m)} aria-label={`Delete mapping ${m.remotePath}`}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsSection
      label="Remote path mappings"
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          Add mapping
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={2} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load remote path mappings" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title="No mappings">Only needed when the download client sees paths differently from Arclight (e.g. Docker).</EmptyState>
      ) : (
        <Table columns={columns} rows={list.data} rowKey={(m) => m.id} caption="Remote path mappings" stickyHeader={false} />
      )}
      {editing ? <MappingEditor key={editing === 'new' ? 'new' : editing.id} mapping={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete remote path mapping?"
        confirmLabel="Delete mapping"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      >
        {deleting ? (
          <p>
            Paths from <span className="al-num">{deleting.host}</span> under <span className="al-num">{deleting.remotePath}</span> are no longer translated.
          </p>
        ) : null}
      </ConfirmDialog>
    </SettingsSection>
  );
}

/** One client card: name, status chip, protocol, priority (mono), location (mono), Test / Edit. */
export function DownloadClientCard({
  client,
  schema,
  onEdit,
  result,
}: {
  client: DownloadClientResource;
  schema: DownloadClientImplementationSchema | undefined;
  onEdit: (() => void) | undefined;
  result?: TestOutcome | undefined;
}) {
  const builtin = client.implementation === 'builtin';
  return (
    <ItemCard
      title={client.name}
      muted={!client.enable}
      onClick={onEdit}
      status={client.enable ? <Chip tone="accent">Enabled</Chip> : <Chip tone="muted">Disabled</Chip>}
      actions={
        <>
          <TestButton
            size="sm"
            onTest={async () => downloadClientTestOutcome(await downloadClientsApi.test({ ...toDownloadClientBody(client as unknown as FormValues), id: client.id }))}
          />
          {onEdit ? (
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${client.name}`}>
              Edit
            </Button>
          ) : null}
          {builtin ? (
            <Link to="/settings/torrent" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
              Engine settings
            </Link>
          ) : null}
        </>
      }
    >
      <ProtocolBadge protocol={client.protocol} />
      <span>{schema?.implementationName ?? client.implementation}</span>
      <span>
        Priority <span className="al-card-priority">{client.priority}</span>
      </span>
      <span className="al-card-line al-card-line--mono">{clientLocation(client)}</span>
      {result ? <TestResultView outcome={result} /> : null}
    </ItemCard>
  );
}

/** Settings → Download clients: card grid, add chooser, editor and remote path mappings. */
export function DownloadClientsPage() {
  const list = useDownloadClientList();
  const schemas = useDownloadClientSchema();
  const testAll = useTestAllDownloadClients();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [results, setResults] = useState<Record<number, TestOutcome>>({});

  const schemaFor = (impl: string) => schemas.data?.find((s) => s.implementation === impl);

  return (
    <SettingsPage
      title="Download clients"
      actions={
        <>
          <Button
            variant="secondary"
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
          <Button variant="primary" onClick={() => setPicking(true)}>
            Add download client
          </Button>
        </>
      }
    >
      {list.isPending ? (
        <Skeleton lines={4} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load download clients" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data.length === 0 ? (
        <EmptyState title="No download clients yet">Add the built-in engine or a client such as qBittorrent or SABnzbd.</EmptyState>
      ) : (
        <CardGrid label="Download clients">
          {list.data.map((c) => {
            const schema = schemaFor(c.implementation);
            return (
              <DownloadClientCard
                key={c.id}
                client={c}
                schema={schema}
                onEdit={schema ? () => setEditing({ client: c, schema }) : undefined}
                result={results[c.id]}
              />
            );
          })}
        </CardGrid>
      )}
      <RemotePathMappingsSection />
      {picking ? (
        <ClientChooser
          onClose={() => setPicking(false)}
          onPick={(s) => {
            setPicking(false);
            setEditing({ schema: s });
          }}
        />
      ) : null}
      {editing ? (
        <DownloadClientEditor key={'client' in editing ? editing.client.id : editing.schema.implementation} editing={editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsPage>
  );
}
