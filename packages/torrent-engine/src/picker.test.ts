import { describe, expect, it } from 'vitest';
import { Bitfield } from './bitfield.js';
import type { TorrentFileEntry } from './metainfo.js';
import { BLOCK_SIZE } from './peer/messages.js';
import { ALL_PIECES, bitfieldPieces, PiecePicker } from './picker.js';
import { PieceLayout } from './storage/layout.js';

const PIECE = BLOCK_SIZE * 2;

function setup(pieces = 10, opts: ConstructorParameters<typeof PiecePicker>[2] = {}, files?: TorrentFileEntry[]) {
  const total = pieces * PIECE;
  const f = files ?? [{ index: 0, path: 'x', pathSegments: ['x'], length: total, offset: 0, padding: false }];
  const layout = new PieceLayout(f, PIECE, total);
  const have = new Bitfield(layout.pieceCount);
  let seed = 0;
  const picker = new PiecePicker(layout, have, { random: () => seed++ % 1000, ...opts });
  return { layout, have, picker };
}

function bf(n: number, set: number[]): Bitfield {
  const b = new Bitfield(n);
  for (const i of set) b.set(i);
  return b;
}

describe('PiecePicker', () => {
  it('picks rarest pieces first once past the random phase', () => {
    const { have, picker } = setup(6, { randomFirstPieces: 0 });
    picker.addPeer(bf(6, [0, 1, 2, 3, 4, 5]));
    picker.addPeer(bf(6, [0, 1, 2, 4, 5]));
    picker.addPeer(bf(6, [0, 1, 2, 5]));
    const blocks = picker.pick(ALL_PIECES, 'p', 2);
    expect(blocks.map((b) => b.index)).toEqual([3, 3]);
    expect(blocks.map((b) => b.begin)).toEqual([0, BLOCK_SIZE]);
    expect(picker.pick(ALL_PIECES, 'p', 2).map((b) => b.index)).toEqual([4, 4]);
    expect(have.count()).toBe(0);
  });

  it('randomises the first pieces', () => {
    const picks = new Set<number>();
    for (let s = 0; s < 20; s++) {
      const { picker, layout } = setup(20);
      let n = s * 7919;
      const p = new PiecePicker(layout, new Bitfield(20), { random: () => (n = (n * 1103515245 + 12345) % 2 ** 31) });
      void picker;
      picks.add(p.pick(ALL_PIECES, 'x', 1)[0]!.index);
    }
    expect(picks.size).toBeGreaterThan(3);
  });

  it('supports sequential mode', () => {
    const { picker } = setup(5, { sequential: true });
    expect(picker.pick(ALL_PIECES, 'p', 6).map((b) => b.index)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('only picks pieces the peer has and finishes partial pieces first', () => {
    const { picker } = setup(4, { randomFirstPieces: 0 });
    const peerA = bitfieldPieces(bf(4, [2]));
    expect(picker.pick(peerA, 'a', 1)).toEqual([{ index: 2, begin: 0, length: BLOCK_SIZE }]);
    const peerB = bitfieldPieces(bf(4, [1, 2]));
    // b should continue piece 2 before starting piece 1
    expect(picker.pick(peerB, 'b', 1)).toEqual([{ index: 2, begin: BLOCK_SIZE, length: BLOCK_SIZE }]);
    expect(picker.pick(bitfieldPieces(bf(4, [])), 'c', 5)).toEqual([]);
  });

  it('respects file priorities and skips unwanted pieces', () => {
    const files: TorrentFileEntry[] = [
      { index: 0, path: 'a', pathSegments: ['a'], length: PIECE * 2, offset: 0, padding: false },
      { index: 1, path: 'b', pathSegments: ['b'], length: PIECE * 2, offset: PIECE * 2, padding: false },
      { index: 2, path: 'c', pathSegments: ['c'], length: PIECE * 2, offset: PIECE * 4, padding: false },
    ];
    const { picker } = setup(6, { randomFirstPieces: 0 }, files);
    picker.setFilePriorities([0, 1, 7]);
    expect(picker.isWanted(0)).toBe(false);
    expect(picker.wantedRemaining).toBe(4);
    expect(picker.wantedBytesLeft()).toBe(4 * PIECE);
    const picked = picker.pick(ALL_PIECES, 'p', 8).map((b) => b.index);
    expect(picked.slice(0, 4).every((i) => i >= 4)).toBe(true);
    expect(picked.every((i) => i >= 2)).toBe(true);
    expect(picker.isInteresting(bitfieldPieces(bf(6, [0, 1])))).toBe(false);
    expect(picker.isInteresting(bitfieldPieces(bf(6, [5])))).toBe(true);
  });

  it('tracks received blocks, completes pieces and handles failures', () => {
    const { picker, have } = setup(2);
    const blocks = picker.pick(ALL_PIECES, 'p', 2);
    const i = blocks[0]!.index;
    expect(picker.markReceived(i, 0, 'p').pieceComplete).toBe(false);
    expect(picker.markReceived(i, 0, 'p').pieceComplete).toBe(false); // duplicate ignored
    expect(picker.markReceived(i, BLOCK_SIZE, 'p').pieceComplete).toBe(true);
    picker.pieceFailed(i);
    expect(picker.pick(ALL_PIECES, 'p', 2).every((b) => b.index === i)).toBe(true);
    for (const b of [0, BLOCK_SIZE]) picker.markReceived(i, b, 'p');
    have.set(i);
    picker.pieceVerified(i);
    expect(picker.isWanted(i)).toBe(false);
    expect(picker.inFlightPieces()).toBe(0);
  });

  it('releases dropped requests so other peers can take them', () => {
    const { picker } = setup(1);
    expect(picker.pick(ALL_PIECES, 'a', 2)).toHaveLength(2);
    expect(picker.isEndgame()).toBe(true);
    picker.release(0, 0, 'a');
    expect(picker.isEndgame()).toBe(false);
    expect(picker.pick(ALL_PIECES, 'b', 1)).toEqual([{ index: 0, begin: 0, length: BLOCK_SIZE }]);
    picker.releasePeer('a');
    expect(picker.pick(ALL_PIECES, 'c', 1)).toEqual([{ index: 0, begin: BLOCK_SIZE, length: BLOCK_SIZE }]);
  });

  it('duplicates outstanding blocks in endgame and reports peers to cancel', () => {
    const { picker } = setup(1, { endgameDuplicates: 2 });
    picker.pick(ALL_PIECES, 'a', 2);
    const dup = picker.pick(ALL_PIECES, 'b', 5);
    expect(dup).toHaveLength(2);
    expect(picker.pick(ALL_PIECES, 'c', 5)).toHaveLength(0); // already 2 requesters each
    const r = picker.markReceived(0, 0, 'b');
    expect(r.cancelFrom).toEqual(['a']);
  });

  it('expires stale requests', () => {
    let now = 0;
    const { picker } = setup(1, { requestTimeoutMs: 1000, now: () => now });
    picker.pick(ALL_PIECES, 'a', 2);
    now = 500;
    expect(picker.expire()).toEqual([]);
    now = 2000;
    expect(picker.expire().map((e) => e.peer)).toEqual(['a', 'a']);
    expect(picker.pick(ALL_PIECES, 'b', 2)).toHaveLength(2);
  });

  it('tracks availability including seeds and distributed copies', () => {
    const { picker } = setup(4);
    const a = bf(4, [0, 1]);
    picker.addPeer(a);
    picker.addSeed();
    picker.addHave(3);
    expect(picker.availabilityOf(0)).toBe(2);
    expect(picker.availabilityOf(2)).toBe(1);
    expect(picker.availabilityOf(3)).toBe(2);
    expect(picker.distributedCopies()).toBeCloseTo(1.75);
    picker.removePeer(a);
    picker.removeSeed();
    expect(picker.availabilityOf(0)).toBe(0);
  });
});
