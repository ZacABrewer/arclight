import { z } from 'zod';
import { request } from './client.js';

// TODO(contract): packages/shared/src/notifications.ts is still empty and the /notification
// routes are being built in parallel. These loose schemas follow the brief (connection list,
// schema templates with field definitions shaped like the download-client ones, `on*` event
// flags, tags, test). Swap in the shared exports when they land.

export const NotificationField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'password', 'checkbox', 'select']),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  advanced: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type NotificationField = z.infer<typeof NotificationField>;

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
};
