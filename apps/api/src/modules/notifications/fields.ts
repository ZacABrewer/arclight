import { z } from 'zod';
import {
  agentSettingsSchemas,
  createAgent,
  NOTIFICATION_AGENT_KINDS,
  ALL_EVENTS,
  LIBRARY_EVENTS,
  MESSAGE_EVENTS,
  type NotificationAgentKind,
  type NotificationEventType,
} from '@arclight/notifications';
import {
  NOTIFICATION_SECRET_MASK,
  NOTIFICATION_TRIGGERS,
  NotificationImplementation,
  supportFlagFor,
  type NotificationCapabilities,
  type NotificationField,
  type NotificationFieldType,
  type NotificationSchema,
  type NotificationTrigger,
} from '@arclight/shared';

// Everything derived from the agent package: field definitions for the settings form, which
// settings are secrets, and which triggers each agent can serve.

// The shared enum mirrors the package's list; fail typechecking if they ever drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsInSync: Same<NotificationAgentKind, NotificationImplementation> = true;
void kindsInSync;
if (NotificationImplementation.options.length !== NOTIFICATION_AGENT_KINDS.length) {
  throw new Error('NotificationImplementation is out of sync with NOTIFICATION_AGENT_KINDS');
}

/** Which agent event a trigger flag routes. */
export const TRIGGER_EVENT: Record<NotificationTrigger, NotificationEventType> = {
  onGrab: 'grab',
  onDownload: 'import',
  onUpgrade: 'upgrade',
  onRename: 'rename',
  onSeriesAdd: 'mediaAdded',
  onMovieAdd: 'mediaAdded',
  onSeriesDelete: 'mediaDeleted',
  onMovieDelete: 'mediaDeleted',
  onFileDelete: 'fileDeleted',
  onHealthIssue: 'healthIssue',
  onHealthRestored: 'healthRestored',
  onApplicationUpdate: 'applicationUpdate',
  onManualInteractionRequired: 'manualInteractionRequired',
  onRequestCreated: 'requestCreated',
  onRequestApproved: 'requestApproved',
  onRequestDeclined: 'requestDeclined',
  onRequestAvailable: 'requestAvailable',
  onIssueCreated: 'issueCreated',
  onIssueUpdated: 'issueUpdated',
  onDownloadStalled: 'downloadStalled',
  onKillSwitch: 'killSwitch',
  onKillSwitchResumed: 'killSwitchResumed',
  onImportProblem: 'importProblem',
  onDiskSpaceLow: 'diskSpaceLow',
  onDownloadRecovered: 'downloadUpdate',
  onDailySummary: 'dailySummary',
};

const IMPLEMENTATION_NAMES: Record<NotificationAgentKind, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  webhook: 'Webhook',
  email: 'Email',
  'custom-script': 'Custom Script',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  pushover: 'Pushover',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
  plex: 'Plex Media Server',
};

/** Settings keys whose value is a credential. Discord's webhook URL embeds its token. */
const SECRET_KEYS = new Set([
  'password',
  'botToken',
  'accessToken',
  'appToken',
  'apiToken',
  'apiKey',
  'authToken',
  'userKey',
  'webhookUrl',
]);
/** Record-valued settings whose every value is a credential (webhook headers). */
const SECRET_RECORD_KEYS = new Set(['headers']);

/** Fallback when stored settings no longer build an agent (e.g. hand-edited). */
const STATIC_SUPPORT: Record<NotificationAgentKind, ReadonlySet<NotificationEventType>> = {
  discord: MESSAGE_EVENTS,
  telegram: MESSAGE_EVENTS,
  webhook: ALL_EVENTS,
  email: MESSAGE_EVENTS,
  'custom-script': ALL_EVENTS,
  ntfy: MESSAGE_EVENTS,
  gotify: MESSAGE_EVENTS,
  pushover: MESSAGE_EVENTS,
  jellyfin: LIBRARY_EVENTS,
  emby: LIBRARY_EVENTS,
  plex: LIBRARY_EVENTS,
};

/** Events the agent for `kind` handles with these settings (Emby's `notify` widens it). */
export function supportedEventsFor(kind: NotificationAgentKind, settings: unknown): ReadonlySet<NotificationEventType> {
  try {
    return createAgent(kind, settings).supportedEvents;
  } catch {
    return STATIC_SUPPORT[kind];
  }
}

export function capabilitiesFrom(events: ReadonlySet<NotificationEventType>): NotificationCapabilities {
  return Object.fromEntries(
    NOTIFICATION_TRIGGERS.map((t) => [supportFlagFor(t), events.has(TRIGGER_EVENT[t])]),
  ) as NotificationCapabilities;
}

// ---- secrets ---------------------------------------------------------------------------

export function maskSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_KEYS.has(key) && typeof value === 'string' && value !== '') {
      out[key] = NOTIFICATION_SECRET_MASK;
    } else if (SECRET_RECORD_KEYS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(Object.keys(value).map((k) => [k, NOTIFICATION_SECRET_MASK]));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Replace masked values in `incoming` with what is stored, so an unchanged form keeps secrets. */
export function unmaskSettings(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === NOTIFICATION_SECRET_MASK && SECRET_KEYS.has(key)) {
      const prev = stored?.[key];
      if (prev !== undefined) out[key] = prev;
      continue;
    }
    if (SECRET_RECORD_KEYS.has(key) && isRecord(value)) {
      const prev = isRecord(stored?.[key]) ? (stored[key] as Record<string, unknown>) : {};
      out[key] = Object.fromEntries(
        Object.entries(value).flatMap(([k, v]) =>
          v === NOTIFICATION_SECRET_MASK ? (prev[k] === undefined ? [] : [[k, prev[k]]]) : [[k, v]],
        ),
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- form schema -----------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string;
  format?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

function labelFor(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/Url\b/, 'URL').replace(/Ssl\b/, 'SSL');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldType(name: string, node: JsonSchemaNode): NotificationFieldType {
  if (SECRET_KEYS.has(name) && node.format !== 'uri') return 'password';
  if (node.enum) return 'select';
  switch (node.type) {
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'number':
      return 'number';
    case 'object':
      return 'keyValue';
    case 'array':
      if (node.items?.enum) return 'multiSelect';
      return node.items?.format === 'email' ? 'emailList' : 'textList';
    default:
      if (node.format === 'uri') return 'url';
      if (node.format === 'email') return 'email';
      return 'text';
  }
}

/** Form fields for one agent kind, generated from its Zod settings schema. */
export function fieldsFor(kind: NotificationAgentKind): NotificationField[] {
  const json = z.toJSONSchema(agentSettingsSchemas[kind], { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, node]) => {
    const type = fieldType(name, node);
    const options = node.enum ?? node.items?.enum;
    const min = node.minimum ?? node.minLength;
    const max = node.maximum ?? node.maxLength;
    const field: NotificationField = {
      name,
      label: labelFor(name),
      type,
      required: required.has(name),
      secret: SECRET_KEYS.has(name) || SECRET_RECORD_KEYS.has(name),
      ...(node.description ? { helpText: node.description } : {}),
      ...(node.default !== undefined ? { default: node.default } : {}),
      ...(options ? { options: options.map((o) => ({ value: String(o), label: String(o) })) } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
    return field;
  });
}

export function schemaFor(kind: NotificationAgentKind): NotificationSchema {
  const fields = fieldsFor(kind);
  const defaults = Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
  const caps = capabilitiesFrom(STATIC_SUPPORT[kind]);
  const triggers = Object.fromEntries(
    NOTIFICATION_TRIGGERS.map((t) => [t, caps[supportFlagFor(t)] && t !== 'onRename' && t !== 'onApplicationUpdate']),
  ) as Record<NotificationTrigger, boolean>;
  return {
    implementation: kind,
    implementationName: IMPLEMENTATION_NAMES[kind],
    fields,
    template: {
      name: '',
      implementation: kind,
      enabled: true,
      ...triggers,
      includeHealthWarnings: false,
      respectQuietHours: true,
      tags: [],
      settings: defaults,
    },
    ...caps,
  };
}

export function allSchemas(): NotificationSchema[] {
  return NOTIFICATION_AGENT_KINDS.map(schemaFor);
}
