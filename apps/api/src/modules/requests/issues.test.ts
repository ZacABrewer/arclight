import { describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { notifications } from '../../db/schema.js';
import { RequestsError } from './errors.js';
import { addUser, NOW, setup } from './test-support.js';

async function harness() {
  const h = await setup();
  h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [0, 3] });
  const admin = addUser(h.db, { role: 'admin', settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/admin' } } });
  const reporter = addUser(h.db, { permissions: P.CREATE_ISSUES, settings: { notifications: { discordEnabled: true, discordWebhookUrl: 'https://d/rep' } } });
  return { ...h, admin, reporter };
}

const to = (sent: { settings: Record<string, unknown>; event: { type: string } }[], hook: string) =>
  sent.filter((s) => s.settings['webhookUrl'] === hook).map((s) => s.event.type);

describe('issues', () => {
  it('creates an issue with the message as first comment and notifies issue managers', async () => {
    const h = await harness();
    const issue = await h.services.issues.create(h.reporter.actor, { type: 'audio', mediaType: 'series', tmdbId: 1399, message: 'out of sync', problemSeason: 1, problemEpisode: 2 });
    expect(issue).toMatchObject({ type: 'audio', status: 'open', mediaTitle: 'Thrones', problemSeason: 1, problemEpisode: 2 });
    expect(issue.comments.map((c) => c.message)).toEqual(['out of sync']);
    expect(to(h.sent, 'https://d/admin')).toEqual(['issueCreated']);
    expect(to(h.sent, 'https://d/rep')).toEqual([]);
  });

  it('requires CREATE_ISSUES (or MANAGE_ISSUES) to report', async () => {
    const h = await harness();
    const plain = addUser(h.db, { permissions: P.REQUEST });
    await expect(h.services.issues.create(plain.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'x' })).rejects.toThrow(RequestsError);
  });

  it('scopes lists to the creator unless VIEW_ISSUES, and counts by type and status', async () => {
    const h = await harness();
    const other = addUser(h.db, { permissions: P.CREATE_ISSUES });
    const viewer = addUser(h.db, { permissions: P.VIEW_ISSUES });
    await h.services.issues.create(h.reporter.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'a' });
    await h.services.issues.create(other.actor, { type: 'subtitles', mediaType: 'movie', tmdbId: 603, message: 'b' });
    expect(h.services.issues.list(h.reporter.actor, {}).pageInfo.total).toBe(1);
    expect(h.services.issues.list(viewer.actor, {}).pageInfo.total).toBe(2);
    expect(h.services.issues.list(viewer.actor, { type: 'subtitles' }).results.map((i) => i.createdBy.id)).toEqual([other.id]);
    expect(() => h.services.issues.list(h.reporter.actor, { createdBy: other.id })).toThrow(RequestsError);
    expect(h.services.issues.count(h.admin.actor)).toEqual({ total: 2, video: 1, audio: 0, subtitles: 1, other: 0, open: 2, resolved: 0 });
  });

  it('comments notify admins and the creator, but never the commenter', async () => {
    const h = await harness();
    const issue = await h.services.issues.create(h.reporter.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'broken' });
    h.sent.length = 0;
    await h.services.issues.comment(h.admin.actor, issue.id, 'looking into it');
    expect(to(h.sent, 'https://d/rep')).toEqual(['issueUpdated']);
    expect(to(h.sent, 'https://d/admin')).toEqual([]);
    h.sent.length = 0;
    const withReply = await h.services.issues.comment(h.reporter.actor, issue.id, 'thanks');
    expect(withReply.comments).toHaveLength(3);
    expect(to(h.sent, 'https://d/admin')).toEqual(['issueUpdated']);
    expect(to(h.sent, 'https://d/rep')).toEqual([]);
  });

  it('only the creator or a manager comments, resolves and reopens', async () => {
    const h = await harness();
    const stranger = addUser(h.db, { permissions: P.CREATE_ISSUES });
    const issue = await h.services.issues.create(h.reporter.actor, { type: 'other', mediaType: 'movie', tmdbId: 603, message: 'm' });
    await expect(h.services.issues.comment(stranger.actor, issue.id, 'hi')).rejects.toThrow(RequestsError);
    await expect(h.services.issues.setStatus(stranger.actor, issue.id, 'resolved')).rejects.toThrow(RequestsError);
    const resolved = await h.services.issues.setStatus(h.admin.actor, issue.id, 'resolved');
    expect(resolved).toMatchObject({ status: 'resolved', modifiedBy: { id: h.admin.id } });
    const reopened = await h.services.issues.setStatus(h.reporter.actor, issue.id, 'open');
    expect(reopened.status).toBe('open');
  });

  it('comment edits are author-only; deletes are author or manager; issue delete rules', async () => {
    const h = await harness();
    const issue = await h.services.issues.create(h.reporter.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'm' });
    const first = issue.comments[0]!;
    expect(() => h.services.issues.editComment(h.admin.actor, first.id, 'edited')).toThrow(RequestsError);
    expect(h.services.issues.editComment(h.reporter.actor, first.id, 'edited').comments[0]!.message).toBe('edited');
    const replied = await h.services.issues.comment(h.admin.actor, issue.id, 'reply');
    expect(() => h.services.issues.remove(h.reporter.actor, issue.id)).toThrow(/without replies/);
    h.services.issues.deleteComment(h.admin.actor, replied.comments[1]!.id);
    h.services.issues.remove(h.reporter.actor, issue.id);
    expect(() => h.services.issues.get(h.admin.actor, issue.id)).toThrow(/not found/);
  });

  it('sends personal Telegram notifications through the system bot with the user chat id', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const now = NOW.toISOString();
    const flags = {
      onGrab: false, onDownload: false, onUpgrade: false, onRename: false, onSeriesAdd: false, onMovieAdd: false, onSeriesDelete: false,
      onMovieDelete: false, onFileDelete: false, onHealthIssue: false, onHealthRestored: false, onApplicationUpdate: false,
      onManualInteractionRequired: false, includeHealthWarnings: false,
    };
    h.db.insert(notifications).values({ name: 'tg', implementation: 'telegram', enabled: true, ...flags, tags: [], settings: { botToken: 'bot:1', chatId: '-100', topicId: 5 }, addedAt: now, updatedAt: now }).run();
    addUser(h.db, { role: 'admin', settings: { notifications: { telegramEnabled: true, telegramChatId: '777', types: { issueCreated: true } } } });
    const muted = addUser(h.db, { role: 'admin', settings: { notifications: { telegramEnabled: true, telegramChatId: '888', types: { issueCreated: false } } } });
    const rep = addUser(h.db, { permissions: P.CREATE_ISSUES });
    await h.services.issues.create(rep.actor, { type: 'video', mediaType: 'movie', tmdbId: 603, message: 'x' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ kind: 'telegram', settings: { botToken: 'bot:1', chatId: '777' } });
    expect(h.sent[0]!.settings).not.toHaveProperty('topicId');
    expect(muted.id).toBeGreaterThan(0);
  });
});
