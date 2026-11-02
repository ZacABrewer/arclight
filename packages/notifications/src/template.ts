/**
 * Message templates: per-event overrides of the title and body every agent sends.
 *
 * The syntax is a small, logic-less subset of the usual "mustache" style, implemented here
 * from scratch (no code is ever evaluated):
 *
 *   {{mediaTitle}}                 a variable (dotted paths reach into the raw event: {{event.media.year}})
 *   {{#episode}}…{{/episode}}      the inside only when the variable is set (non-empty)
 *   {{^episode}}…{{/episode}}      the inside only when it is not
 *   {{json event.release}}         the value as JSON (for webhook body templates)
 *
 * Unknown variables render as nothing. In `json` escape mode (webhook body templates) every
 * plain `{{var}}` is escaped for use inside a JSON string literal.
 */

import { episodeLabel, episodeTitles, formatBytes, formatEvent, qualityLabel, type FormattedEvent } from './format.js';
import { NOTIFICATION_EVENT_TYPES, type NotificationEvent, type NotificationEventType } from './types.js';

export interface MessageTemplate {
  /** Replaces the headline ("Title (Year) - S01E02"). Blank keeps the default. */
  title?: string | undefined;
  /** Replaces the message text. Blank keeps the default. */
  body?: string | undefined;
}

/** Templates keyed by event type; `default` applies to every event without its own. */
export type MessageTemplates = Partial<Record<NotificationEventType | 'default', MessageTemplate>>;

export const TEMPLATE_KEYS = ['default', ...NOTIFICATION_EVENT_TYPES] as const;

export type TemplateEscape = 'none' | 'json';

/** A variable the template editor lists, with what it holds. */
export interface TemplateVariable {
  name: string;
  description: string;
}

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: 'instanceName', description: 'Name of this Arclight instance' },
  { name: 'applicationUrl', description: 'Public URL of this Arclight' },
  { name: 'eventType', description: 'Event type, e.g. grab or requestApproved' },
  { name: 'timestamp', description: 'When it happened (ISO-8601)' },
  { name: 'subject', description: 'What happened, e.g. "Episode Grabbed"' },
  { name: 'title', description: 'Default headline (title, year, episode)' },
  { name: 'body', description: 'Default message text' },
  { name: 'severity', description: 'info, success, upgrade, warning or error' },
  { name: 'link', description: 'Link to the item' },
  { name: 'posterUrl', description: 'Poster image URL' },
  { name: 'fanartUrl', description: 'Fanart image URL' },
  { name: 'mediaTitle', description: 'Series, movie, artist or author name' },
  { name: 'mediaYear', description: 'Release year' },
  { name: 'mediaType', description: 'series, movie, music or audiobook' },
  { name: 'overview', description: 'Plot overview' },
  { name: 'episode', description: 'Episode label, e.g. S01E02-E03' },
  { name: 'episodeTitle', description: 'Episode title(s)' },
  { name: 'album', description: 'Album title (music)' },
  { name: 'book', description: 'Book title (audiobooks)' },
  { name: 'quality', description: 'Quality, e.g. WEBDL-1080p' },
  { name: 'size', description: 'Size, e.g. 1.4 GB' },
  { name: 'releaseTitle', description: 'Release name' },
  { name: 'releaseGroup', description: 'Release group' },
  { name: 'indexer', description: 'Indexer the release came from' },
  { name: 'downloadClient', description: 'Download client' },
  { name: 'requestedBy', description: 'Who requested it (request events)' },
  { name: 'reason', description: 'Decline reason (request declined)' },
  { name: 'issueType', description: 'video, audio, subtitles or other' },
  { name: 'issueMessage', description: 'The issue report or new comment' },
  { name: 'healthMessage', description: 'Health check message' },
  { name: 'newVersion', description: 'New version (application update)' },
  { name: 'message', description: 'Free-form message the event carries' },
  { name: 'fieldsText', description: 'Every detail line as "Name: value"' },
  { name: 'event', description: 'The raw event; reach in with dots, e.g. event.media.tmdbId' },
];

/** The values a template can use for one event. */
export function templateContext(event: NotificationEvent, formatted: FormattedEvent = formatEvent(event)): Record<string, unknown> {
  const media = 'media' in event ? event.media : undefined;
  const episodes = 'episodes' in event ? event.episodes : undefined;
  const release = 'release' in event ? event.release : undefined;
  const file = 'file' in event ? event.file : undefined;
  const request = 'request' in event ? event.request : undefined;
  const issue = 'issue' in event ? event.issue : undefined;
  const health = 'health' in event ? event.health : undefined;
  const ctx: Record<string, unknown> = {
    event,
    instanceName: event.instanceName,
    applicationUrl: event.applicationUrl,
    eventType: event.type,
    timestamp: event.timestamp,
    subject: formatted.subject,
    title: formatted.title,
    body: formatted.body,
    severity: formatted.severity,
    link: formatted.link,
    posterUrl: formatted.posterUrl,
    fanartUrl: formatted.fanartUrl,
    mediaTitle: media?.title,
    mediaYear: media && media.year > 0 ? media.year : undefined,
    mediaType: media?.mediaType,
    overview: media?.overview,
    episode: episodeLabel(episodes) || undefined,
    episodeTitle: episodeTitles(episodes) || undefined,
    album: 'album' in event ? event.album?.title : undefined,
    book: 'book' in event ? event.book?.title : undefined,
    quality: file ? qualityLabel(file.quality, file.qualityVersion) : release ? qualityLabel(release.quality, release.qualityVersion) : undefined,
    size: file ? formatBytes(file.size) : release ? formatBytes(release.size) : undefined,
    releaseTitle: release?.title ?? file?.sceneName,
    releaseGroup: release?.releaseGroup ?? file?.releaseGroup,
    indexer: release?.indexer,
    downloadClient: 'downloadClient' in event ? event.downloadClient : undefined,
    requestedBy: request?.requestedBy.username,
    reason: event.type === 'requestDeclined' ? event.reason : 'reason' in event ? event.reason : undefined,
    issueType: issue?.issueType,
    issueMessage: issue ? (issue.comment?.message ?? issue.message) : undefined,
    healthMessage: health?.message,
    newVersion: event.type === 'applicationUpdate' ? event.newVersion : undefined,
    message: 'message' in event ? event.message : undefined,
    fieldsText: formatted.fields.map((f) => `${f.name}: ${f.value}`).join('\n'),
  };
  return ctx;
}

/** The template that applies to `type` (its own, else `default`), or undefined. */
export function templateFor(templates: MessageTemplates | undefined, type: NotificationEventType): MessageTemplate | undefined {
  if (!templates) return undefined;
  const own = templates[type];
  if (own && (nonBlank(own.title) || nonBlank(own.body))) return own;
  const fallback = templates.default;
  return fallback && (nonBlank(fallback.title) || nonBlank(fallback.body)) ? fallback : undefined;
}

/**
 * `formatted` with the template's title/body rendered in. Test events keep their text unless
 * the test has a template of its own, so "Send test" proves delivery even with odd templates.
 */
export function applyTemplate(event: NotificationEvent, formatted: FormattedEvent, templates: MessageTemplates | undefined): FormattedEvent {
  const template = event.type === 'test' ? templates?.test : templateFor(templates, event.type);
  if (!template) return formatted;
  const ctx = templateContext(event, formatted);
  const out: FormattedEvent = { ...formatted };
  if (nonBlank(template.title)) {
    const title = renderTemplate(template.title, ctx).replace(/\s+/g, ' ').trim();
    if (title) {
      out.title = title;
      out.templated = { ...out.templated, title: true };
    }
  }
  if (nonBlank(template.body)) {
    const body = renderTemplate(template.body, ctx).replace(/\n{3,}/g, '\n\n').trim();
    if (body) {
      out.body = body;
      out.templated = { ...out.templated, body: true };
    }
  }
  return out;
}

function nonBlank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---- engine --------------------------------------------------------------------------------

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string; json: boolean }
  | { kind: 'section'; path: string; inverted: boolean; children: Node[] };

const TAG = /\{\{\s*([#^/]?)\s*(json\s+)?([A-Za-z_][\w.]*)\s*\}\}/g;

/** Thrown for unbalanced sections; `validateTemplate` turns it into a message. */
export class TemplateSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ path: string; children: Node[] }> = [];
  let current = root;
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    const index = match.index;
    if (index > last) current.push({ kind: 'text', text: source.slice(last, index) });
    last = index + match[0].length;
    const sigil = match[1];
    const path = match[3]!;
    if (sigil === '#' || sigil === '^') {
      const node: Node = { kind: 'section', path, inverted: sigil === '^', children: [] };
      current.push(node);
      stack.push({ path, children: current });
      current = node.children;
    } else if (sigil === '/') {
      const open = stack.pop();
      if (!open || open.path !== path) throw new TemplateSyntaxError(`Unexpected {{/${path}}}`);
      current = open.children;
    } else {
      current.push({ kind: 'var', path, json: Boolean(match[2]) });
    }
  }
  if (stack.length > 0) throw new TemplateSyntaxError(`{{#${stack[stack.length - 1]!.path}}} is never closed`);
  if (last < source.length) current.push({ kind: 'text', text: source.slice(last) });
  return root;
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let value: unknown = ctx;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object') return undefined;
    // Own properties only: no prototype walking (`constructor`, `__proto__`).
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v !== null ? '' : stringify(v))).filter(Boolean).join(', ');
  return '';
}

function jsonEscape(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function renderNodes(nodes: Node[], ctx: Record<string, unknown>, escape: TemplateEscape): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'var') {
      const value = lookup(ctx, node.path);
      if (node.json) out += value === undefined ? 'null' : JSON.stringify(value);
      else out += escape === 'json' ? jsonEscape(stringify(value)) : stringify(value);
    } else {
      const on = truthy(lookup(ctx, node.path));
      if (on !== node.inverted) out += renderNodes(node.children, ctx, escape);
    }
  }
  return out;
}

/** Render `source` against `ctx`. Throws `TemplateSyntaxError` for unbalanced sections. */
export function renderTemplate(source: string, ctx: Record<string, unknown>, escape: TemplateEscape = 'none'): string {
  return renderNodes(parse(source), ctx, escape);
}

/** Undefined when `source` parses, else the problem (for form validation). */
export function validateTemplate(source: string): string | undefined {
  try {
    parse(source);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
