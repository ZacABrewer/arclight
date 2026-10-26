import { randomBytes } from 'node:crypto';

export const ID_BITS = 160;
const MAX_ID = (1n << BigInt(ID_BITS)) - 1n;

export function idToBigInt(id: Buffer): bigint {
  return BigInt(`0x${id.toString('hex') || '0'}`);
}

export function bigIntToId(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(40, '0'), 'hex');
}

export function distance(a: Buffer, b: Buffer): bigint {
  return idToBigInt(a) ^ idToBigInt(b);
}

export function randomNodeId(): Buffer {
  return randomBytes(20);
}

/** Random id in [min, max). */
export function randomIdInRange(min: bigint, max: bigint): Buffer {
  const span = max - min;
  const r = idToBigInt(randomBytes(20)) % span;
  return bigIntToId(min + r);
}

export interface DhtNode {
  id: Buffer;
  host: string;
  port: number;
  lastSeen: number;
  /** Consecutive unanswered queries. */
  failures: number;
}

interface Bucket {
  min: bigint;
  max: bigint;
  nodes: DhtNode[];
  lastChanged: number;
}

export type InsertResult =
  | { status: 'added' | 'updated' }
  /** Bucket full of good nodes: `oldest` is the least recently seen one, worth a ping. */
  | { status: 'full'; oldest: DhtNode };

/** BEP 5 routing table: buckets of K nodes; only the bucket containing our own id splits. */
export class RoutingTable {
  private buckets: Bucket[];
  private readonly self: bigint;

  constructor(
    readonly selfId: Buffer,
    readonly k = 8,
    private readonly now: () => number = Date.now,
    /** Nodes with at least this many failures are replaced first. */
    private readonly badFailures = 2,
  ) {
    this.self = idToBigInt(selfId);
    this.buckets = [{ min: 0n, max: MAX_ID + 1n, nodes: [], lastChanged: now() }];
  }

  get size(): number {
    return this.buckets.reduce((n, b) => n + b.nodes.length, 0);
  }

  get bucketCount(): number {
    return this.buckets.length;
  }

  private bucketFor(id: bigint): Bucket {
    for (const b of this.buckets) if (id >= b.min && id < b.max) return b;
    throw new Error('id outside table range');
  }

  private split(b: Bucket): void {
    const mid = b.min + (b.max - b.min) / 2n;
    const lo: Bucket = { min: b.min, max: mid, nodes: [], lastChanged: b.lastChanged };
    const hi: Bucket = { min: mid, max: b.max, nodes: [], lastChanged: b.lastChanged };
    for (const n of b.nodes) (idToBigInt(n.id) < mid ? lo : hi).nodes.push(n);
    const idx = this.buckets.indexOf(b);
    this.buckets.splice(idx, 1, lo, hi);
  }

  get(id: Buffer): DhtNode | undefined {
    return this.bucketFor(idToBigInt(id)).nodes.find((n) => n.id.equals(id));
  }

  insert(node: { id: Buffer; host: string; port: number }): InsertResult {
    const nid = idToBigInt(node.id);
    if (nid === this.self || node.id.length !== 20) return { status: 'updated' };
    for (;;) {
      const b = this.bucketFor(nid);
      const existing = b.nodes.find((n) => n.id.equals(node.id));
      if (existing) {
        existing.host = node.host;
        existing.port = node.port;
        existing.lastSeen = this.now();
        existing.failures = 0;
        b.lastChanged = this.now();
        return { status: 'updated' };
      }
      const entry: DhtNode = { ...node, lastSeen: this.now(), failures: 0 };
      if (b.nodes.length < this.k) {
        b.nodes.push(entry);
        b.lastChanged = this.now();
        return { status: 'added' };
      }
      const bad = b.nodes.findIndex((n) => n.failures >= this.badFailures);
      if (bad >= 0) {
        b.nodes.splice(bad, 1, entry);
        b.lastChanged = this.now();
        return { status: 'added' };
      }
      if (this.self >= b.min && this.self < b.max && b.max - b.min > 1n) {
        this.split(b);
        continue;
      }
      const oldest = b.nodes.reduce((a, c) => (c.lastSeen < a.lastSeen ? c : a));
      return { status: 'full', oldest };
    }
  }

  /** Records a query timeout for a node. */
  markFailed(id: Buffer): void {
    const n = this.get(id);
    if (n) n.failures++;
  }

  remove(id: Buffer): void {
    const b = this.bucketFor(idToBigInt(id));
    b.nodes = b.nodes.filter((n) => !n.id.equals(id));
  }

  /** The `count` nodes closest to `target` by XOR distance, excluding bad ones when possible. */
  closest(target: Buffer, count = this.k): DhtNode[] {
    const t = idToBigInt(target);
    return this.all()
      .filter((n) => n.failures < this.badFailures)
      .map((n) => ({ n, d: idToBigInt(n.id) ^ t }))
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
      .slice(0, count)
      .map((x) => x.n);
  }

  all(): DhtNode[] {
    return this.buckets.flatMap((b) => b.nodes);
  }

  /** Random target ids for buckets that have not changed within `maxAgeMs`. */
  staleBucketTargets(maxAgeMs: number): Buffer[] {
    const now = this.now();
    return this.buckets.filter((b) => now - b.lastChanged >= maxAgeMs).map((b) => randomIdInRange(b.min, b.max));
  }

  touchBucket(target: Buffer): void {
    this.bucketFor(idToBigInt(target)).lastChanged = this.now();
  }
}
