import type { ProgressBeacon } from '@arclight/shared';
import { ApiError, appPlaybackApi, PROGRESS_BATCH_MAX, type Target } from '../core/api';
import { preferencesStore, readJson, writeJson, type KeyValueStore } from '../core/kv';

// Progress reports that could not be sent (offline, server down, app closing). They are kept per
// account in Preferences and sent later in one POST /playback/progress/batch; the server applies
// them oldest first and ignores any older than what it already has, so replaying is safe.

const KEY = 'arclight.progress-queue';
/** Oldest reports are dropped past this many per account (weeks of offline listening). */
export const QUEUE_LIMIT = 2000;

interface Stored {
  version: 1;
  byAccount: Record<string, ProgressBeacon[]>;
}

export type TargetLookup = (accountId: string) => Promise<Target | null>;

export interface FlushResult {
  sent: number;
  kept: number;
  dropped: number;
}

export class ProgressQueue {
  private state: Stored = { version: 1, byAccount: {} };
  private loaded: Promise<void> | null = null;
  private flushing: Promise<FlushResult> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore = preferencesStore) {}

  private load(): Promise<void> {
    this.loaded ??= readJson<Stored>(this.kv, KEY).then((s) => {
      if (s && s.version === 1 && s.byAccount && typeof s.byAccount === 'object') this.state = s;
    });
    return this.loaded;
  }

  /** Serialises writes so concurrent enqueues never lose one another. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private save(): Promise<void> {
    return writeJson(this.kv, KEY, this.state);
  }

  async enqueue(accountId: string, report: ProgressBeacon): Promise<void> {
    await this.load();
    await this.locked(async () => {
      const list = this.state.byAccount[accountId] ?? [];
      // Only the newest report per item matters when the server already has an older row, but a
      // 'stopped'/'ended' event must survive, so keep everything and only coalesce ticks.
      const last = list[list.length - 1];
      if (last && last.itemKey === report.itemKey && last.event === 'progress' && report.event === 'progress') list[list.length - 1] = report;
      else list.push(report);
      if (list.length > QUEUE_LIMIT) list.splice(0, list.length - QUEUE_LIMIT);
      this.state.byAccount[accountId] = list;
      await this.save();
    });
  }

  async size(accountId?: string): Promise<number> {
    await this.load();
    if (accountId) return this.state.byAccount[accountId]?.length ?? 0;
    return Object.values(this.state.byAccount).reduce((n, l) => n + l.length, 0);
  }

  async pending(accountId: string): Promise<ProgressBeacon[]> {
    await this.load();
    return [...(this.state.byAccount[accountId] ?? [])];
  }

  /** Forget an account's reports (signed out). */
  async clear(accountId: string): Promise<void> {
    await this.load();
    await this.locked(async () => {
      delete this.state.byAccount[accountId];
      await this.save();
    });
  }

  /** Sends everything queued. One flush at a time; a second call joins the running one. */
  flush(lookup: TargetLookup): Promise<FlushResult> {
    this.flushing ??= this.doFlush(lookup).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(lookup: TargetLookup): Promise<FlushResult> {
    await this.load();
    const result: FlushResult = { sent: 0, kept: 0, dropped: 0 };
    for (const accountId of Object.keys(this.state.byAccount)) {
      const target = await lookup(accountId);
      const snapshot = [...(this.state.byAccount[accountId] ?? [])];
      if (!target) {
        // The account is gone: nothing can send these any more.
        if (snapshot.length) await this.removeFirst(accountId, snapshot.length);
        result.dropped += snapshot.length;
        continue;
      }
      let offset = 0;
      while (offset < snapshot.length) {
        const batch = snapshot.slice(offset, offset + PROGRESS_BATCH_MAX);
        const outcome = await this.send(batch, target);
        if (outcome === 'retry') {
          result.kept += snapshot.length - offset;
          break;
        }
        await this.removeFirst(accountId, batch.length);
        if (outcome === 'sent') result.sent += batch.length;
        else result.dropped += batch.length;
        offset += batch.length;
      }
    }
    return result;
  }

  /** 'sent', 'dropped' (the server refused them for good), or 'retry' (try again later). */
  private async send(batch: ProgressBeacon[], target: Target): Promise<'sent' | 'dropped' | 'retry'> {
    try {
      await appPlaybackApi.progressBatch(batch, target);
      return 'sent';
    } catch (err) {
      if (!(err instanceof ApiError)) return 'retry';
      if (err.status === 0 || err.status === 429 || err.status >= 500) return 'retry';
      // Signed out / device removed: keep them; signing in again (same account id) sends them.
      if (err.status === 401) return 'retry';
      if (err.status === 404 || err.status === 405) return this.sendOneByOne(batch, target);
      return 'dropped';
    }
  }

  /** Servers without the batch endpoint: the single-report PUT, in order. */
  private async sendOneByOne(batch: ProgressBeacon[], target: Target): Promise<'sent' | 'retry'> {
    for (const r of batch) {
      const { itemKey, ...report } = r;
      try {
        await appPlaybackApi.report(itemKey, report, target);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.status === 429 || err.status === 401) return 'retry';
      }
    }
    return 'sent';
  }

  private removeFirst(accountId: string, n: number): Promise<void> {
    return this.locked(async () => {
      const list = this.state.byAccount[accountId] ?? [];
      list.splice(0, n);
      if (list.length) this.state.byAccount[accountId] = list;
      else delete this.state.byAccount[accountId];
      await this.save();
    });
  }
}
