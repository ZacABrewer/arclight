import { z } from 'zod';
import { QuietHoursSettings } from './alerts.js';

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
  'slack',
  'teams',
  'matrix',
  'mattermost',
  'rocketchat',
  'googlechat',
  'signal',
  'pushbullet',
  'prowl',
  'bark',
  'join',
  'simplepush',
  'homeassistant',
  'mqtt',
  'twilio',
  'apprise',
  'notifiarr',
  'lunasea',
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
  // Requests and issues (sitewide: admins hear about every user's activity here).
  'onRequestCreated',
  'onRequestApproved',
  'onRequestDeclined',
  'onRequestAvailable',
  'onIssueCreated',
  'onIssueUpdated',
  // Download problems (download timeline, VPN kill switch, disk space health checks).
  'onDownloadStalled',
  'onDownloadRejected',
  'onKillSwitch',
  'onKillSwitchResumed',
  'onImportProblem',
  'onDiskSpaceLow',
  // Any other timeline entry worth hearing about (recovered, replaced release, ...).
  'onDownloadRecovered',
  'onDailySummary',
  // Podcasts: new episodes in a feed, and an episode downloaded.
  'onPodcastEpisodes',
  'onPodcastDownload',
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

// ---- per-destination delivery options --------------------------------------------------

/** Media kinds a destination can be limited to. */
export const NotificationMediaType = z.enum(['series', 'movie', 'music', 'audiobook']);
export type NotificationMediaType = z.infer<typeof NotificationMediaType>;

/**
 * Extra filters on top of the event flags. Every list empty means no filter. Events that are
 * not about media (health, kill switch...) always pass the media and quality filters, and
 * events without a user always pass the user filter.
 */
export const NotificationFilters = z.object({
  /** Only these media kinds. */
  mediaTypes: z.array(NotificationMediaType).default([]),
  /** Only events whose release or file is in one of these qualities (e.g. "WEBDL-1080p"). */
  qualities: z.array(z.string().min(1).max(64)).max(100).default([]),
  /** Only request and issue events by one of these user ids (requester / reporter). */
  users: z.array(z.number().int().positive()).max(500).default([]),
});
export type NotificationFilters = z.infer<typeof NotificationFilters>;

export const NotificationMessageTemplate = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(4000).optional(),
});
export type NotificationMessageTemplate = z.infer<typeof NotificationMessageTemplate>;

/** Keyed by event type (`grab`, `requestApproved`, ...) or `default`. Validated by the api. */
export const NotificationTemplates = z.record(z.string().min(1).max(64), NotificationMessageTemplate);
export type NotificationTemplates = z.infer<typeof NotificationTemplates>;

/** Delivery health of one destination (from its delivery log). */
export const NotificationDeliveryStatus = z.object({
  consecutiveFailures: z.number().int(),
  lastError: z.string().optional(),
  lastFailureAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
});
export type NotificationDeliveryStatus = z.infer<typeof NotificationDeliveryStatus>;

export const NOTIFICATION_MAX_RATE_PER_MINUTE = 600;
export const NOTIFICATION_MAX_ATTEMPTS = 6;

const deliveryOptionsShape = {
  filters: NotificationFilters,
  templates: NotificationTemplates,
  /** Own quiet hours; null follows the global quiet hours (Settings > Notifications). */
  quietHours: QuietHoursSettings.nullable(),
  /** At most this many messages a minute (0: no limit). Extra alerts wait and go out as one batch. */
  rateLimitPerMinute: z.number().int().min(0).max(NOTIFICATION_MAX_RATE_PER_MINUTE),
  /** Attempts per message including the first; retries back off (network errors, 429, 5xx). */
  maxAttempts: z.number().int().min(1).max(NOTIFICATION_MAX_ATTEMPTS),
};

const deliveryOptionsInputShape = {
  filters: NotificationFilters.default(NotificationFilters.parse({})),
  templates: NotificationTemplates.default({}),
  quietHours: QuietHoursSettings.nullable().default(null),
  rateLimitPerMinute: z.number().int().min(0).max(NOTIFICATION_MAX_RATE_PER_MINUTE).default(0),
  maxAttempts: z.number().int().min(1).max(NOTIFICATION_MAX_ATTEMPTS).default(3),
};

export const NotificationConnection = z.object({
  id: z.number().int(),
  name: z.string(),
  implementation: NotificationImplementation,
  enabled: z.boolean(),
  ...triggerShape,
  /** Send health Warnings too (Errors are always sent when onHealthIssue is on). */
  includeHealthWarnings: z.boolean(),
  /** Hold non-urgent alerts during quiet hours and send them as one batch afterwards. */
  respectQuietHours: z.boolean(),
  /** Tag ids. Empty: all media. Otherwise only media sharing a tag (non-media events always pass). */
  tags: z.array(z.number().int()),
  settings: NotificationSettingsJson,
  ...deliveryOptionsShape,
  status: NotificationDeliveryStatus,
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
  respectQuietHours: z.boolean().default(true),
  tags: z.array(z.number().int()).default([]),
  settings: NotificationSettingsJson.default({}),
  ...deliveryOptionsInputShape,
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
  /** Multi-line text (templates). */
  'textarea',
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

// ---- delivery log ------------------------------------------------------------------------

export const NotificationDeliveryState = z.enum(['sent', 'failed', 'held', 'rateLimited', 'skipped']);
export type NotificationDeliveryState = z.infer<typeof NotificationDeliveryState>;

/** One attempt to deliver one event to one destination (GET /notification/:id/deliveries). */
export const NotificationDelivery = z.object({
  id: z.number().int(),
  eventType: z.string(),
  /** Headline of the message. */
  title: z.string(),
  state: NotificationDeliveryState,
  attempts: z.number().int(),
  /** Secrets are redacted. */
  error: z.string().optional(),
  code: z.string().optional(),
  test: z.boolean(),
  /** ISO-8601 */
  at: z.string(),
});
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

// ---- templates ----------------------------------------------------------------------------

/** GET /notification/templates: what the template editor offers. */
export const NotificationTemplateMeta = z.object({
  /** `default` first, then every event type. */
  keys: z.array(z.string()),
  variables: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type NotificationTemplateMeta = z.infer<typeof NotificationTemplateMeta>;

/** POST /notification/preview: render a template against a sample event. */
export const NotificationPreviewRequest = z.object({
  /** Event type, or `default` (previewed with a sample import). */
  eventType: z.string().min(1).max(64),
  template: NotificationMessageTemplate.default({}),
});
export type NotificationPreviewRequest = z.input<typeof NotificationPreviewRequest>;

export const NotificationPreview = z.object({
  subject: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().optional(),
  posterUrl: z.string().optional(),
  /** Template syntax problem, when there is one (the defaults are shown instead). */
  error: z.string().optional(),
  /** Every simple variable with its value for the sample event. */
  values: z.record(z.string(), z.string()),
});
export type NotificationPreview = z.infer<typeof NotificationPreview>;

// ---- personal destinations ------------------------------------------------------------------

/**
 * Services a user may add for themselves. No scripts, SMTP relays, MQTT brokers or media
 * servers: those run on, or reach into, the server owner's own setup.
 */
export const PersonalNotificationImplementation = z.enum([
  'discord',
  'telegram',
  'ntfy',
  'gotify',
  'pushover',
  'slack',
  'teams',
  'matrix',
  'mattermost',
  'rocketchat',
  'googlechat',
  'signal',
  'pushbullet',
  'prowl',
  'bark',
  'join',
  'simplepush',
  'homeassistant',
  'twilio',
  'apprise',
  'lunasea',
  'webhook',
]);
export type PersonalNotificationImplementation = z.infer<typeof PersonalNotificationImplementation>;

/** The events a user can get about their own activity. */
export const PERSONAL_NOTIFICATION_EVENTS = [
  'requestApproved',
  'requestAvailable',
  'requestDeclined',
  'issueUpdated',
  /** New episodes and movies of titles on the user's watchlist or that they requested. */
  'watchlistAvailable',
  /** Managers only: someone requested something. */
  'requestPending',
  /** Managers only: someone reported an issue. */
  'issueCreated',
] as const;
export const PersonalNotificationEvent = z.enum(PERSONAL_NOTIFICATION_EVENTS);
export type PersonalNotificationEvent = z.infer<typeof PersonalNotificationEvent>;
/** Events only users who manage requests / issues can pick. */
export const MANAGER_PERSONAL_EVENTS: readonly PersonalNotificationEvent[] = ['requestPending', 'issueCreated'];

export const DEFAULT_PERSONAL_EVENTS: PersonalNotificationEvent[] = ['requestApproved', 'requestAvailable', 'requestDeclined', 'issueUpdated', 'watchlistAvailable'];

export const PersonalDestination = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  name: z.string(),
  implementation: PersonalNotificationImplementation,
  enabled: z.boolean(),
  events: z.array(PersonalNotificationEvent),
  /** Secrets masked. */
  settings: NotificationSettingsJson,
  templates: NotificationTemplates,
  quietHours: QuietHoursSettings.nullable(),
  status: NotificationDeliveryStatus,
  addedAt: z.string(),
  updatedAt: z.string(),
});
export type PersonalDestination = z.infer<typeof PersonalDestination>;

/** POST /me/notification-destination, PUT /me/notification-destination/:id. */
export const PersonalDestinationInput = z.object({
  name: z.string().trim().min(1).max(100),
  implementation: PersonalNotificationImplementation,
  enabled: z.boolean().default(true),
  events: z.array(PersonalNotificationEvent).default(DEFAULT_PERSONAL_EVENTS),
  settings: NotificationSettingsJson.default({}),
  templates: NotificationTemplates.default({}),
  quietHours: QuietHoursSettings.nullable().default(null),
});
export type PersonalDestinationInput = z.infer<typeof PersonalDestinationInput>;
export type PersonalDestinationInputRaw = z.input<typeof PersonalDestinationInput>;

/** POST /me/notification-destination/test: unsaved candidate, or a saved one (`id`) with edits. */
export const PersonalDestinationTestRequest = PersonalDestinationInput.extend({ id: z.number().int().positive().optional() });
export type PersonalDestinationTestRequest = z.infer<typeof PersonalDestinationTestRequest>;

/** GET /me/notification-destination/options: which kinds and events this user may use. */
export const PersonalDestinationOptions = z.object({
  /** False when the admin switched personal destinations off. */
  enabled: z.boolean(),
  implementations: z.array(PersonalNotificationImplementation),
  events: z.array(PersonalNotificationEvent),
});
export type PersonalDestinationOptions = z.infer<typeof PersonalDestinationOptions>;
