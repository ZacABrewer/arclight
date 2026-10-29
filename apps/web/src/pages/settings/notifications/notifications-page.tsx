import { useMemo, useState } from 'react';
import { supportFlagFor, type NotificationTrigger } from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import {
  eventFlagLabel,
  eventFlags,
  fromNotificationForm,
  notificationFormFields,
  notificationsApi,
  toNotificationForm,
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
import { AddCard, CardGrid, EditorFooter, ItemCard, PendingApiNotice, SaveError, SettingsSection, type ItemCardSelect } from '../shared.js';
import { useResourceBulk } from '../../../components/resource-bulk-actions.js';
import { AlertSettingsSection } from './alert-settings-section.js';
import './notifications.css';
import { t } from '../../../i18n/index.js';

const NAME_FIELD: FieldDefinition = { name: 'name', get label() { return t('common.name'); }, type: 'text', required: true };

export function notificationTestOutcome(r: NotificationTestResult): TestOutcome {
  return { ok: r.ok, warnings: r.warnings ?? [], errors: r.error ? [r.error.message] : [] };
}

/** `onGrab` -> "On grab", `onHealthIssue` -> "On health issue" (sentence case for tags). */
export function eventFlagTag(flag: string): string {
  const words = eventFlagLabel(flag).toLowerCase();
  return t('settings.notifications.onWords', { words });
}

/** The sitewide request and issue triggers, in display order. */
export const REQUEST_TRIGGERS = [
  'onRequestCreated',
  'onRequestApproved',
  'onRequestDeclined',
  'onRequestAvailable',
  'onIssueCreated',
  'onIssueUpdated',
] as const satisfies readonly NotificationTrigger[];

const REQUEST_TRIGGER_LABELS: Record<(typeof REQUEST_TRIGGERS)[number], string> = {
  get onRequestCreated() {
    return t('settings.notifications.newRequest');
  },
  get onRequestApproved() {
    return t('common.requestApproved');
  },
  get onRequestDeclined() {
    return t('settings.notifications.requestDeclined');
  },
  get onRequestAvailable() {
    return t('settings.notifications.requestAvailable');
  },
  get onIssueCreated() {
    return t('settings.notifications.newIssue');
  },
  get onIssueUpdated() {
    return t('settings.notifications.issueUpdated');
  },
};

export function requestTriggerLabel(flag: (typeof REQUEST_TRIGGERS)[number]): string {
  return REQUEST_TRIGGER_LABELS[flag];
}

/** Download-problem triggers (timeline, kill switch, disk space) and the daily summary, in display order. */
export const DOWNLOAD_TRIGGERS = [
  'onDownloadStalled',
  'onImportProblem',
  'onDownloadRecovered',
  'onKillSwitch',
  'onKillSwitchResumed',
  'onDiskSpaceLow',
  'onDailySummary',
] as const satisfies readonly NotificationTrigger[];

type DownloadTrigger = (typeof DOWNLOAD_TRIGGERS)[number];

const DOWNLOAD_TRIGGER_LABELS: Record<DownloadTrigger, string> = {
  get onDownloadStalled() {
    return t('settings.notifications.downloadStalled');
  },
  get onImportProblem() {
    return t('settings.notifications.importProblem');
  },
  get onDownloadRecovered() {
    return t('settings.notifications.downloadRecovered');
  },
  get onKillSwitch() {
    return t('settings.notifications.killSwitchEngaged');
  },
  get onKillSwitchResumed() {
    return t('settings.notifications.killSwitchResumed');
  },
  get onDiskSpaceLow() {
    return t('settings.notifications.diskSpaceLow');
  },
  get onDailySummary() {
    return t('settings.notifications.dailySummary');
  },
};

export function downloadTriggerLabel(flag: DownloadTrigger): string {
  return DOWNLOAD_TRIGGER_LABELS[flag];
}

/** Card tag for any flag: the grouped triggers keep their own labels. */
function flagTag(flag: string): string {
  return DOWNLOAD_TRIGGER_SET.has(flag) ? downloadTriggerLabel(flag as DownloadTrigger) : eventFlagTag(flag);
}

/**
 * Triggers of `list` the agent supports: a `supportsOn*` flag decides when the source carries
 * one; otherwise the trigger shows when the source has the boolean at all.
 */
function supportedTriggers<T extends NotificationTrigger>(list: readonly T[], source: Record<string, unknown>): T[] {
  return list.filter((item) => {
    const support = source[supportFlagFor(item)];
    return typeof support === 'boolean' ? support : typeof source[item] === 'boolean';
  });
}

/** Request/issue triggers the agent supports. */
export function supportedRequestTriggers(source: Record<string, unknown>): Array<(typeof REQUEST_TRIGGERS)[number]> {
  return supportedTriggers(REQUEST_TRIGGERS, source);
}

/** Download-problem and summary triggers the agent supports. */
export function supportedDownloadTriggers(source: Record<string, unknown>): DownloadTrigger[] {
  return supportedTriggers(DOWNLOAD_TRIGGERS, source);
}

const REQUEST_TRIGGER_SET = new Set<string>(REQUEST_TRIGGERS);
const DOWNLOAD_TRIGGER_SET = new Set<string>(DOWNLOAD_TRIGGERS);

/**
 * Editor values for a connection or template. Rows saved before quiet hours existed carry no
 * `respectQuietHours`; they read as on, the server default.
 */
export function notificationFormBase(source: Record<string, unknown>): FormValues {
  return { ...source, respectQuietHours: typeof source.respectQuietHours === 'boolean' ? source.respectQuietHours : true };
}

function toBody(values: FormValues, schema: NotificationSchema | undefined): NotificationInput {
  const { id: _id, ...rest } = fromNotificationForm(values, schema?.fields ?? []);
  return rest as NotificationInput;
}

type Editing = { notification: Notification; schema: NotificationSchema | undefined } | { schema: NotificationSchema };

function NotificationEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const existing = 'notification' in editing ? editing.notification : null;
  const fields = useMemo<FieldDefinition[]>(() => {
    const defs = notificationFormFields(editing.schema?.fields ?? []);
    return defs.some((f) => f.name === 'name') ? defs : [NAME_FIELD, ...defs];
  }, [editing.schema]);
  const base = toNotificationForm(
    notificationFormBase(existing ?? { ...editing.schema!.template, name: editing.schema!.template.name || editing.schema!.implementationName }),
    editing.schema?.fields ?? [],
  );
  const form = useSchemaForm(fields, base);
  const save = useSaveNotification();
  const remove = useDeleteNotification();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Flags come from the template (complete list) merged with whatever the row carries.
  const template = (editing.schema?.template ?? {}) as Record<string, unknown>;
  const flags = [...new Set([...eventFlags(template), ...eventFlags(form.values)])].filter((f) => !REQUEST_TRIGGER_SET.has(f) && !DOWNLOAD_TRIGGER_SET.has(f)).sort();
  const requestFlags = supportedRequestTriggers({ ...template, ...(existing ?? {}), ...form.values });
  const downloadFlags = supportedDownloadTriggers({ ...template, ...(existing ?? {}), ...form.values });
  const tags = Array.isArray(form.values.tags) ? (form.values.tags as number[]) : [];

  const submit = () => {
    if (!form.validate()) return;
    save.mutate({ id: existing?.id, body: toBody(form.values, editing.schema) }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={existing ? t('settings.notifications.editName', { name: existing.name }) : t('settings.notifications.addValue', { value: editing.schema?.implementationName ?? 'connection' })}
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
                  notificationTestOutcome(await notificationsApi.test({ ...toBody(form.values, editing.schema), ...(existing ? { id: existing.id } : {}) }))
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
              <legend className="al-label">{t('settings.notifications.notifyOn')}</legend>
              <div className="al-check-grid" role="group" aria-label={t('settings.notifications.events')}>
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
          {requestFlags.length ? (
            <fieldset className="al-event-flags">
              <legend className="al-label">{t('settings.notifications.requestsAndIssues')}</legend>
              <div className="al-check-grid" role="group" aria-label={t('settings.notifications.requestAndIssueEvents')}>
                {requestFlags.map((flag) => (
                  <Checkbox
                    key={flag}
                    label={requestTriggerLabel(flag)}
                    checked={form.values[flag] === true}
                    onChange={(e) => form.setValues({ ...form.values, [flag]: e.currentTarget.checked })}
                  />
                ))}
              </div>
              <p className="al-caption" style={{ margin: '8px 0 0' }}>
                {t('settings.notifications.sitewideEveryUsersRequestsAnd')}
              </p>
            </fieldset>
          ) : null}
          {downloadFlags.length ? (
            <fieldset className="al-event-flags">
              <legend className="al-label">{t('settings.notifications.downloadProblems')}</legend>
              <div className="al-check-grid" role="group" aria-label={t('settings.notifications.downloadProblemEvents')}>
                {downloadFlags.map((flag) => (
                  <Checkbox
                    key={flag}
                    label={downloadTriggerLabel(flag)}
                    checked={form.values[flag] === true}
                    onChange={(e) => form.setValues({ ...form.values, [flag]: e.currentTarget.checked })}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="al-event-flags">
            <legend className="al-label">{t('settings.notifications.delivery')}</legend>
            <Checkbox
              label={t('settings.notifications.respectQuietHours')}
              hint={t('settings.notifications.respectQuietHoursHint')}
              checked={form.values.respectQuietHours !== false}
              onChange={(e) => form.setValues({ ...form.values, respectQuietHours: e.currentTarget.checked })}
            />
          </fieldset>
          {fields.some((f) => f.name === 'tags') ? null : (
            <Field label={t('common.tags')} hint={t('settings.notifications.onlyNotifyForItemsWith')}>
              <TagPicker value={tags} onChange={(next) => form.setValues({ ...form.values, tags: next })} />
            </Field>
          )}
          <SaveError error={save.error} />
        </div>
      </Modal>
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.notifications.deleteName', { name: existing.name })}
          confirmLabel={t('settings.notifications.deleteNotification')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          {t('settings.notifications.arclightStopsSendingEventsTo')}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function NotificationCard({
  notification: n,
  schema,
  onEdit,
  select,
}: {
  notification: Notification;
  schema: NotificationSchema | undefined;
  onEdit: () => void;
  select?: ItemCardSelect | undefined;
}) {
  const on = eventFlags(n).filter((f) => n[f] === true);
  return (
    <ItemCard
      title={n.name}
      onClick={onEdit}
      select={select}
      muted={!n.enabled}
      status={!n.enabled ? <Chip tone="muted">{t('common.disabled')}</Chip> : on.length ? null : <Chip tone="warn">{t('settings.notifications.noEvents')}</Chip>}
      actions={
        <>
          <TestButton
            size="sm"
            onTest={async () => {
              const { id, ...rest } = n;
              return notificationTestOutcome(await notificationsApi.test({ ...rest, id }));
            }}
          />
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={t('settings.notifications.editName', { name: n.name })}>
            {t('common.edit')}
          </Button>
        </>
      }
    >
      <span className="al-card-line">{schema?.implementationName ?? n.implementation}</span>
      {on.map((f) => (
        <Tag key={f}>{flagTag(f)}</Tag>
      ))}
    </ItemCard>
  );
}

export function NotificationsPage() {
  const list = useNotificationList();
  const schemas = useNotificationSchema();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const bulk = useResourceBulk('notification', list.data, (n) => n.id, (n) => n.name);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  return (
    <SettingsPage
      title={t('common.notifications')}
      description={t('settings.notifications.connectionsTellOtherAppsAnd')}
      actions={
        <Button variant="primary" onClick={() => setPicking(true)}>
          {t('settings.notifications.addConnection')}
        </Button>
      }
    >
      <SettingsSection label={t('settings.notifications.connections')} {...(list.data ? { count: list.data.length } : {})}>
        {list.isPending ? (
          <Skeleton lines={3} />
        ) : pending ? (
          <PendingApiNotice what={t('settings.notifications.notifications')} />
        ) : list.isError ? (
          <ErrorBlock title={t('settings.notifications.couldNotLoadNotifications')} onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <>
            <CardGrid label={t('settings.notifications.connections')}>
              {list.data.map((n) => {
                const schema = schemas.data?.find((s) => s.implementation === n.implementation);
                return <NotificationCard key={n.id} notification={n} schema={schema} onEdit={() => setEditing({ notification: n, schema })} select={bulk.cardProps(n)} />;
              })}
              <AddCard label={t('settings.notifications.addNotification')} onClick={() => setPicking(true)} />
            </CardGrid>
            {bulk.bar}
          </>
        )}
      </SettingsSection>
      <AlertSettingsSection />
      {picking ? (
        <Modal open size={640} onClose={() => setPicking(false)} title={t('settings.notifications.addConnection')}>
          {schemas.isPending ? (
            <Skeleton lines={4} />
          ) : schemas.isError ? (
            schemas.error instanceof ApiError && schemas.error.status === 404 ? (
              <PendingApiNotice what={t('settings.notifications.notifications')} />
            ) : (
              <ErrorBlock title={t('settings.notifications.couldNotLoadConnectionTypes')}>{errorMessage(schemas.error)}</ErrorBlock>
            )
          ) : (
            <div className="al-chooser" role="list" aria-label={t('settings.notifications.connectionTypes')}>
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
