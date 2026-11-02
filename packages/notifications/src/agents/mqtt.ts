/**
 * MQTT: publishes every event as JSON to a broker (Home Assistant, Node-RED, ...). The topic is
 * a template, so `arclight/{{eventType}}` gives one topic per event type.
 */

import { z } from 'zod';
import { connectSocket, publishMqtt, randomClientId } from '../mqtt-client.js';
import { renderTemplate, templateContext, validateTemplate } from '../template.js';
import type { Severity } from '../format.js';
import type { NotificationEvent, NotificationEventType } from '../types.js';
import { ALL_EVENTS, BaseAgent, type AgentDeps, type SocketConnect } from './base.js';

export const MqttSettings = z.object({
  host: z.string().min(1).describe('Hostname or IP of the MQTT broker.'),
  port: z.number().int().min(1).max(65535).default(1883).describe('Broker port (1883 plain, 8883 TLS).'),
  useTls: z.boolean().default(false).describe('Connect over TLS.'),
  allowInvalidCertificates: z.boolean().default(false).describe('Accept self-signed or otherwise invalid TLS certificates.'),
  username: z.string().optional().describe('Username, when the broker requires authentication.'),
  password: z.string().optional().describe('Password (only sent together with a username).'),
  clientId: z
    .string()
    .min(1)
    .max(65535)
    .default(() => randomClientId())
    .describe('MQTT client id. Must be unique per connection on the broker.'),
  topic: z
    .string()
    .min(1)
    .refine((t) => validateTemplate(t) === undefined, { message: 'Topic template does not parse' })
    .default('arclight/{{eventType}}')
    .describe('Topic to publish to; a template, e.g. arclight/{{eventType}}. Wildcards (+, #) are replaced.'),
  qos: z.union([z.literal(0), z.literal(1)]).default(1).describe('0 = at most once, 1 = at least once (waits for the broker to confirm).'),
  retain: z.boolean().default(false).describe('Ask the broker to keep the last message on the topic for new subscribers.'),
  timeoutMs: z.number().int().min(1000).max(60_000).default(10_000).describe('How long to wait for the broker, in milliseconds.'),
});
export type MqttSettings = z.infer<typeof MqttSettings>;

export interface MqttPayload {
  eventType: NotificationEventType;
  title: string;
  body: string;
  subject: string;
  severity: Severity;
  link: string | null;
  posterUrl: string | null;
  event: NotificationEvent;
}

/** Turn a rendered topic into a valid publish topic: no wildcards, no empty levels, no `$` system prefix. */
export function sanitiseTopic(topic: string): string {
  const levels = topic
    // eslint-disable-next-line no-control-regex
    .replace(/[+#\u0000]/g, '_')
    .split('/')
    .map((level) => level.trim())
    .filter((level) => level.length > 0);
  const joined = levels.join('/').replace(/^\$+/, '');
  return joined.length > 0 ? joined : 'arclight';
}

export class MqttAgent extends BaseAgent {
  readonly kind = 'mqtt' as const;
  readonly supportedEvents = ALL_EVENTS;
  private readonly socket: SocketConnect;

  constructor(
    private readonly settings: MqttSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
    this.socket = deps.socket ?? connectSocket;
  }

  buildTopic(event: NotificationEvent): string {
    return sanitiseTopic(renderTemplate(this.settings.topic, templateContext(event, this.format(event))));
  }

  buildPayload(event: NotificationEvent): MqttPayload {
    const formatted = this.format(event);
    return {
      eventType: event.type,
      title: formatted.title,
      body: formatted.body,
      subject: formatted.subject,
      severity: formatted.severity,
      link: formatted.link ?? null,
      posterUrl: formatted.posterUrl ?? null,
      event,
    };
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    await publishMqtt(this.socket, {
      host: this.settings.host,
      port: this.settings.port,
      tls: this.settings.useTls,
      rejectUnauthorized: !this.settings.allowInvalidCertificates,
      timeoutMs: this.settings.timeoutMs,
      clientId: this.settings.clientId,
      username: this.settings.username,
      password: this.settings.password,
      topic: this.buildTopic(event),
      payload: Buffer.from(JSON.stringify(this.buildPayload(event)), 'utf8'),
      qos: this.settings.qos,
      retain: this.settings.retain,
    });
  }
}
