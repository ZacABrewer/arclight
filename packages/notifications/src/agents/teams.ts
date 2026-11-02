/**
 * Microsoft Teams via a Workflows webhook (Power Automate "Post to a channel when a webhook
 * request is received"). The flow expects a message with one Adaptive Card attachment.
 */

import { z } from 'zod';
import type { FormattedAction, FormattedEvent } from '../format.js';
import { httpRequest } from '../http.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export const TeamsSettings = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .describe('Workflows webhook URL: in Teams, channel > Workflows > "Post to a channel when a webhook request is received", then copy the URL.'),
});
export type TeamsSettings = z.infer<typeof TeamsSettings>;

const TEXT_MAX = 4000;
const FACT_VALUE_MAX = 1000;
const MAX_FACTS = 20;
const MAX_ACTIONS = 5;

export type AdaptiveElement =
  | { type: 'TextBlock'; text: string; wrap: true; weight?: 'Bolder'; size?: 'Medium' | 'Large'; isSubtle?: boolean; spacing?: 'None' | 'Small' }
  | { type: 'Image'; url: string; altText: string; size: 'Medium' | 'Large' }
  | {
      type: 'ColumnSet';
      columns: Array<{ type: 'Column'; width: 'auto' | 'stretch'; verticalContentAlignment?: 'Center'; items: AdaptiveElement[] }>;
      selectAction?: AdaptiveAction;
    }
  | { type: 'FactSet'; facts: Array<{ title: string; value: string }> };

export interface AdaptiveAction {
  type: 'Action.OpenUrl';
  title: string;
  url: string;
}

export interface AdaptiveCard {
  type: 'AdaptiveCard';
  $schema: string;
  version: '1.4';
  body: AdaptiveElement[];
  actions?: AdaptiveAction[];
  msteams: { width: 'Full' };
}

export interface TeamsPayload {
  type: 'message';
  attachments: Array<{ contentType: 'application/vnd.microsoft.card.adaptive'; contentUrl: null; content: AdaptiveCard }>;
}

export class TeamsAgent extends BaseAgent {
  readonly kind = 'teams' as const;
  readonly supportedEvents = MESSAGE_EVENTS;

  constructor(
    private readonly settings: TeamsSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
  }

  buildPayload(event: NotificationEvent): TeamsPayload {
    const formatted = this.format(event);
    const heading: AdaptiveElement[] = [
      { type: 'TextBlock', text: clip(formatted.title, 300), wrap: true, weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: `${formatted.subject} · ${event.instanceName}`, wrap: true, isSubtle: true, spacing: 'None' },
    ];
    if (formatted.person) heading.push({ type: 'TextBlock', text: `Requested by ${formatted.person.name}`, wrap: true, isSubtle: true, spacing: 'None' });

    const header: Extract<AdaptiveElement, { type: 'ColumnSet' }> = {
      type: 'ColumnSet',
      columns: [{ type: 'Column', width: 'stretch', verticalContentAlignment: 'Center', items: heading }],
    };
    if (formatted.posterUrl) {
      header.columns.unshift({ type: 'Column', width: 'auto', items: [{ type: 'Image', url: formatted.posterUrl, altText: 'Poster', size: 'Medium' }] });
    }
    if (formatted.link) header.selectAction = { type: 'Action.OpenUrl', title: 'Open', url: formatted.link };

    const body: AdaptiveElement[] = [header];
    if (formatted.templated?.body) body.push({ type: 'TextBlock', text: clip(formatted.body, TEXT_MAX), wrap: true });
    const facts = formatted.fields
      .filter((f) => f.value.length > 0)
      .slice(0, MAX_FACTS)
      .map((f) => ({ title: f.name, value: clip(f.value, FACT_VALUE_MAX) }));
    if (facts.length > 0) body.push({ type: 'FactSet', facts });

    const card: AdaptiveCard = {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body,
      msteams: { width: 'Full' },
    };
    const actions = linkActions(formatted).slice(0, MAX_ACTIONS);
    if (actions.length > 0) card.actions = actions.map((a) => ({ type: 'Action.OpenUrl', title: a.label, url: a.url }));

    return {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
    };
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    // Workflows answers 202 Accepted (any 2xx passes); the flow then posts the card.
    await httpRequest(this.fetch, this.kind, this.settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(event)),
      acceptStatuses: [202],
      label: 'Teams webhook',
    });
  }
}

/** The event's actions first (approve/decline), then the item link unless an action already opens it. */
function linkActions(formatted: FormattedEvent): FormattedAction[] {
  const out: FormattedAction[] = [...(formatted.actions ?? [])];
  if (formatted.link && !out.some((a) => a.url === formatted.link)) out.push({ label: 'Open', url: formatted.link });
  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
