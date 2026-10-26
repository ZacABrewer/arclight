import { randomInt } from 'node:crypto';
import type { Bitfield } from './bitfield.js';
import { BLOCK_SIZE } from './peer/messages.js';
import type { PieceLayout } from './storage/layout.js';

export interface PickedBlock {
  index: number;
  begin: number;
  length: number;
}

export interface PickerOptions {
  /** Pick this many first pieces at random (to get something to trade quickly). Default 4. */
  randomFirstPieces?: number;
  sequential?: boolean;
  /** Max peers a block may be requested from simultaneously in endgame (default 2). */
  endgameDuplicates?: number;
  /** In-flight request timeout used by `expire` (default 30 s). */
  requestTimeoutMs?: number;
  now?: () => number;
  random?: (max: number) => number;
}

interface PartialPiece {
  /** 0 free, 1 requested, 2 received. */
  state: Uint8Array;
  requesters: Map<number, Map<string, number>>;
  received: number;
}

/** What a peer has, as the picker needs it. */
export interface PeerPieces {
  has(i: number): boolean;
}

export function bitfieldPieces(bf: Bitfield): PeerPieces {
  return { has: (i) => bf.get(i) };
}

export const ALL_PIECES: PeerPieces = { has: () => true };

/**
 * Piece and block selection: rarest-first (random among the first few pieces), optional
 * sequential mode, file-priority aware, with in-flight tracking and endgame duplicates.
 */
export class PiecePicker {
  private readonly availability: Uint32Array;
  private seeds = 0;
  private readonly priority: Uint8Array;
  private readonly partial = new Map<number, PartialPiece>();
  sequential: boolean;
  private readonly now: () => number;
  private readonly random: (max: number) => number;

  constructor(
    private readonly layout: PieceLayout,
    private readonly have: Bitfield,
    private readonly opts: PickerOptions = {},
  ) {
    this.availability = new Uint32Array(layout.pieceCount);
    this.priority = new Uint8Array(layout.pieceCount).fill(1);
    this.sequential = opts.sequential ?? false;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? ((max) => randomInt(0, Math.max(1, max)));
  }

  // ---- availability -------------------------------------------------------------------------

  addPeer(bf: Bitfield): void {
    for (const i of bf.indices()) this.availability[i] = (this.availability[i] ?? 0) + 1;
  }

  removePeer(bf: Bitfield): void {
    for (const i of bf.indices()) this.availability[i] = Math.max(0, (this.availability[i] ?? 0) - 1);
  }

  addHave(i: number): void {
    if (i >= 0 && i < this.availability.length) this.availability[i] = (this.availability[i] ?? 0) + 1;
  }

  /** Seeds (have-all peers) are counted once instead of per piece. */
  addSeed(): void {
    this.seeds++;
  }

  removeSeed(): void {
    this.seeds = Math.max(0, this.seeds - 1);
  }

  availabilityOf(i: number): number {
    return (this.availability[i] ?? 0) + this.seeds;
  }

  /** Average copies of the torrent in the connected swarm (distributed copies). */
  distributedCopies(): number {
    let min = Infinity;
    for (let i = 0; i < this.availability.length; i++) min = Math.min(min, this.availabilityOf(i));
    if (!Number.isFinite(min)) return 0;
    const above = [...this.availability.keys()].filter((i) => this.availabilityOf(i) > min).length;
    return min + above / Math.max(1, this.availability.length);
  }

  // ---- priorities -----------------------------------------------------------------------------

  /** Piece priority = highest priority among the files it touches (0 = not wanted). */
  setFilePriorities(priorities: readonly number[]): void {
    for (let i = 0; i < this.layout.pieceCount; i++) {
      let p = 0;
      for (const s of this.layout.pieceSpans(i)) if (!s.file.padding) p = Math.max(p, priorities[s.file.index] ?? 1);
      this.priority[i] = p;
    }
  }

  piecePriority(i: number): number {
    return this.priority[i] ?? 0;
  }

  isWanted(i: number): boolean {
    return (this.priority[i] ?? 0) > 0 && !this.have.get(i);
  }

  /** Wanted pieces we do not have yet. */
  get wantedRemaining(): number {
    let n = 0;
    for (let i = 0; i < this.layout.pieceCount; i++) if (this.isWanted(i)) n++;
    return n;
  }

  /** Bytes of wanted pieces still missing. */
  wantedBytesLeft(): number {
    let n = 0;
    for (let i = 0; i < this.layout.pieceCount; i++) if (this.isWanted(i)) n += this.layout.pieceSize(i);
    return n;
  }

  /** True when the peer has at least one piece we want. */
  isInteresting(peer: PeerPieces): boolean {
    for (let i = 0; i < this.layout.pieceCount; i++) if (this.isWanted(i) && peer.has(i)) return true;
    return false;
  }

  // ---- selection ----------------------------------------------------------------------------

  private partialFor(i: number): PartialPiece {
    let p = this.partial.get(i);
    if (!p) {
      p = { state: new Uint8Array(this.layout.blocksInPiece(i)), requesters: new Map(), received: 0 };
      this.partial.set(i, p);
    }
    return p;
  }

  private takeBlock(i: number, p: PartialPiece, b: number, peer: string, out: PickedBlock[]): void {
    p.state[b] = 1;
    let r = p.requesters.get(b);
    if (!r) {
      r = new Map();
      p.requesters.set(b, r);
    }
    r.set(peer, this.now());
    out.push({ index: i, begin: b * BLOCK_SIZE, length: this.layout.blockSize(i, b) });
  }

  private fillFromPiece(i: number, peer: string, count: number, out: PickedBlock[]): void {
    const p = this.partialFor(i);
    for (let b = 0; b < p.state.length && out.length < count; b++) if (p.state[b] === 0) this.takeBlock(i, p, b, peer, out);
  }

  /** Returns up to `count` blocks to request from `peer`. */
  pick(peerHas: PeerPieces, peer: string, count: number): PickedBlock[] {
    const out: PickedBlock[] = [];
    if (count <= 0) return out;
    // 1. Finish partial pieces first (highest priority, then most complete).
    const partials = [...this.partial.entries()]
      .filter(([i]) => this.isWanted(i) && peerHas.has(i))
      .sort(([a, pa], [b, pb]) => this.piecePriority(b) - this.piecePriority(a) || (this.sequential ? a - b : pb.received - pa.received));
    for (const [i] of partials) {
      if (out.length >= count) return out;
      this.fillFromPiece(i, peer, count, out);
    }
    // 2. Start new pieces.
    if (out.length < count) {
      const candidates: number[] = [];
      for (let i = 0; i < this.layout.pieceCount; i++) if (this.isWanted(i) && !this.partial.has(i) && peerHas.has(i)) candidates.push(i);
      const randomPhase = !this.sequential && this.have.count() < (this.opts.randomFirstPieces ?? 4);
      const keyed = candidates.map((i) => ({ i, r: this.random(1 << 30) }));
      keyed.sort((a, b) => {
        const pr = this.piecePriority(b.i) - this.piecePriority(a.i);
        if (pr !== 0) return pr;
        if (this.sequential) return a.i - b.i;
        if (randomPhase) return a.r - b.r;
        return this.availabilityOf(a.i) - this.availabilityOf(b.i) || a.r - b.r;
      });
      for (const { i } of keyed) {
        if (out.length >= count) break;
        this.fillFromPiece(i, peer, count, out);
      }
    }
    // 3. Endgame: everything is requested; duplicate outstanding blocks.
    if (out.length < count && this.isEndgame()) {
      const dup = this.opts.endgameDuplicates ?? 2;
      for (const [i, p] of this.partial) {
        if (out.length >= count) break;
        if (!this.isWanted(i) || !peerHas.has(i)) continue;
        for (let b = 0; b < p.state.length && out.length < count; b++) {
          if (p.state[b] !== 1) continue;
          const r = p.requesters.get(b);
          if (!r || r.has(peer) || r.size >= dup) continue;
          this.takeBlock(i, p, b, peer, out);
        }
      }
    }
    return out;
  }

  /** No free block remains in any wanted piece (all are requested or received). */
  isEndgame(): boolean {
    for (let i = 0; i < this.layout.pieceCount; i++) {
      if (!this.isWanted(i)) continue;
      const p = this.partial.get(i);
      if (!p) return false;
      for (const s of p.state) if (s === 0) return false;
    }
    return true;
  }

  /**
   * Records a received block. Returns whether the piece now has every block, and the other
   * peers that still have this block outstanding (send them a cancel).
   */
  markReceived(index: number, begin: number, peer: string): { pieceComplete: boolean; cancelFrom: string[] } {
    const p = this.partial.get(index);
    const b = Math.floor(begin / BLOCK_SIZE);
    if (!p || b >= p.state.length || p.state[b] === 2) return { pieceComplete: false, cancelFrom: [] };
    p.state[b] = 2;
    p.received++;
    const others = [...(p.requesters.get(b)?.keys() ?? [])].filter((x) => x !== peer);
    p.requesters.delete(b);
    return { pieceComplete: p.received === p.state.length, cancelFrom: others };
  }

  /** A request was dropped (choke, reject, timeout, disconnect): make the block available again. */
  release(index: number, begin: number, peer: string): void {
    const p = this.partial.get(index);
    const b = Math.floor(begin / BLOCK_SIZE);
    if (!p || p.state[b] !== 1) return;
    const r = p.requesters.get(b);
    r?.delete(peer);
    if (!r || r.size === 0) {
      p.requesters.delete(b);
      p.state[b] = 0;
    }
  }

  /** Releases every outstanding block of a peer. */
  releasePeer(peer: string): void {
    for (const [i, p] of this.partial) for (const [b, r] of p.requesters) if (r.has(peer)) this.release(i, b * BLOCK_SIZE, peer);
  }

  /** Releases requests older than the timeout and returns them so connections can be cleaned. */
  expire(): { index: number; begin: number; peer: string }[] {
    const limit = this.now() - (this.opts.requestTimeoutMs ?? 30_000);
    const out: { index: number; begin: number; peer: string }[] = [];
    for (const [i, p] of this.partial)
      for (const [b, r] of p.requesters) for (const [peer, at] of r) if (at < limit) out.push({ index: i, begin: b * BLOCK_SIZE, peer });
    for (const e of out) this.release(e.index, e.begin, e.peer);
    return out;
  }

  pieceVerified(i: number): void {
    this.partial.delete(i);
  }

  /** Hash check failed: every block must be downloaded again. */
  pieceFailed(i: number): void {
    this.partial.delete(i);
  }

  inFlightPieces(): number {
    return this.partial.size;
  }
}
