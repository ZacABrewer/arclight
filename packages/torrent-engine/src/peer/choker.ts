import { randomInt } from 'node:crypto';

export interface ChokerPeer {
  id: string;
  peerInterested: boolean;
  /** Bytes/s we receive from the peer. */
  downloadRate: number;
  /** Bytes/s we send to the peer. */
  uploadRate: number;
  snubbed: boolean;
  /** True when the peer has the whole torrent (it will never reciprocate). */
  isSeed: boolean;
  connectedAt: number;
}

export interface ChokerOptions {
  /** Total unchoke slots including the optimistic one (default 4). */
  uploadSlots?: number;
  /** Rotate the optimistic unchoke every N rechoke rounds (default 3 = 30 s at 10 s rounds). */
  optimisticRounds?: number;
  /** Peers connected less than this get 3x weight for the optimistic slot (default 60 s). */
  newPeerMs?: number;
  now?: () => number;
  random?: (max: number) => number;
}

/**
 * Tit-for-tat choker. Leeching: unchoke the best uploaders to us. Seeding: unchoke the
 * peers we upload to fastest (keeps pipes full). One extra optimistic slot rotates.
 */
export class Choker {
  private round = 0;
  private optimistic: string | null = null;
  private readonly slots: number;
  private readonly now: () => number;
  private readonly random: (max: number) => number;

  constructor(private readonly opts: ChokerOptions = {}) {
    this.slots = Math.max(1, opts.uploadSlots ?? 4);
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((max) => randomInt(0, max));
  }

  get optimisticPeer(): string | null {
    return this.optimistic;
  }

  /**
   * Returns the ids to unchoke. `rotate` advances the optimistic schedule (pass false for an
   * out-of-band recompute, e.g. when a peer just became interested).
   */
  run(peers: readonly ChokerPeer[], seeding: boolean, rotate = true): Set<string> {
    const candidates = peers.filter((p) => p.peerInterested && !(seeding && p.isSeed));
    const regular = candidates
      .filter((p) => !p.snubbed && !p.isSeed)
      .sort((a, b) => (seeding ? b.uploadRate - a.uploadRate : b.downloadRate - a.downloadRate) || a.connectedAt - b.connectedAt);
    const regularSlots = this.slots > 1 ? this.slots - 1 : this.slots;
    const unchoke = new Set(regular.slice(0, regularSlots).map((p) => p.id));

    if (rotate) this.round++;
    const stillValid = this.optimistic !== null && candidates.some((p) => p.id === this.optimistic) && !unchoke.has(this.optimistic);
    const due = rotate && this.round % (this.opts.optimisticRounds ?? 3) === 0;
    if (!stillValid || due) {
      const pool = candidates.filter((p) => !unchoke.has(p.id));
      this.optimistic = this.pickWeighted(pool);
    }
    if (this.optimistic) unchoke.add(this.optimistic);
    // Unused regular slots go to further interested peers so upload capacity is not wasted.
    for (const p of candidates) {
      if (unchoke.size >= this.slots) break;
      unchoke.add(p.id);
    }
    return unchoke;
  }

  private pickWeighted(pool: readonly ChokerPeer[]): string | null {
    if (pool.length === 0) return null;
    const newMs = this.opts.newPeerMs ?? 60_000;
    const now = this.now();
    const weights = pool.map((p) => (now - p.connectedAt < newMs ? 3 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.random(total);
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i] as number;
      if (r < 0) return (pool[i] as ChokerPeer).id;
    }
    return (pool[pool.length - 1] as ChokerPeer).id;
  }
}
