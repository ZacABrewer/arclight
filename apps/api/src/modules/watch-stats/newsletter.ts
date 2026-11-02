import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { MediaImage, NewsletterItem, NewsletterPreview, NewsletterRun, WatchStatsSettings } from '@arclight/shared';
import { parseAgentSettings, sendMail, connectSmtp, type EmailSettings, type SmtpConnect } from '@arclight/notifications';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, notifications, series, users } from '../../db/schema.js';
import { escapeXml } from './card.js';
import { newsletterRuns } from './schema.js';

// The weekly "recently added" newsletter. It lists the movies and episodes whose files arrived
// in the last seven days and goes out through an email notification connection's SMTP server
// (the connection's own recipients, or Bcc to every active user with an email address).

const WEEK_MS = 7 * 24 * 60 * 60_000;

type NewsletterSettings = WatchStatsSettings['newsletter'];

export interface NewsletterOptions {
  db: Db;
  now: () => Date;
  connect?: SmtpConnect;
  instanceName?: string;
}

function poster(images: readonly MediaImage[] | null | undefined): string | null {
  const p = (images ?? []).find((i) => i.coverType === 'poster');
  if (!p) return null;
  if (p.remoteUrl) return p.remoteUrl;
  return /^https?:\/\//.test(p.url) ? p.url : null;
}

/** RFC 2047 "B" encoding for header values that are not plain ASCII. */
function encodeHeaderValue(value: string): string {
  if (!/[^ -~]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(base64: string): string {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

export class Newsletter {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly connect: SmtpConnect;
  private readonly instanceName: string;

  constructor(opts: NewsletterOptions) {
    this.db = opts.db;
    this.now = opts.now;
    this.connect = opts.connect ?? connectSmtp;
    this.instanceName = opts.instanceName ?? 'Arclight';
  }

  /** Movies and episodes (grouped per series) whose files were added since `sinceMs`. */
  items(sinceMs: number, maxItems: number): NewsletterItem[] {
    const since = new Date(sinceMs).toISOString();
    const movieRows = this.db
      .select({ id: movies.id, title: movies.title, year: movies.year, overview: movies.overview, images: movies.images, added: mediaFiles.dateAdded })
      .from(mediaFiles)
      .innerJoin(movies, eq(mediaFiles.movieId, movies.id))
      .where(and(eq(mediaFiles.mediaType, 'movie'), gte(mediaFiles.dateAdded, since)))
      .orderBy(desc(mediaFiles.dateAdded))
      .all();
    const seenMovies = new Set<number>();
    const out: NewsletterItem[] = [];
    for (const m of movieRows) {
      if (seenMovies.has(m.id) || seenMovies.size >= maxItems) continue;
      seenMovies.add(m.id);
      out.push({ mediaType: 'movie', title: m.title, year: m.year || null, detail: null, addedAt: m.added, posterUrl: poster(m.images), overview: m.overview });
    }

    const epRows = this.db
      .select({ seriesId: episodes.seriesId, season: episodes.seasonNumber, episode: episodes.episodeNumber, added: mediaFiles.dateAdded })
      .from(episodes)
      .innerJoin(mediaFiles, eq(episodes.episodeFileId, mediaFiles.id))
      .where(and(isNotNull(episodes.episodeFileId), gte(mediaFiles.dateAdded, since)))
      .orderBy(desc(mediaFiles.dateAdded))
      .all();
    const perSeries = new Map<number, { codes: string[]; added: string }>();
    for (const e of epRows) {
      const entry = perSeries.get(e.seriesId) ?? { codes: [], added: e.added };
      entry.codes.push(`S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`);
      perSeries.set(e.seriesId, entry);
    }
    const ids = [...perSeries.keys()].slice(0, maxItems);
    const seriesRows = ids.length
      ? this.db.select({ id: series.id, title: series.title, year: series.year, overview: series.overview, images: series.images }).from(series).where(inArray(series.id, ids)).all()
      : [];
    for (const s of seriesRows) {
      const entry = perSeries.get(s.id)!;
      const codes = [...new Set(entry.codes)].sort();
      const detail = codes.length === 1 ? codes[0]! : `${codes.length} new episodes (${codes[0]} - ${codes[codes.length - 1]})`;
      out.push({ mediaType: codes.length === 1 ? 'episode' : 'series', title: s.title, year: s.year || null, detail, addedAt: entry.added, posterUrl: poster(s.images), overview: s.overview });
    }
    return out.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }

  private connection(settings: NewsletterSettings): { problem: string | null; email: EmailSettings | null } {
    if (settings.notificationId === null) return { problem: 'choose an email connection', email: null };
    const row = this.db.select().from(notifications).where(eq(notifications.id, settings.notificationId)).get();
    if (!row) return { problem: 'the chosen email connection no longer exists', email: null };
    if (row.implementation !== 'email') return { problem: 'the chosen connection is not an email connection', email: null };
    try {
      return { problem: null, email: parseAgentSettings('email', row.settings) };
    } catch (err) {
      return { problem: `the email connection's settings are invalid: ${err instanceof Error ? err.message : String(err)}`, email: null };
    }
  }

  private recipients(settings: NewsletterSettings, email: EmailSettings): { to: string[]; bcc: string[] } {
    if (settings.recipients === 'connection') return { to: email.to, bcc: [...email.cc, ...email.bcc] };
    const addresses = this.db
      .select({ email: users.email, settings: users.settings })
      .from(users)
      .where(isNotNull(users.email))
      .all()
      // A user can opt out with the `newsletterOptOut` user setting.
      .filter((u) => (u.settings as Record<string, unknown> | null)?.['newsletterOptOut'] !== true)
      .flatMap((u) => (u.email && /^[^\s@]+@[^\s@]+$/.test(u.email) ? [u.email.trim()] : []));
    return { to: [], bcc: [...new Set(addresses)] };
  }

  render(items: NewsletterItem[]): { subject: string; html: string; text: string } {
    const movieCount = items.filter((i) => i.mediaType === 'movie').length;
    const showCount = items.length - movieCount;
    const parts: string[] = [];
    if (movieCount) parts.push(`${movieCount} ${movieCount === 1 ? 'movie' : 'movies'}`);
    if (showCount) parts.push(`${showCount} ${showCount === 1 ? 'show' : 'shows'}`);
    const subject = `New on ${this.instanceName} this week${parts.length ? `: ${parts.join(', ')}` : ''}`;
    const line = (i: NewsletterItem) => `${i.title}${i.year ? ` (${i.year})` : ''}${i.detail ? ` - ${i.detail}` : ''}`;
    const text = [
      `Recently added on ${this.instanceName}`,
      '',
      ...(movieCount ? ['Movies', ...items.filter((i) => i.mediaType === 'movie').map((i) => `  ${line(i)}`), ''] : []),
      ...(showCount ? ['Shows', ...items.filter((i) => i.mediaType !== 'movie').map((i) => `  ${line(i)}`), ''] : []),
      ...(items.length === 0 ? ['Nothing new this week.'] : []),
    ].join('\r\n');
    const card = (i: NewsletterItem) =>
      `<tr><td style="padding:8px 12px 8px 0;vertical-align:top;width:72px">${
        i.posterUrl ? `<img src="${escapeXml(i.posterUrl)}" width="64" alt="" style="border-radius:6px;display:block">` : ''
      }</td><td style="padding:8px 0;vertical-align:top"><strong>${escapeXml(i.title)}</strong>${i.year ? ` <span style="color:#667">(${i.year})</span>` : ''}${
        i.detail ? `<br><span style="color:#446">${escapeXml(i.detail)}</span>` : ''
      }${i.overview ? `<br><span style="color:#667;font-size:13px">${escapeXml(i.overview.length > 220 ? `${i.overview.slice(0, 219)}…` : i.overview)}</span>` : ''}</td></tr>`;
    const section = (title: string, list: NewsletterItem[]) => (list.length ? `<h2 style="font-size:18px;margin:24px 0 4px">${title}</h2><table role="presentation" cellspacing="0" cellpadding="0">${list.map(card).join('')}</table>` : '');
    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fa;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#112">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<h1 style="font-size:22px;margin:0">Recently added on ${escapeXml(this.instanceName)}</h1>
${section('Movies', items.filter((i) => i.mediaType === 'movie'))}${section('Shows', items.filter((i) => i.mediaType !== 'movie'))}${
      items.length === 0 ? '<p>Nothing new this week.</p>' : ''
    }
</div></body></html>`;
    return { subject, html, text };
  }

  preview(settings: NewsletterSettings): NewsletterPreview {
    const items = this.items(this.now().getTime() - WEEK_MS, settings.maxItems);
    const { subject, html, text } = this.render(items);
    const { problem, email } = this.connection(settings);
    const rcpt = email ? this.recipients(settings, email) : { to: [], bcc: [] };
    const count = rcpt.to.length + rcpt.bcc.length;
    return {
      subject,
      from: email?.from ?? '',
      to: rcpt.to.join(', '),
      items,
      html,
      text,
      recipients: count,
      problem: problem ?? (count === 0 ? 'no recipients' : null),
    };
  }

  /** RFC 5322 multipart/alternative message (text + HTML). */
  buildMessage(input: { from: string; to: string[]; subject: string; html: string; text: string }): string {
    const boundary = `arclight-${randomBytes(12).toString('hex')}`;
    const domain = input.from.split('@')[1] ?? 'arclight';
    const headers = [
      `From: ${encodeHeaderValue(this.instanceName)} <${input.from}>`,
      `To: ${input.to.length ? input.to.join(', ') : 'undisclosed-recipients:;'}`,
      `Subject: ${encodeHeaderValue(input.subject)}`,
      `Date: ${this.now().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      'X-Mailer: Arclight',
    ];
    const part = (type: string, body: string) =>
      [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(body, 'utf8').toString('base64'))].join('\r\n');
    return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', input.text)}\r\n${part('text/html', input.html)}\r\n--${boundary}--\r\n`;
  }

  /** Sends the newsletter now and logs the run. Throws when it cannot be sent. */
  async send(settings: NewsletterSettings, trigger: 'scheduled' | 'manual'): Promise<NewsletterRun> {
    const sentAt = this.now().toISOString();
    const log = (recipients: number, items: number, error: string | null): NewsletterRun =>
      this.db.insert(newsletterRuns).values({ sentAt, trigger, recipients, items, error }).returning().get();
    const { problem, email } = this.connection(settings);
    if (!email) {
      log(0, 0, problem);
      throw new Error(problem ?? 'no email connection');
    }
    const items = this.items(this.now().getTime() - WEEK_MS, settings.maxItems);
    const rcpt = this.recipients(settings, email);
    const all = [...new Set([...rcpt.to, ...rcpt.bcc])];
    if (all.length === 0) {
      log(0, items.length, 'no recipients');
      throw new Error('no recipients');
    }
    const { subject, html, text } = this.render(items);
    try {
      await sendMail(this.connect, {
        host: email.host,
        port: email.port,
        security: email.security,
        username: email.username,
        password: email.password,
        from: email.from,
        recipients: all,
        message: this.buildMessage({ from: email.from, to: rcpt.to, subject, html, text }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(all.length, items.length, message);
      throw err;
    }
    return log(all.length, items.length, null);
  }

  runs(limit = 10): NewsletterRun[] {
    return this.db.select().from(newsletterRuns).orderBy(desc(newsletterRuns.id)).limit(limit).all();
  }

  /** The last successful scheduled send. */
  lastScheduled(): string | null {
    return (
      this.db
        .select({ sentAt: newsletterRuns.sentAt })
        .from(newsletterRuns)
        .where(and(eq(newsletterRuns.trigger, 'scheduled'), isNull(newsletterRuns.error)))
        .orderBy(desc(newsletterRuns.id))
        .limit(1)
        .get()?.sentAt ?? null
    );
  }
}
