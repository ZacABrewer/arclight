import { describe, expect, it } from 'vitest';
import { DiscordAgent } from './agents/discord.js';
import { GotifyAgent } from './agents/gotify.js';
import { NtfyAgent } from './agents/ntfy.js';
import { PushoverAgent } from './agents/pushover.js';
import { TelegramAgent } from './agents/telegram.js';
import { WebhookAgent } from './agents/webhook.js';
import { formatEvent, requestLinks } from './format.js';
import { parseAgentSettings } from './index.js';
import type { RequestCreatedEvent, RequestsDigestEvent } from './types.js';

const MEDIA = {
  id: 0,
  mediaType: 'movie' as const,
  title: 'The Matrix',
  year: 1999,
  tmdbId: 603,
  path: '',
  genres: [],
  tags: [],
  images: [{ coverType: 'poster' as const, url: 'https://img/603.jpg' }],
};

function created(overrides: Partial<RequestCreatedEvent> = {}): RequestCreatedEvent {
  return {
    type: 'requestCreated',
    instanceName: 'Arclight',
    timestamp: '2026-06-01T12:00:00.000Z',
    applicationUrl: 'https://arc.example/',
    media: MEDIA,
    request: { id: 12, status: 'pending', requestedBy: { id: 3, username: 'alice', avatar: 'https://img/alice.png' } },
    ...overrides,
  };
}

const DIGEST: RequestsDigestEvent = {
  type: 'requestsDigest',
  instanceName: 'Arclight',
  timestamp: '2026-06-01T09:00:00.000Z',
  applicationUrl: 'https://arc.example',
  totalPendingRequests: 3,
  totalOpenIssues: 1,
  pendingRequests: [
    { id: 1, mediaType: 'movie', title: 'The Matrix', year: 1999, requestedBy: 'alice', is4k: false, createdAt: '2026-05-30T00:00:00Z' },
    { id: 2, mediaType: 'series', title: 'Thrones', requestedBy: 'bob', is4k: true, createdAt: '2026-05-31T00:00:00Z' },
  ],
  openIssues: [{ id: 5, mediaType: 'movie', title: 'Alien', issueType: 'audio', reportedBy: 'carol', createdAt: '2026-05-29T00:00:00Z' }],
};

describe('request notification formatting', () => {
  it('a pending request gets Approve/Decline/View deep links, the requester and the poster', () => {
    const f = formatEvent(created());
    expect(f.actions).toEqual([
      { label: 'Approve', url: 'https://arc.example/requests/12?action=approve' },
      { label: 'Decline', url: 'https://arc.example/requests/12?action=decline' },
      { label: 'View request', url: 'https://arc.example/requests/12' },
    ]);
    expect(f.link).toBe('https://arc.example/requests/12');
    expect(f.person).toEqual({ name: 'alice', avatarUrl: 'https://img/alice.png' });
    expect(f.posterUrl).toBe('https://img/603.jpg');
    expect(f.body).toContain('Approve: https://arc.example/requests/12?action=approve');
    expect(requestLinks(undefined, 1)).toBeUndefined();
  });

  it('without an application URL there are no actions; approved requests only link to the request', () => {
    const { applicationUrl: _drop, ...rest } = created();
    expect(formatEvent(rest).actions).toBeUndefined();
    const approved = formatEvent({ ...created(), type: 'requestApproved', request: { ...created().request, status: 'approved' } } as never);
    expect(approved.actions).toEqual([{ label: 'View request', url: 'https://arc.example/requests/12' }]);
  });

  it('Discord embeds carry the actions as markdown links and the requester in the footer', () => {
    const agent = new DiscordAgent(parseAgentSettings('discord', { webhookUrl: 'https://discord.com/api/webhooks/1/x' }));
    const embed = agent.buildPayload(created()).embeds[0]!;
    const actions = embed.fields.find((f) => f.name === 'Actions');
    expect(actions?.value).toContain('[Approve](https://arc.example/requests/12?action=approve)');
    expect(actions?.value).toContain('[Decline](https://arc.example/requests/12?action=decline)');
    expect(embed.footer).toEqual({ text: 'Requested by alice', icon_url: 'https://img/alice.png' });
    expect(embed.thumbnail).toEqual({ url: 'https://img/603.jpg' });
    expect(embed.url).toBe('https://arc.example/requests/12');
    expect(embed.fields.find((f) => f.name === 'Requested By')?.value).toBe('alice');
  });

  it('Telegram renders escaped action links', () => {
    const agent = new TelegramAgent(parseAgentSettings('telegram', { botToken: 'b', chatId: '1' }));
    const text = agent.buildPayload(created()).text;
    expect(text).toContain('[Approve](https://arc.example/requests/12?action=approve)');
    expect(text).toContain('\\|');
  });

  it('ntfy gets action buttons, Gotify markdown links, Pushover the request URL', () => {
    const ntfy = new NtfyAgent(parseAgentSettings('ntfy', { serverUrl: 'https://ntfy.sh', topics: ['t'] }));
    expect(ntfy.buildRequests(created())[0]!.headers['Actions']).toBe(
      'view, Approve, https://arc.example/requests/12?action=approve; view, Decline, https://arc.example/requests/12?action=decline; view, View request, https://arc.example/requests/12',
    );
    const gotify = new GotifyAgent(parseAgentSettings('gotify', { serverUrl: 'https://g', appToken: 'a' }));
    expect(gotify.buildPayload(created()).message).toContain('[Decline](https://arc.example/requests/12?action=decline)');
    const pushover = new PushoverAgent(parseAgentSettings('pushover', { apiToken: 'a'.repeat(30), userKey: 'u'.repeat(30) }));
    const form = pushover.buildForm(created());
    expect(form['url']).toBe('https://arc.example/requests/12');
    expect(form['message']).toContain('Approve: https://arc.example/requests/12?action=approve');
  });

  it('webhook payloads include the actions next to the raw event', () => {
    const agent = new WebhookAgent(parseAgentSettings('webhook', { url: 'https://hook' }));
    const payload = agent.buildPayload(created());
    expect(payload.eventType).toBe('requestCreated');
    expect(payload.actions?.map((a) => a.label)).toEqual(['Approve', 'Decline', 'View request']);
  });

  it('formats the admin digest with totals, lines and links', () => {
    const f = formatEvent(DIGEST);
    expect(f.subject).toBe('Requests Digest');
    expect(f.title).toBe('3 pending requests, 1 open issue');
    const pending = f.fields.find((x) => x.name === 'Pending Requests')!.value;
    expect(pending).toContain('The Matrix (1999) - alice');
    expect(pending).toContain('Thrones [4K] - bob');
    expect(pending).toContain('...and 1 more');
    expect(f.fields.find((x) => x.name === 'Open Issues')!.value).toBe('Alien (audio) - carol');
    expect(f.actions).toEqual([
      { label: 'Review requests', url: 'https://arc.example/requests?filter=pending' },
      { label: 'Open issues', url: 'https://arc.example/issues?filter=open' },
    ]);
  });
});
