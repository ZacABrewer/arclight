import { useMemo, useState } from 'react';
import { ApiError, errorMessage } from '../../../api/client.js';
import {
  eventFlagLabel,
  eventFlags,
  notificationsApi,
  type Notification,
  type NotificationInput,
  type NotificationSchema,
  type NotificationTestResult,
} from '../../../api/notifications.js';
import { Button, Checkbox, Chip, ErrorBlock, Field, Modal, Skeleton, Tag } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import { TagPicker, tagRenderer } from '../../../components/forms/tag-picker.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { useDeleteNotification, useNotificationList, useNotificationSchema, useSaveNotification } from '../../../hooks/settings.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError, SettingsSection } from '../shared.js';
import './notifications.css';

const NAME_FIELD: FieldDefinition = { name: 'name', label: 'Name', type: 'text', required: true };

export function notificationTestOutcome(r: NotificationTestResult): TestOutcome {
  return { ok: r.ok, warnings: r.warnings ?? [], errors: r.error ? [r.error.message] : [] };
}

/** `onGrab` -> "On grab", `onHealthIssue` -> "On health issue" (sentence case for tags). */
export function eventFlagTag(flag: string): string {
  const words = eventFlagLabel(flag).toLowerCase();
  return `On ${words}`;
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
        size={640}
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
        <div className="al-notification-editor">
          <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} renderers={{ tags: tagRenderer }} />
          {flags.length ? (
            <fieldset className="al-event-flags">
              <legend className="al-label">Notify on</legend>
              <div className="al-check-grid" role="group" aria-label="Events">
                {flags.map((flag) => (
                  <Checkbox
                    key={flag}
                    label={eventFlagTag(flag)}
                    checked={form.values[flag] === true}
                    onChange={(e) => form.setValues({ ...form.values, [flag]: e.currentTarget.checked })}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          {fields.some((f) => f.name === 'tags') ? null : (
            <Field label="Tags" hint="Only notify for items with a matching tag; empty means all.">
              <TagPicker value={tags} onChange={(next) => form.setValues({ ...form.values, tags: next })} />
            </Field>
          )}
          <SaveError error={save.error} />
        </div>
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${existing.name}?`}
          confirmLabel="Delete notification"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          Arclight stops sending events to this connection.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function NotificationCard({ notification: n, schema, onEdit }: { notification: Notification; schema: NotificationSchema | undefined; onEdit: () => void }) {
  const on = eventFlags(n).filter((f) => n[f] === true);
  return (
    <ItemCard
      title={n.name}
      onClick={onEdit}
      status={on.length ? null : <Chip tone="warn">No events</Chip>}
      actions={
        <>
          <TestButton
            size="sm"
            onTest={async () => {
              const { id, ...rest } = n;
              return notificationTestOutcome(await notificationsApi.test({ ...rest, id }));
            }}
          />
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit ${n.name}`}>
            Edit
          </Button>
        </>
      }
    >
      <span className="al-card-line">{schema?.implementationName ?? n.implementation}</span>
      {on.map((f) => (
        <Tag key={f}>{eventFlagTag(f)}</Tag>
      ))}
    </ItemCard>
  );
}

export function NotificationsPage() {
  const list = useNotificationList();
  const schemas = useNotificationSchema();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  return (
    <SettingsPage
      title="Notifications"
      description="Connections tell other apps and services about grabs, imports and health issues."
      actions={
        <Button variant="primary" onClick={() => setPicking(true)}>
          Add connection
        </Button>
      }
    >
      <SettingsSection label="Connections" {...(list.data ? { count: list.data.length } : {})}>
        {list.isPending ? (
          <Skeleton lines={3} />
        ) : pending ? (
          <PendingApiNotice what="notifications" />
        ) : list.isError ? (
          <ErrorBlock title="Could not load notifications" onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <CardGrid label="Connections">
            {list.data.map((n) => {
              const schema = schemas.data?.find((s) => s.implementation === n.implementation);
              return <NotificationCard key={n.id} notification={n} schema={schema} onEdit={() => setEditing({ notification: n, schema })} />;
            })}
            <AddCard label="Add notification" onClick={() => setPicking(true)} />
          </CardGrid>
        )}
      </SettingsSection>
      {picking ? (
        <Modal open size={640} onClose={() => setPicking(false)} title="Add connection">
          {schemas.isPending ? (
            <Skeleton lines={4} />
          ) : schemas.isError ? (
            schemas.error instanceof ApiError && schemas.error.status === 404 ? (
              <PendingApiNotice what="notifications" />
            ) : (
              <ErrorBlock title="Could not load connection types">{errorMessage(schemas.error)}</ErrorBlock>
            )
          ) : (
            <div className="al-chooser" role="list" aria-label="Connection types">
              {schemas.data.map((s) => (
                <div role="listitem" key={s.implementation}>
                  <button
                    type="button"
                    className="al-chooser__item"
                    onClick={() => {
                      setPicking(false);
                      setEditing({ schema: s });
                    }}
                  >
                    <span className="al-chooser__name">{s.implementationName}</span>
                    {s.description ? <span className="al-chooser__desc">{s.description}</span> : null}
                  </button>
                </div>
              ))}
            </div>
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
    </SettingsPage>
  );
}
