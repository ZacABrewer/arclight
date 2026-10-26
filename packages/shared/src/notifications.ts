import { z } from 'zod';

// Notification connections contract. A connection is one configured agent (Discord, ntfy,
// Plex...) plus the events it wants. Per-kind settings are validated by the agent package's
// Zod schemas; on the wire they are an opaque JSON object whose secrets are masked.

/** Placeholder returned in place of a stored secret. Sending it back keeps the stored value. */
export const NOTIFICATION_SECRET_MASK = '********';

/**
 * Agent kinds. Mirrors `NOTIFICATION_AGENT_KINDS` in `@arclight/notifications` (which
 * depends on this package, so it cannot be imported here); the api asserts both stay equal.
 */
export const NotificationImplementation = z.enum([
  'discord',
  'telegram',
  'webhook',
  'email',
  'custom-script',
  'ntfy',
  'gotify',
  'pushover',
  'jellyfin',
  'emby',
  'plex',
]);
export type NotificationImplementation = z.infer<typeof NotificationImplementation>;

/** The "On ..." trigger flags a user can switch per connection. */
export const NOTIFICATION_TRIGGERS = [
  'onGrab',
  'onDownload',
  'onUpgrade',
  'onRename',
  'onSeriesAdd',
  'onMovieAdd',
  'onSeriesDelete',
  'onMovieDelete',
  'onFileDelete',
  'onHealthIssue',
  'onHealthRestored',
  'onApplicationUpdate',
  'onManualInteractionRequired',
] as const;
export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number];

/** `supportsOnGrab` etc.: whether the agent can do anything with that trigger's event. */
export type NotificationSupportFlag = `supports${Capitalize<NotificationTrigger>}`;

export function supportFlagFor(trigger: NotificationTrigger): NotificationSupportFlag {
  return `supports${trigger.charAt(0).toUpperCase()}${trigger.slice(1)}` as NotificationSupportFlag;
}

const triggerShape = Object.fromEntries(NOTIFICATION_TRIGGERS.map((t) => [t, z.boolean()])) as {
  [K in NotificationTrigger]: z.ZodBoolean;
};
const triggerInputShape = Object.fromEntries(NOTIFICATION_TRIGGERS.map((t) => [t, z.boolean().default(false)])) as {
  [K in NotificationTrigger]: z.ZodDefault<z.ZodBoolean>;
};
const supportShape = Object.fromEntries(NOTIFICATION_TRIGGERS.map((t) => [supportFlagFor(t), z.boolean()])) as {
  [K in NotificationSupportFlag]: z.ZodBoolean;
};

export const NotificationCapabilities = z.object(supportShape);
export type NotificationCapabilities = z.infer<typeof NotificationCapabilities>;

/** Per-kind settings as JSON. Secret values are NOTIFICATION_SECRET_MASK on read. */
export const NotificationSettingsJson = z.record(z.string(), z.unknown());
export type NotificationSettingsJson = z.infer<typeof NotificationSettingsJson>;

export const NotificationConnection = z.object({
  id: z.number().int(),
  name: z.string(),
  implementation: NotificationImplementation,
  enabled: z.boolean(),
  ...triggerShape,
  /** Send health Warnings too (Errors are always sent when onHealthIssue is on). */
  includeHealthWarnings: z.boolean(),
  /** Tag ids. Empty: all media. Otherwise only media sharing a tag (non-media events always pass). */
  tags: z.array(z.number().int()),
  settings: NotificationSettingsJson,
  ...supportShape,
});
export type NotificationConnection = z.infer<typeof NotificationConnection>;

/** POST /notification and PUT /notification/:id body. */
export const NotificationInput = z.object({
  name: z.string().trim().min(1).max(100),
  implementation: NotificationImplementation,
  enabled: z.boolean().default(true),
  ...triggerInputShape,
  includeHealthWarnings: z.boolean().default(false),
  tags: z.array(z.number().int()).default([]),
  settings: NotificationSettingsJson.default({}),
});
export type NotificationInput = z.infer<typeof NotificationInput>;
export type NotificationInputRaw = z.input<typeof NotificationInput>;

/** POST /notification/test: an unsaved candidate, or a saved one (`id`) with edits. */
export const NotificationTestRequest = NotificationInput.extend({
  id: z.number().int().positive().optional(),
});
export type NotificationTestRequest = z.infer<typeof NotificationTestRequest>;

export const NotificationTestResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** Error code from the agent package (`network`, `unauthorized`, ...). */
  code: z.string().optional(),
});
export type NotificationTestResult = z.infer<typeof NotificationTestResult>;

export const NotificationTestAllResult = z.array(
  NotificationTestResult.extend({ id: z.number().int(), name: z.string() }),
);
export type NotificationTestAllResult = z.infer<typeof NotificationTestAllResult>;

// ---- schema (form definitions) --------------------------------------------------------

export const NotificationFieldType = z.enum([
  'text',
  'password',
  'url',
  'email',
  'number',
  'boolean',
  'select',
  'multiSelect',
  'textList',
  'emailList',
  'keyValue',
]);
export type NotificationFieldType = z.infer<typeof NotificationFieldType>;

export const NotificationField = z.object({
  name: z.string(),
  label: z.string(),
  type: NotificationFieldType,
  /** The `.describe()` text of the settings schema. */
  helpText: z.string().optional(),
  required: z.boolean(),
  /** Masked on read; send NOTIFICATION_SECRET_MASK back to keep the stored value. */
  secret: z.boolean(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type NotificationField = z.infer<typeof NotificationField>;

export const NotificationSchema = z.object({
  implementation: NotificationImplementation,
  implementationName: z.string(),
  fields: z.array(NotificationField),
  /** A ready-to-fill create body with defaults (name left blank for the user). */
  template: NotificationInput.extend({ name: z.string() }),
  ...supportShape,
});
export type NotificationSchema = z.infer<typeof NotificationSchema>;

export const NotificationsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type NotificationsErrorResponse = z.infer<typeof NotificationsErrorResponse>;
