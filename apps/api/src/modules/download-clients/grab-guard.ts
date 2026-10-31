import { hashFromMagnet, hashFromTorrentFile } from '@arclight/download-clients';

// Keeps grabs from repeating themselves (in memory: both guards are about minutes, not days):
//
// * Re-grab cool-down. After Arclight removes a download from its client (replace, queue
//   removal, remove after import) or the client stops reporting it, the same release (its
//   info-hash, else its indexer guid) is not sent again for `REGRAB_COOLDOWN_MS`. The client may
//   still be deleting the old files: a re-add to the same folder would have its new files
//   deleted under it (qBittorrent then reports `missingFiles`). And "Try another release"
//   without the blocklist must not get the same release back from its own search.
// * Add loop guard. More than `ADD_LIMIT` adds of one release to one client within
//   `ADD_WINDOW_MS` means something keeps re-sending it; further adds are held, with a back-off
//   that doubles while it goes on (`ADD_BACKOFF_MS` up to `ADD_BACKOFF_MAX_MS`).

export const REGRAB_COOLDOWN_MS = 30 * 60_000;
export const ADD_LIMIT = 3;
export const ADD_WINDOW_MS = 60 * 60_000;
export const ADD_BACKOFF_MS = 15 * 60_000;
export const ADD_BACKOFF_MAX_MS = 6 * 60 * 60_000;

const HEX_HASH = /^[0-9a-f]{40}$/;

export interface GrabHold {
  /** Epoch ms when the release may be sent again. */
  until: number;
  /** Why, for messages: "replaced", "no longer reported by qBittorrent", ... */
  reason: string;
}

export interface AddHold {
  until: number;
  /** Adds within the window so far. */
  count: number;
  /** True when this call started the hold (log it once, not on every refused add). */
  started: boolean;
}

function hashKey(hash: string | undefined | null): string | null {
  const h = hash?.trim().toLowerCase();
  return h && HEX_HASH.test(h) ? `hash:${h}` : null;
}

/**
 * Keys of a release as the guards know it: `hash:<info-hash>` and `guid:<indexer>:<guid>`.
 * `downloadId` is the client's id of a tracked download (the info-hash for torrent clients).
 */
export function releaseKeys(grabbedRelease: unknown, downloadId?: string): string[] {
  const keys = new Set<string>();
  const fromId = hashKey(downloadId);
  if (fromId) keys.add(fromId);
  if (grabbedRelease && typeof grabbedRelease === 'object') {
    const r = grabbedRelease as { infoHash?: unknown; guid?: unknown; indexerId?: unknown };
    const fromRelease = typeof r.infoHash === 'string' ? hashKey(r.infoHash) : null;
    if (fromRelease) keys.add(fromRelease);
    if (typeof r.guid === 'string' && r.guid !== '') keys.add(`guid:${typeof r.indexerId === 'number' ? r.indexerId : 0}:${r.guid}`);
  }
  return [...keys];
}

/** The info-hash of a torrent grab's payload, when it has a readable one. */
export async function payloadHash(payload: { magnet?: string; torrentFile?: Uint8Array }): Promise<string | undefined> {
  try {
    if (payload.magnet) return hashFromMagnet(payload.magnet)?.toLowerCase();
    if (payload.torrentFile && payload.torrentFile.length > 0) return (await hashFromTorrentFile(payload.torrentFile)).toLowerCase();
  } catch {
    // An unreadable payload is the client's to refuse.
  }
  return undefined;
}

export class GrabGuard {
  private readonly cooldowns = new Map<string, GrabHold>();
  private readonly adds = new Map<string, { at: number[]; strikes: number; until: number }>();

  constructor(private readonly now: () => number) {}

  /** Starts (or extends) the re-grab cool-down of a release. */
  coolDown(keys: readonly string[], reason: string, ms: number = REGRAB_COOLDOWN_MS): void {
    const until = this.now() + ms;
    for (const key of keys) {
      const current = this.cooldowns.get(key);
      if (!current || current.until < until) this.cooldowns.set(key, { until, reason });
    }
  }

  /** The cool-down a release is in, if any. */
  coolingDown(keys: readonly string[]): GrabHold | null {
    const now = this.now();
    for (const [key, hold] of this.cooldowns) if (hold.until <= now) this.cooldowns.delete(key);
    for (const key of keys) {
      const hold = this.cooldowns.get(key);
      if (hold) return hold;
    }
    return null;
  }

  /** Counts an add of release `key` to client `clientId`; a hold when it must not be sent now. */
  admitAdd(clientId: number, key: string): AddHold | null {
    const now = this.now();
    const id = `${clientId}|${key}`;
    const entry = this.adds.get(id) ?? { at: [], strikes: 0, until: 0 };
    entry.at = entry.at.filter((t) => now - t < ADD_WINDOW_MS);
    // A quiet window forgets the back-off.
    if (entry.at.length === 0 && entry.until <= now) entry.strikes = 0;
    this.adds.set(id, entry);
    if (entry.until > now) return { until: entry.until, count: entry.at.length, started: false };
    if (entry.at.length >= ADD_LIMIT) {
      entry.strikes++;
      entry.until = now + Math.min(ADD_BACKOFF_MAX_MS, ADD_BACKOFF_MS * 2 ** (entry.strikes - 1));
      return { until: entry.until, count: entry.at.length, started: true };
    }
    entry.at.push(now);
    return null;
  }
}
