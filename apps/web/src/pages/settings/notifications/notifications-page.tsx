import { useMemo, useState } from 'react';
import { ApiError } from '../../../api/client.js';
import {
  eventFlagLabel,
  eventFlags,
  notificationsApi,
  type Notification,
  type NotificationInput,
  type NotificationSchema,
  type NotificationTestResult,
} from '../../../api/notifications.js';
import { Badge } from '../../../components/badge.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { TagPicker, tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { Modal } from '../../../components/modal.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useDeleteNotification, useNotificationList, useNotificationSchema, useSaveNotification } from '../../../hooks/settings.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError } from '../shared.js';

const NAME_FIELD: FieldDefinition = { name: 'name', label: 'Name', type: 'text', required: true };

export function notificationTestOutcome(r: NotificationTestResult): TestOutcome {
  return { ok: r.ok, warnings: r.warnings ?? [], errors: r.error ? [r.error.message] : [] };
}

function toBody(values: FormValues): NotificationInput {
  const { id: _id, ...rest } = values;
  return rest as NotificationInput;
}

type Editing = { notification: Notification; schema: NotificationSchema | undefined } | { schema: NotificationSchema };

function NotificationEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const existing = 'notification' in editing ? editing.notification : null;
  const fields = useMemo<FieldDefinition[]>(() => {
    const defs = (editing.schema?.fields ?? []) as FieldDefinition[];
    return defs.some((f) => f.name === 'name') ? defs : [NAME_FIELD, ...defs];
  }, [editing.schema]);
  const base = (existing ?? { ...editing.schema!.template, name: editing.schema!.template.name || editing.schema!.implementationName }) as FormValues;
  const form = useSchemaForm(fields, base);
  const save = useSaveNotification();
  const remove = useDeleteNotification();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Flags come from the template (complete list) merged with whatever the row carries.
  const flags = [...new Set([...eventFlags((editing.schema?.template ?? {}) as Record<string, unknown>), ...eventFlags(form.values)])].sort();
  const tags = Array.isArray(form.values.tags) ? (form.values.tags as number[]) : [];

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toBody(form.values) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        title={existing ? `Edit ${existing.name}` : `Add ${editing.schema?.implementationName ?? 'connection'}`}
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
                  notificationTestOutcome(await notificationsApi.test({ ...toBody(form.values), ...(existing ? { id: existing.id } : {}) }))
                }
              />
            }
          />
        }
      >
        <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer }} inline />
        {flags.length ? (
          <FormField inline label="Notify on">
            <div className="check-grid" role="group" aria-label="Events">
              {flags.map((flag) => (
                <label key={flag} className="check">
                  <input
                    type="checkbox"
                    checked={form.values[flag] === true}
                    onChange={(e) => form.setValues({ ...form.values, [flag]: e.currentTarget.checked })}
                  />
                  {eventFlagLabel(flag)}
                </label>
              ))}
            </div>
          </FormField>
        ) : null}
        {fields.some((f) => f.name === 'tags') ? null : (
          <FormField inline label="Tags" hint="Only notify for items with a matching tag; empty means all.">
            <TagPicker value={tags} onChange={(next) => form.setValues({ ...form.values, tags: next })} />
          </FormField>
        )}
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

export function NotificationsPage() {
  const list = useNotificationList();
  const schemas = useNotificationSchema();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  return (
    <Page title="Notifications" subtitle="Connections notify other apps and services about grabs, imports and health issues.">
      <Card>
        {list.isPending ? (
          <LoadingBlock />
        ) : pending ? (
          <PendingApiNotice what="notifications" />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <CardGrid>
            {list.data.map((n) => {
              const schema = schemas.data?.find((s) => s.implementation === n.implementation);
              const on = eventFlags(n).filter((f) => n[f] === true);
              return (
                <ItemCard key={n.id} title={n.name} onClick={() => setEditing({ notification: n, schema })}>
                  <div className="muted">{schema?.implementationName ?? n.implementation}</div>
                  <div className="badge-row">
                    {on.length ? on.map((f) => <Badge key={f}>{eventFlagLabel(f)}</Badge>) : <Badge tone="warning">no events</Badge>}
                  </div>
                </ItemCard>
              );
            })}
            <AddCard label="Add connection" onClick={() => setPicking(true)} />
          </CardGrid>
        )}
      </Card>
      {picking ? (
        <Modal open onClose={() => setPicking(false)} title="Add connection">
          {schemas.isPending ? (
            <LoadingBlock />
          ) : schemas.isError ? (
            schemas.error instanceof ApiError && schemas.error.status === 404 ? <PendingApiNotice what="notifications" /> : <ErrorView error={schemas.error} />
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
                  {s.description ? <span className="muted">{s.description}</span> : null}
                </button>
              ))}
            </CardGrid>
          )}
        </Modal>
      ) : null}
      {editing ? (
        <NotificationEditor
          key={'notification' in editing ? editing.notification.id : editing.schema.implementation}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}
