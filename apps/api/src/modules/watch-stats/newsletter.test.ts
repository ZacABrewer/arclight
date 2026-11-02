import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SmtpConnect, SmtpConnection } from '@arclight/notifications';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, notifications } from '../../db/schema.js';
import { addUser, setup } from '../requests/test-support.js';
import { addMovie, addSeries } from '../watch-history/test-support.js';
import { newsletterDue } from './jobs.js';
import { Newsletter } from './newsletter.js';

const NOW = new Date('2026-11-06T09:10:00.000Z');
const DAY = 24 * 60 * 60_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** A scripted SMTP server that records what it is sent. */
function fakeSmtp(fail?: string) {
  const written: string[] = [];
  const connect: SmtpConnect = async () => {
    const queue: string[] = ['220'];
    const conn: SmtpConnection = {
      write(data) {
        written.push(data);
        const cmd = data.split(' ')[0]!.trim().toUpperCase();
        if (cmd === 'DATA') queue.push('354');
        else if (cmd === 'QUIT') queue.push('221');
        else if (fail && data.startsWith(fail)) queue.push('550');
        else queue.push('250');
      },
      async readReply() {
        const code = queue.shift() ?? '250';
        return { code: Number(code), lines: ['ok'] };
      },
      async startTls() {},
      close() {},
    };
    return conn;
  };
  return { connect, written };
}

function emailConnection(db: Db): number {
  return db
    .insert(notifications)
    .values({
      name: 'Mail',
      implementation: 'email',
      tags: [],
      settings: { host: 'smtp.example.com', port: 25, security: 'none', from: 'arclight@example.com', to: ['family@example.com'], bcc: ['hidden@example.com'] },
      addedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .returning()
    .get().id;
}

function file(db: Db, values: { mediaType: 'movie' | 'series'; movieId?: number; seriesId?: number; dateAdded: string; name: string }): number {
  return db
    .insert(mediaFiles)
    .values({
      mediaType: values.mediaType,
      movieId: values.movieId ?? null,
      seriesId: values.seriesId ?? null,
      relativePath: values.name,
      path: `/media/${values.name}`,
      dateAdded: values.dateAdded,
      quality: { quality: { id: 1, name: 'HD-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0, isRepack: false } } as never,
      languages: [],
    })
    .returning()
    .get().id;
}

async function seeded() {
  const h = await setup();
  const fresh = addMovie(h.db, 1, 'Fresh Movie');
  const old = addMovie(h.db, 2, 'Old Movie');
  file(h.db, { mediaType: 'movie', movieId: fresh, dateAdded: ago(1), name: 'fresh.mkv' });
  file(h.db, { mediaType: 'movie', movieId: old, dateAdded: ago(30), name: 'old.mkv' });
  const show = addSeries(h.db, 10, 20, 'Harbour <Lights>', [3]);
  const eps = h.db.select().from(episodes).where(eq(episodes.seriesId, show)).all();
  for (const e of eps.slice(0, 2)) {
    const id = file(h.db, { mediaType: 'series', seriesId: show, dateAdded: ago(2), name: `e${e.episodeNumber}.mkv` });
    h.db.update(episodes).set({ episodeFileId: id }).where(eq(episodes.id, e.id)).run();
  }
  return h;
}

describe('Newsletter', () => {
  it('lists the week’s movies and episodes grouped per series, escaped in HTML', async () => {
    const h = await seeded();
    const n = new Newsletter({ db: h.db, now: () => NOW });
    const items = n.items(NOW.getTime() - 7 * DAY, 30);
    expect(items.map((i) => [i.title, i.detail])).toEqual([
      ['Fresh Movie', null],
      ['Harbour <Lights>', '2 new episodes (S01E01 - S01E02)'],
    ]);
    const r = n.render(items);
    expect(r.subject).toBe('New on Arclight this week: 1 movie, 1 show');
    expect(r.html).toContain('Harbour &lt;Lights&gt;');
    expect(r.html).not.toContain('<Lights>');
  });

  it('previews with problems until a connection is chosen', async () => {
    const h = await seeded();
    const n = new Newsletter({ db: h.db, now: () => NOW });
    const base = { enabled: true, notificationId: null, recipients: 'connection' as const, weekday: 5, hour: 9, maxItems: 30 };
    expect(n.preview(base).problem).toBe('choose an email connection');
    const id = emailConnection(h.db);
    expect(n.preview({ ...base, notificationId: id })).toMatchObject({ problem: null, recipients: 2, to: 'family@example.com', from: 'arclight@example.com' });
  });

  it('sends a multipart message to the connection or Bcc to users, and logs every run', async () => {
    const h = await seeded();
    const smtp = fakeSmtp();
    const n = new Newsletter({ db: h.db, now: () => NOW, connect: smtp.connect });
    const id = emailConnection(h.db);
    const settings = { enabled: true, notificationId: id, recipients: 'connection' as const, weekday: 5, hour: 9, maxItems: 30 };
    const run = await n.send(settings, 'scheduled');
    expect(run).toMatchObject({ recipients: 2, items: 2, error: null, trigger: 'scheduled' });
    const all = smtp.written.join('');
    expect(all).toContain('RCPT TO:<family@example.com>');
    expect(all).toContain('RCPT TO:<hidden@example.com>');
    expect(all).toContain('Content-Type: multipart/alternative');
    expect(all).not.toContain('hidden@example.com>\r\nTo:');
    expect(n.lastScheduled()).toBe(NOW.toISOString());

    // Users: every user with an email, except those who opted out; nobody in To.
    addUser(h.db, { username: 'reader', email: 'reader@example.com' });
    addUser(h.db, { username: 'quiet', email: 'quiet@example.com', settings: { newsletterOptOut: true } });
    const smtp2 = fakeSmtp();
    const n2 = new Newsletter({ db: h.db, now: () => NOW, connect: smtp2.connect });
    await n2.send({ ...settings, recipients: 'users' }, 'manual');
    const sent = smtp2.written.join('');
    expect(sent).toContain('RCPT TO:<reader@example.com>');
    expect(sent).not.toContain('quiet@example.com');
    expect(sent).toContain('To: undisclosed-recipients:;');

    // A refused recipient fails the run, which is logged with the error.
    const n3 = new Newsletter({ db: h.db, now: () => new Date(NOW.getTime() + DAY), connect: fakeSmtp('RCPT').connect });
    await expect(n3.send(settings, 'scheduled')).rejects.toThrow(/550/);
    expect(n3.runs()[0]).toMatchObject({ error: expect.stringContaining('550') });
    // The failed run is not "the last scheduled send".
    expect(n3.lastScheduled()).toBe(NOW.toISOString());
  });
});

describe('newsletterDue', () => {
  const s = { enabled: true, weekday: 5, hour: 9 };
  const friday9 = new Date(2026, 10, 6, 9, 5);
  it('is due in its weekday and hour once a week', () => {
    expect(newsletterDue(friday9, s, null)).toBe(true);
    expect(newsletterDue(friday9, { ...s, enabled: false }, null)).toBe(false);
    expect(newsletterDue(new Date(2026, 10, 6, 10, 5), s, null)).toBe(false);
    expect(newsletterDue(new Date(2026, 10, 5, 9, 5), s, null)).toBe(false);
    expect(newsletterDue(friday9, s, new Date(2026, 10, 6, 9, 0).toISOString())).toBe(false);
    expect(newsletterDue(friday9, s, new Date(2026, 9, 30, 9, 5).toISOString())).toBe(true);
  });
});
