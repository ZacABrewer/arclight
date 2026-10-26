import { describe, expect, it } from 'vitest';
import { MESSAGE_EVENTS, type NotificationAgent, type NotificationEvent } from '@arclight/notifications';
import { Permission as P, RequestsSettings, type NotificationInputRaw } from '@arclight/shared';
import { NotificationsService, wantsEvent } from '../notifications/index.js';
import { setSection } from '../settings/service.js';
import { addUser, NOW, setup } from './test-support.js';

// Sitewide request/issue notifications: connection flags, dispatch from the requests
// service, and the admin digest.

function systemConnections() {
  const sent: Array<{ connection: string; event: NotificationEvent }> = [];
  const factory = (_kind: string, settings: unknown): NotificationAgent => ({
    kind: 'discord',
    supportedEvents: MESSAGE_EVENTS,
    async send(event) {
      sent.push({ connection: (settings as { webhookUrl: string }).webhookUrl, event });
    },
    async test() {},
  });
  return { sent, factory };
}

async function harness() {
  const sys = systemConnections();
  let notifications!: NotificationsService;
  const h = await setup({ extra: { systemDispatch: (e) => notifications.dispatch(e) } });
  notifications = new NotificationsService({ db: h.db, agentFactory: sys.factory, now: () => NOW });
  h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addMovie({ tmdbId: 604, title: 'Reloaded', year: 2003 });
  const connection = (name: string, flags: Partial<NotificationInputRaw>) =>
    notifications.create({ name, implementation: 'discord', settings: { webhookUrl: `https://discord.test/${name}` }, ...flags });
  return { ...h, notifications, sent: sys.sent, connection };
}

const BASE_ROW = {
  onGrab: false,
  onDownload: false,
  onUpgrade: false,
  onRename: false,
  onSeriesAdd: false,
  onMovieAdd: false,
  onSeriesDelete: false,
  onMovieDelete: false,
  onFileDelete: false,
  onHealthIssue: false,
  onHealthRestored: false,
  onApplicationUpdate: false,
  onManualInteractionRequired: false,
  onRequestCreated: false,
  onRequestApproved: false,
  onRequestDeclined: false,
  onRequestAvailable: false,
  onIssueCreated: false,
  onIssueUpdated: false,
  includeHealthWarnings: false,
};

describe('connection flags for request and issue events', () => {
  it('wantsEvent routes each request/issue event to its own flag and the digest to created flags', () => {
    const ev = (type: string) => ({ type }) as unknown as NotificationEvent;
    const pairs: Array<[keyof typeof BASE_ROW, string]> = [
      ['onRequestCreated', 'requestCreated'],
      ['onRequestApproved', 'requestApproved'],
      ['onRequestDeclined', 'requestDeclined'],
      ['onRequestAvailable', 'requestAvailable'],
      ['onIssueCreated', 'issueCreated'],
      ['onIssueUpdated', 'issueUpdated'],
    ];
    for (const [flag, type] of pairs) {
      expect(wantsEvent({ ...BASE_ROW, [flag]: true }, ev(type))).toBe(true);
      expect(wantsEvent(BASE_ROW, ev(type))).toBe(false);
    }
    expect(wantsEvent({ ...BASE_ROW, onIssueCreated: true }, ev('requestsDigest'))).toBe(true);
    expect(wantsEvent({ ...BASE_ROW, onRequestApproved: true }, ev('requestsDigest'))).toBe(false);
  });

  it('flags are stored, returned and advertised as supported for chat agents', async () => {
    const h = await harness();
    const conn = h.connection('admins', { onRequestCreated: true, onIssueUpdated: true });
    expect(conn).toMatchObject({ onRequestCreated: true, onIssueUpdated: true, onRequestApproved: false, supportsOnRequestCreated: true });
    expect(h.notifications.schemas().find((s) => s.implementation === 'plex')?.supportsOnRequestCreated).toBe(false);
  });
});

describe('sitewide dispatch from the requests service', () => {
  it('a new request reaches only connections with onRequestCreated, with requester, poster and approve links', async () => {
    const h = await harness();
    setSection(h.db, 'requests', RequestsSettings.parse({ applicationUrl: 'https://arc.example' }));
    h.connection('requests', { onRequestCreated: true });
    h.connection('quiet', { onRequestApproved: true });
    const u = addUser(h.db, { username: 'alice' });
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(h.sent.map((s) => [s.connection, s.event.type])).toEqual([['https://discord.test/requests', 'requestCreated']]);
    const event = h.sent[0]!.event;
    if (event.type !== 'requestCreated') throw new Error();
    expect(event.applicationUrl).toBe('https://arc.example');
    expect(event.request).toMatchObject({ status: 'pending', requestedBy: { username: 'alice' } });
    expect(event.media.images).toEqual([{ coverType: 'poster', url: 'https://img/603.jpg' }]);
  });

  it('approve, decline and availability each respect their own flag', async () => {
    const h = await harness();
    h.connection('approved', { onRequestApproved: true });
    h.connection('declined', { onRequestDeclined: true });
    const admin = addUser(h.db, { role: 'admin' });
    const u = addUser(h.db);
    const a = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    const b = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 604 });
    if (a.kind !== 'created' || b.kind !== 'created') throw new Error();
    await h.services.requests.approve(admin.actor, a.request.id);
    await h.services.requests.decline(admin.actor, b.request.id, 'not now');
    expect(h.sent.map((s) => [s.connection.split('/').pop(), s.event.type])).toEqual([
      ['approved', 'requestApproved'],
      ['declined', 'requestDeclined'],
    ]);
  });

  it('issues fire onIssueCreated / onIssueUpdated connections', async () => {
    const h = await harness();
    h.connection('issues', { onIssueCreated: true, onIssueUpdated: true });
    const reporter = addUser(h.db, { permissions: P.CREATE_ISSUES });
    const admin = addUser(h.db, { role: 'admin' });
    const issue = await h.services.issues.create(reporter.actor, { type: 'audio', mediaType: 'movie', tmdbId: 603, message: 'no sound' });
    await h.services.issues.comment(admin.actor, issue.id, 'looking');
    expect(h.sent.map((s) => s.event.type)).toEqual(['issueCreated', 'issueUpdated']);
  });

  it('disabled connections and connections without the flag get nothing', async () => {
    const h = await harness();
    h.connection('off', { onRequestCreated: true, enabled: false });
    h.connection('grabs', { onGrab: true });
    await h.services.requests.create(addUser(h.db).actor, { mediaType: 'movie', tmdbId: 603 });
    expect(h.sent).toEqual([]);
  });
});

describe('RequestsDigest', () => {
  it('sends nothing when nothing is pending, else one summary to digest-eligible connections', async () => {
    const h = await harness();
    h.connection('admins', { onRequestCreated: true });
    expect(await h.services.requests.digest()).toEqual({ sent: false, pendingRequests: 0, openIssues: 0 });
    const u = addUser(h.db, { username: 'bob', permissions: P.REQUEST | P.CREATE_ISSUES });
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 604 });
    await h.services.issues.create(u.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'glitch' });
    h.sent.length = 0;
    expect(await h.services.requests.digest()).toEqual({ sent: true, pendingRequests: 2, openIssues: 1 });
    expect(h.sent).toHaveLength(1);
    const event = h.sent[0]!.event;
    if (event.type !== 'requestsDigest') throw new Error();
    expect(event.totalPendingRequests).toBe(2);
    expect(event.pendingRequests.map((r) => [r.title, r.requestedBy])).toEqual([
      ['The Matrix', 'bob'],
      ['Reloaded', 'bob'],
    ]);
    expect(event.openIssues).toMatchObject([{ title: 'The Matrix', issueType: 'video', reportedBy: 'bob' }]);
  });

  it('the job tick sends once a day at digestHour and only when enabled', async () => {
    const h = await harness();
    h.connection('admins', { onIssueCreated: true });
    await h.services.requests.create(addUser(h.db).actor, { mediaType: 'movie', tmdbId: 603 });
    h.sent.length = 0;
    expect(await h.services.requests.digestTick()).toBe('digest disabled');
    setSection(h.db, 'requests', RequestsSettings.parse({ digestEnabled: true, digestHour: (NOW.getHours() + 1) % 24 }));
    expect(await h.services.requests.digestTick()).toMatch(/^waiting for/);
    setSection(h.db, 'requests', RequestsSettings.parse({ digestEnabled: true, digestHour: NOW.getHours() }));
    expect(await h.services.requests.digestTick()).toMatch(/digest sent: 1 pending requests, 0 open issues/);
    expect(await h.services.requests.digestTick()).toBe('digest already sent today');
    expect(h.sent.map((s) => s.event.type)).toEqual(['requestsDigest']);
  });
});
