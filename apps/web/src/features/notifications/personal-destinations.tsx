import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_PERSONAL_EVENTS,
  type NotificationTemplates,
  type PersonalDestination,
  type PersonalNotificationEvent,
  type PersonalNotificationImplementation,
  type QuietHoursSettings,
} from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import {
  fromNotificationForm,
  notificationFormFields,
  personalDestinationsApi,
  toNotificationForm,
  type NotificationSchema,
  type PersonalDestinationBody,
} from '../../api/notifications.js';
import { Banner, Button, Checkbox, Chip, ErrorBlock, Field, Modal, Select, Skeleton, Table, Tabs, Toggle, type Column } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { SchemaForm, useSchemaForm } from '../../components/forms/schema-form.js';
import { TestButton } from '../../components/forms/test-result.js';
import type { FieldDefinition, FormValues } from '../../components/forms/types.js';
import {
  useDeletePersonalDestination,
  usePersonalDestinationDeliveries,
  usePersonalDestinationOptions,
  usePersonalDestinations,
  useSavePersonalDestination,
} from '../../hooks/notifications.js';
import { isLocalTime } from '../../pages/settings/notifications/alert-settings-section.js';
import { EditorFooter } from '../../pages/settings/shared.js';
import { t } from '../../i18n/index.js';
import { DeliveryLog, DeliveryStatusLine } from './delivery-log.js';
import { notificationTestOutcome, personalEventHint, personalEventLabel } from './labels.js';
import { QuietHoursOverride } from './quiet-hours-override.js';
import { TemplateEditor } from './template-editor.js';
import './notifications.css';

// A user's own notification destinations (their Discord, ntfy topic, phone number...): they
// hear about their own requests, issues and watchlist. Mounted on the profile page (which the
// request portal's account page reuses) and in the admin user editor.

const NAME_FIELD: FieldDefinition = {
  name: 'name',
  get label() {
    return t('common.name');
  },
  type: 'text',
  required: true,
};

/** The PUT/POST body of a saved destination (settings stay masked; the api keeps those). */
export function destinationBody(d: PersonalDestination): PersonalDestinationBody {
  return { name: d.name, implementation: d.implementation, enabled: d.enabled, events: d.events, settings: d.settings, templates: d.templates, quietHours: d.quietHours };
}

/** Events a new destination starts with: the defaults this user may pick. */
export function defaultEvents(allowed: readonly PersonalNotificationEvent[]): PersonalNotificationEvent[] {
  return allowed.filter((e) => DEFAULT_PERSONAL_EVENTS.includes(e));
}

type Editing = { destination: PersonalDestination } | { implementation: PersonalNotificationImplementation | null };

interface FormProps {
  userId: number;
  schema: NotificationSchema | undefined;
  implementation: PersonalNotificationImplementation;
  existing: PersonalDestination | null;
  allowedEvents: readonly PersonalNotificationEvent[];
  /** Choosing the service; only for a new destination. */
  picker: ReactNode;
  onClose: () => void;
  onDelete: (() => void) | undefined;
}

function DestinationForm({ userId, schema, implementation, existing, allowedEvents, picker, onClose, onDelete }: FormProps) {
  const schemaFields = useMemo(() => schema?.fields ?? [], [schema]);
  const fields = useMemo<FieldDefinition[]>(() => [NAME_FIELD, ...notificationFormFields(schemaFields)], [schemaFields]);
  const base = toNotificationForm(
    existing ? { name: existing.name, settings: existing.settings } : { name: schema?.implementationName ?? implementation, settings: schema?.template.settings ?? {} },
    schemaFields,
  );
  const form = useSchemaForm(fields, base);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [events, setEvents] = useState<PersonalNotificationEvent[]>(existing ? existing.events : defaultEvents(allowedEvents));
  const [templates, setTemplates] = useState<NotificationTemplates>(existing?.templates ?? {});
  const [quietHours, setQuietHours] = useState<QuietHoursSettings | null>(existing?.quietHours ?? null);
  const [tab, setTab] = useState('general');
  const save = useSavePersonalDestination(userId);
  const deliveries = usePersonalDestinationDeliveries(userId, existing?.id ?? null);
  const quietInvalid = quietHours !== null && (!isLocalTime(quietHours.start) || !isLocalTime(quietHours.end));

  const body = (): PersonalDestinationBody => {
    const values = fromNotificationForm(form.values as FormValues, schemaFields);
    return {
      name: String(values.name ?? '').trim(),
      implementation,
      enabled,
      events,
      settings: (values.settings as Record<string, unknown> | undefined) ?? {},
      templates,
      quietHours,
    };
  };
  const check = () => {
    if (!form.validate()) {
      setTab('general');
      return false;
    }
    if (quietInvalid) {
      setTab('quiet');
      return false;
    }
    return true;
  };
  const submit = () => {
    if (!check()) return;
    save.mutate({ id: existing?.id, body: body() }, { onSuccess: onClose });
  };
  const toggleEvent = (event: PersonalNotificationEvent, on: boolean) =>
    setEvents((prev) => (on ? allowedEvents.filter((e) => e === event || prev.includes(e)) : prev.filter((e) => e !== event)));
  // Template keys the api knows for these events (personal-only events use the default).
  const templateKeys = useMemo(() => ['default', ...allowedEvents], [allowedEvents]);

  const general = (
    <div className="al-notify-section">
      {picker}
      <Toggle label={t('notify.personal.enabled')} checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      <SchemaForm fields={fields} values={form.values} errors={form.errors} onChange={form.setValues} />
      <fieldset className="al-event-flags">
        <legend className="al-label">{t('notify.personal.events')}</legend>
        <div className="al-check-grid">
          {allowedEvents.map((event) => (
            <Checkbox
              key={event}
              label={personalEventLabel(event)}
              hint={personalEventHint(event)}
              checked={events.includes(event)}
              onChange={(e) => toggleEvent(event, e.currentTarget.checked)}
            />
          ))}
        </div>
        {events.length === 0 ? <p className="al-caption">{t('notify.personal.noEventsHint')}</p> : null}
      </fieldset>
    </div>
  );

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={existing ? t('notify.personal.editName', { name: existing.name }) : t('notify.personal.add')}
      footer={
        <EditorFooter
          onCancel={onClose}
          onSave={submit}
          saving={save.isPending}
          onDelete={onDelete}
          extra={
            <TestButton
              label={t('notify.personal.sendTest')}
              beforeTest={check}
              onTest={async () => notificationTestOutcome(await personalDestinationsApi.test(userId, { ...body(), ...(existing ? { id: existing.id } : {}) }))}
            />
          }
        />
      }
    >
      <Tabs
        aria-label={t('notify.editor.sections')}
        value={tab}
        onChange={setTab}
        className="al-notification-tabs"
        tabs={[
          { id: 'general', label: t('notify.editor.general'), content: general },
          {
            id: 'quiet',
            label: t('settings.notifications.alerts.quietHours'),
            content: (
              <div className="al-notify-section">
                <QuietHoursOverride value={quietHours} onChange={setQuietHours} followLabel={t('notify.personal.quietFollow')} />
                {quietInvalid ? <p className="al-caption">{t('settings.notifications.alerts.useHhMm')}</p> : null}
              </div>
            ),
          },
          { id: 'templates', label: t('notify.editor.templates'), content: <TemplateEditor value={templates} onChange={setTemplates} keys={templateKeys} /> },
          ...(existing ? [{ id: 'log', label: t('notify.editor.log'), content: <DeliveryLog query={deliveries} status={existing.status} /> }] : []),
        ]}
      />
      {save.error ? (
        <Banner tone="danger" className="al-notify-save-error">
          {errorMessage(save.error)}
        </Banner>
      ) : null}
    </Modal>
  );
}

function DestinationEditor({
  userId,
  editing,
  implementations,
  schemas,
  allowedEvents,
  onClose,
}: {
  userId: number;
  editing: Editing;
  implementations: readonly PersonalNotificationImplementation[];
  schemas: readonly NotificationSchema[];
  allowedEvents: readonly PersonalNotificationEvent[];
  onClose: () => void;
}) {
  const id = useId();
  const existing = 'destination' in editing ? editing.destination : null;
  const [implementation, setImplementation] = useState<PersonalNotificationImplementation | null>(
    existing?.implementation ?? ('implementation' in editing ? editing.implementation : null) ?? implementations[0] ?? null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeletePersonalDestination(userId);
  const nameOf = (impl: string) => schemas.find((s) => s.implementation === impl)?.implementationName ?? impl;
  const picker = existing ? (
    <p className="al-caption">{t('notify.personal.serviceIs', { service: nameOf(existing.implementation) })}</p>
  ) : (
    <Field label={t('notify.personal.service')} htmlFor={`${id}-service`}>
      <Select
        id={`${id}-service`}
        className="al-select--fit"
        value={implementation ?? ''}
        onChange={(e) => setImplementation(e.currentTarget.value as PersonalNotificationImplementation)}
        options={implementations.map((impl) => ({ value: impl, label: nameOf(impl) }))}
      />
    </Field>
  );
  if (!implementation) return null;
  return (
    <>
      <DestinationForm
        key={implementation}
        userId={userId}
        schema={schemas.find((s) => s.implementation === implementation)}
        implementation={implementation}
        existing={existing}
        allowedEvents={allowedEvents}
        picker={picker}
        onClose={onClose}
        onDelete={existing ? () => setConfirmDelete(true) : undefined}
      />
      {existing ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('notify.personal.deleteName', { name: existing.name })}
          confirmLabel={t('notify.personal.delete')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(existing.id);
            onClose();
          }}
        >
          {t('notify.personal.deleteBody')}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** A user's own notification destinations: list, add / edit, send a test, delete, delivery log. */
export function PersonalDestinations({ userId }: { userId: number }) {
  const options = usePersonalDestinationOptions(userId);
  const list = usePersonalDestinations(userId);
  const [editing, setEditing] = useState<Editing | null>(null);

  if (options.isPending) return <Skeleton lines={3} />;
  if (options.isError) {
    if (options.error instanceof ApiError && options.error.status === 404) {
      return <p className="al-caption">{t('notify.personal.unavailable')}</p>;
    }
    return (
      <ErrorBlock title={t('notify.personal.couldNotLoad')} onRetry={() => void options.refetch()}>
        {errorMessage(options.error)}
      </ErrorBlock>
    );
  }
  const opts = options.data;
  const nameOf = (impl: string) => opts.schemas.find((s) => s.implementation === impl)?.implementationName ?? impl;
  const canAdd = opts.enabled && opts.implementations.length > 0;

  const columns: Array<Column<PersonalDestination>> = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (d) => (
        <span className="al-personal-dest__name">
          {d.name}
          <DeliveryStatusLine status={d.status} />
        </span>
      ),
      mobile: 'primary',
    },
    { key: 'kind', header: t('notify.personal.service'), cell: (d) => nameOf(d.implementation), muted: true },
    {
      key: 'events',
      header: t('notify.personal.events'),
      cell: (d) => (d.events.length ? d.events.map(personalEventLabel).join(', ') : <Chip tone="warn">{t('settings.notifications.noEvents')}</Chip>),
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (d) =>
        !d.enabled ? (
          <Chip tone="muted">{t('common.disabled')}</Chip>
        ) : d.status.consecutiveFailures > 0 ? (
          <Chip tone="danger">{t('notify.status.failing')}</Chip>
        ) : (
          <Chip tone="accent">{t('common.enabled')}</Chip>
        ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('notify.personal.actions')}</span>,
      label: t('notify.personal.actions'),
      mobile: 'end',
      align: 'right',
      cell: (d) => (
        <div className="mk-row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <TestButton
            size="sm"
            label={t('notify.personal.sendTest')}
            onTest={async () => notificationTestOutcome(await personalDestinationsApi.test(userId, { ...destinationBody(d), id: d.id }))}
          />
          {opts.enabled ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing({ destination: d })} aria-label={t('notify.personal.editName', { name: d.name })}>
              {t('common.edit')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="al-personal-dest">
      <p className="al-caption" style={{ margin: 0 }}>
        {t('notify.personal.intro')}
      </p>
      {!opts.enabled ? <Banner>{t('notify.personal.disabledNotice')}</Banner> : null}
      {list.isError ? (
        <ErrorBlock title={t('notify.personal.couldNotLoad')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : list.data && list.data.length === 0 && !opts.enabled ? null : (
        <Table
          caption={t('notify.personal.caption')}
          columns={columns}
          rows={list.data}
          loading={list.isPending}
          rowKey={(d) => d.id}
          empty={t('notify.personal.empty')}
        />
      )}
      {canAdd ? (
        <div>
          <Button variant="secondary" onClick={() => setEditing({ implementation: null })}>
            {t('notify.personal.add')}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <DestinationEditor
          key={'destination' in editing ? editing.destination.id : 'new'}
          userId={userId}
          editing={editing}
          implementations={opts.implementations}
          schemas={opts.schemas}
          allowedEvents={opts.events}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
