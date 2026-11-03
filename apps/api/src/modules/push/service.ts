import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  ARCLIGHT_GITHUB_SLUG,
  Permission,
  PushPreferences,
  type PushPayload,
  type PushSubscriptionInput,
  type PushSubscriptionResource,
  type PushTestResult,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings, users } from '../../db/schema.js';
// Until src/db/schema.ts re-exports it, the module reads its own table directly.
import { pushSubscriptions } from './schema.js';
import { generateVapidKeys, sendWebPush, type EncryptOptions, type VapidKeys } from './webpush.js';

// Browser notifications: VAPID keys (settings section `push`, generated once), per-user
// subscriptions and per-user preferences (`users.settings.notifications.push`).

export const PUSH_SECTION = 'push';
export const DEFAULT_PUSH_SUBJECT = `https://github.com/${ARCLIGHT_GITHUB_SLUG}`;

export const PushSection = z.object({
  vapidPublicKey: z.string(),
  vapidPrivateKey: z.string(),
  /** VAPID `sub`: a mailto: or https: contact for push service operators. */
  subject: z.string().default(DEFAULT_PUSH_SUBJECT),
});
export type PushSection = z.infer<typeof PushSection>;

export type PushKind = keyof PushPreferences;

/** Constant-time string comparison. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class PushError extends Error {
  constructor(
    readonly code: 'NO_USER' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/**
 * Another delivery channel for the same notifications (the mobile app via the push relay).
 * Called by notify() once the user's preference allowed the event; must not throw or block.
 */
export interface PushSink {
  deliver(userId: number, payload: PushPayload): Promise<unknown>;
}

export interface PushServiceOptions {
  db: Db;
  log?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Test seam for deterministic encryption. */
  encrypt?: EncryptOptions;
}

type SubscriptionRow = typeof pushSubscriptions.$inferSelect;

function toResource(row: SubscriptionRow): PushSubscriptionResource {
  return { id: row.id, endpoint: row.endpoint, createdAt: row.createdAt, ...(row.userAgent ? { userAgent: row.userAgent } : {}) };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Body text longer than this is cut; keeps every payload well inside one 4 KiB record. */
const MAX_BODY_CHARS = 600;

export class PushService {
  private readonly sinks = new Set<PushSink>();

  constructor(private readonly opts: PushServiceOptions) {}

  /** Register another channel for notify(); returns the function that removes it. */
  addSink(sink: PushSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // ---- VAPID keys --------------------------------------------------------------------

  /** The stored keys, generating and storing a pair on first use. */
  section(): PushSection {
    const { db } = this.opts;
    const row = db.select().from(settings).where(eq(settings.key, PUSH_SECTION)).get();
    const parsed = PushSection.safeParse(row?.value ?? null);
    if (parsed.success) return parsed.data;
    const keys = generateVapidKeys();
    const value: PushSection = { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, subject: DEFAULT_PUSH_SUBJECT };
    const now = this.now().toISOString();
    db.insert(settings)
      .values({ key: PUSH_SECTION, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
    this.opts.log?.info('generated VAPID keys for browser notifications');
    return value;
  }

  vapidKeys(): VapidKeys {
    const s = this.section();
    return { publicKey: s.vapidPublicKey, privateKey: s.vapidPrivateKey };
  }

  publicKey(): string {
    return this.section().vapidPublicKey;
  }

  // ---- subscriptions -----------------------------------------------------------------

  list(userId: number): PushSubscriptionResource[] {
    return this.opts.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).orderBy(pushSubscriptions.id).all().map(toResource);
  }

  /**
   * Upsert by endpoint: a browser that re-subscribes (or changes user) keeps one row. Moving a row
   * to another user needs the browser's own keys (the same subscription re-sent after a sign-in
   * as someone else) or an admin; knowing only the endpoint gets CONFLICT.
   */
  subscribe(userId: number, input: PushSubscriptionInput, opts: { isAdmin?: boolean } = {}): PushSubscriptionResource {
    const { db } = this.opts;
    const existing = db.select({ userId: pushSubscriptions.userId, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint)).get();
    if (existing && existing.userId !== userId && !opts.isAdmin && !(sameSecret(existing.p256dh, input.keys.p256dh) && sameSecret(existing.auth, input.keys.auth))) {
      throw new PushError('CONFLICT', 'this push subscription belongs to another account');
    }
    const values = {
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
      createdAt: this.now().toISOString(),
    };
    const row = db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId, p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent },
      })
      .returning()
      .get();
    return toResource(row);
  }

  /** Remove the user's subscription for `endpoint`; false when there was none. */
  unsubscribe(userId: number, endpoint: string): boolean {
    const deleted = this.opts.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
      .returning()
      .all();
    return deleted.length > 0;
  }

  // ---- preferences -------------------------------------------------------------------

  preferences(userId: number): PushPreferences {
    const row = this.opts.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get();
    if (!row) throw new PushError('NOT_FOUND', `user ${userId} not found`);
    const parsed = PushPreferences.safeParse(asRecord(asRecord(row.settings)['notifications'])['push'] ?? {});
    return parsed.success ? parsed.data : PushPreferences.parse({});
  }

  /** Writes `settings.notifications.push`, leaving every other key as it is. */
  setPreferences(userId: number, prefs: PushPreferences): PushPreferences {
    const { db } = this.opts;
    const row = db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get();
    if (!row) throw new PushError('NOT_FOUND', `user ${userId} not found`);
    const value = PushPreferences.parse(prefs);
    const current = asRecord(row.settings);
    const next = { ...current, notifications: { ...asRecord(current['notifications']), push: value } };
    db.update(users).set({ settings: next, updatedAt: this.now().toISOString() }).where(eq(users.id, userId)).run();
    return value;
  }

  // ---- sending -----------------------------------------------------------------------

  /** Send `payload` to every browser of `userId`. Gone subscriptions (404/410) are deleted. */
  async sendPush(userId: number, payload: PushPayload): Promise<PushTestResult> {
    const { db } = this.opts;
    const rows = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
    const result: PushTestResult = { sent: 0, failed: 0, removed: 0 };
    if (rows.length === 0) return result;
    const body = payload.body && payload.body.length > MAX_BODY_CHARS ? `${payload.body.slice(0, MAX_BODY_CHARS - 1)}…` : payload.body;
    const json = JSON.stringify({ ...payload, ...(body !== undefined ? { body } : {}) });
    const section = this.section();
    const vapid = { publicKey: section.vapidPublicKey, privateKey: section.vapidPrivateKey };
    await Promise.all(
      rows.map(async (row) => {
        try {
          const res = await sendWebPush(row, json, {
            vapid,
            subject: section.subject,
            ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
            ...(this.opts.now ? { now: this.opts.now } : {}),
            ...(this.opts.encrypt ? { encrypt: this.opts.encrypt } : {}),
          });
          if (res.ok) {
            result.sent += 1;
          } else if (res.gone) {
            db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
            result.removed += 1;
          } else {
            result.failed += 1;
            this.opts.log?.warn({ status: res.status, message: res.message, endpoint: new URL(row.endpoint).host }, 'push delivery failed');
          }
        } catch (err) {
          result.failed += 1;
          this.opts.log?.warn({ err, subscription: row.id }, 'push delivery failed');
        }
      }),
    );
    return result;
  }

  /** `sendPush` gated by the user's preference for `kind`; the same payload also goes to every sink (mobile app). */
  async notify(userId: number, kind: PushKind, payload: PushPayload): Promise<PushTestResult | null> {
    let prefs: PushPreferences;
    try {
      prefs = this.preferences(userId);
    } catch {
      return null;
    }
    if (!prefs[kind]) return null;
    for (const sink of this.sinks) {
      // Fire and forget: a slow relay must never hold up browser pushes or the caller.
      void Promise.resolve()
        .then(() => sink.deliver(userId, payload))
        .catch((err: unknown) => this.opts.log?.warn({ err }, 'push sink delivery failed'));
    }
    return this.sendPush(userId, payload);
  }

  /** Users holding any of `permissions` (role admin or the ADMIN bit always qualifies). */
  managers(permissions: number): number[] {
    return this.opts.db
      .select({ id: users.id, role: users.role, permissions: users.permissions })
      .from(users)
      .all()
      .filter((u) => u.role === 'admin' || (u.permissions & (Permission.ADMIN | permissions)) !== 0)
      .map((u) => u.id);
  }
}
