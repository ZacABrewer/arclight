import { z } from 'zod';
import {
  NotificationDelivery,
  NotificationField,
  NotificationPreview,
  NotificationTemplateMeta,
  PersonalDestination,
  PersonalDestinationOptions,
  type NotificationPreviewRequest,
  type PersonalDestinationInputRaw,
} from '@arclight/shared';
import { request } from './client.js';
import type { FieldDefinition, FieldType, FormValues } from '../components/forms/types.js';
import { t } from '../i18n/index.js';

// Connection rows and schema templates stay loose so a save never drops server fields; the
// field definitions are the shared `NotificationField`. Its names are keys of `settings` and its
// list/map types have no form widget of their own, so the editor works on a form-shaped copy:
// see notificationFormFields / toNotificationForm / fromNotificationForm below.

export { NotificationField };
export type { NotificationDelivery, NotificationPreview, NotificationTemplateMeta, PersonalDestination };

export const Notification = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  implementation: z.string(),
  tags: z.array(z.number().int()).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type Notification = z.infer<typeof Notification>;

/** A create/update body: everything but the id. Event flags are the `on*` booleans. */
export type NotificationInput = Omit<Notification, 'id'>;

export const NotificationSchema = z.looseObject({
  implementation: z.string(),
  implementationName: z.string(),
  description: z.string().optional(),
  infoLink: z.string().optional(),
  fields: z.array(NotificationField),
  template: z.looseObject({
    name: z.string().default(''),
    implementation: z.string(),
    tags: z.array(z.number().int()).default([]),
    settings: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type NotificationSchema = z.infer<typeof NotificationSchema>;

export const NotificationTestResult = z.looseObject({
  ok: z.boolean(),
  /** The api's failure text (`{ok, message, code}`). */
  message: z.string().optional(),
  code: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
});
export type NotificationTestResult = z.infer<typeof NotificationTestResult>;

/** Event flags present on a notification or template, in a stable order. */
export function eventFlags(source: Record<string, unknown>): string[] {
  return Object.keys(source)
    .filter((k) => /^on[A-Z]/.test(k) && typeof source[k] === 'boolean')
    .sort();
}

/** `onHealthIssue` -> `Health Issue`. */
export function eventFlagLabel(flag: string): string {
  return flag.replace(/^on/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export const notificationsApi = {
  list: () => request('/notification', Notification.array()),
  schema: () => request('/notification/schema', NotificationSchema.array()),
  create: (body: NotificationInput) => request('/notification', Notification, { method: 'POST', json: body }),
  update: (id: number, body: NotificationInput) =>
    request(`/notification/${id}`, Notification, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/notification/${id}`, null, { method: 'DELETE' }),
  test: (body: NotificationInput & { id?: number }) =>
    request('/notification/test', NotificationTestResult, { method: 'POST', json: body }),
  /** Recent delivery attempts of one connection, newest first. */
  deliveries: (id: number) => request(`/notification/${id}/deliveries`, NotificationDelivery.array()),
  /** Template keys (`default` + event types) and the variables templates may use. */
  templateMeta: () => request('/notification/templates', NotificationTemplateMeta),
  /** Render a template against a sample event. */
  preview: (body: NotificationPreviewRequest) => request('/notification/preview', NotificationPreview, { method: 'POST', json: body }),
};

// ---- personal destinations (a user's own notification services) ----------------------------

/** GET /user/:id/notification-destination/options: allowed kinds and events plus their form schemas. */
export const PersonalDestinationOptionsResponse = PersonalDestinationOptions.extend({ schemas: z.array(NotificationSchema).default([]) });
export type PersonalDestinationOptionsResponse = z.infer<typeof PersonalDestinationOptionsResponse>;

export type PersonalDestinationBody = PersonalDestinationInputRaw;

export const personalDestinationsApi = {
  options: (userId: number) => request(`/user/${userId}/notification-destination/options`, PersonalDestinationOptionsResponse),
  list: (userId: number) => request(`/user/${userId}/notification-destination`, PersonalDestination.array()),
  create: (userId: number, body: PersonalDestinationBody) =>
    request(`/user/${userId}/notification-destination`, PersonalDestination, { method: 'POST', json: body }),
  update: (userId: number, id: number, body: PersonalDestinationBody) =>
    request(`/user/${userId}/notification-destination/${id}`, PersonalDestination, { method: 'PUT', json: body }),
  remove: (userId: number, id: number) => request(`/user/${userId}/notification-destination/${id}`, null, { method: 'DELETE' }),
  test: (userId: number, body: PersonalDestinationBody & { id?: number }) =>
    request(`/user/${userId}/notification-destination/test`, NotificationTestResult, { method: 'POST', json: body }),
  deliveries: (userId: number, id: number) =>
    request(`/user/${userId}/notification-destination/${id}/deliveries`, NotificationDelivery.array()),
};

// ---- form mapping -------------------------------------------------------------------------

const FORM_TYPE: Record<NotificationField['type'], FieldType> = {
  text: 'text',
  url: 'text',
  email: 'text',
  textarea: 'textarea',
  password: 'password',
  number: 'number',
  boolean: 'checkbox',
  select: 'select',
  multiSelect: 'multiSelect',
  // One entry per line ("key=value" for maps).
  textList: 'textarea',
  emailList: 'textarea',
  keyValue: 'textarea',
};

const LIST_TYPES = new Set<NotificationField['type']>(['textList', 'emailList', 'keyValue']);

/** Schema fields as form fields bound to `settings.<name>`. */
export function notificationFormFields(fields: readonly NotificationField[]): FieldDefinition[] {
  return fields.map((f) => ({
    name: `settings.${f.name}`,
    label: f.label,
    type: FORM_TYPE[f.type],
    // Stored secret entries come back masked one per line; leaving a masked line keeps it.
    helpText: f.secret && LIST_TYPES.has(f.type) ? [f.helpText, t('notify.form.secretListHint')].filter(Boolean).join(' ') : f.helpText,
    required: f.required,
    default: toFormValue(f.type, f.default),
    options: f.options,
    min: f.min,
    max: f.max,
  }));
}

function toFormValue(type: NotificationField['type'], value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if ((type === 'textList' || type === 'emailList') && Array.isArray(value)) return value.join('\n');
  if (type === 'keyValue' && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('\n');
  }
  return value;
}

function fromFormValue(type: NotificationField['type'], value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (type === 'textList' || type === 'emailList') return lines;
  if (type === 'keyValue') {
    return Object.fromEntries(
      lines.map((l) => {
        const eq = l.indexOf('=');
        return eq === -1 ? [l, ''] : [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
      }),
    );
  }
  return value;
}

function mapSettings(values: FormValues, fields: readonly NotificationField[], map: (type: NotificationField['type'], v: unknown) => unknown): FormValues {
  const settings = { ...((values.settings as Record<string, unknown> | undefined) ?? {}) };
  for (const f of fields) if (f.name in settings) settings[f.name] = map(f.type, settings[f.name]);
  return { ...values, settings };
}

/** A connection or template as editor values (lists and maps as text). */
export function toNotificationForm(values: FormValues, fields: readonly NotificationField[]): FormValues {
  return mapSettings(values, fields, toFormValue);
}

/** Editor values back to the api shape. */
export function fromNotificationForm(values: FormValues, fields: readonly NotificationField[]): FormValues {
  return mapSettings(values, fields, fromFormValue);
}
