import { describe, expect, it } from 'vitest';
import { directionOf, isBeyond, pickNext, pickStage, score, stageScore, type Box } from './spatial';

const box = (left: number, top: number, w = 100, h = 60): Box => ({ left, top, right: left + w, bottom: top + h });

describe('spatial navigation geometry', () => {
  // A 3 x 2 grid of cards, 20px apart.
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 80), box(120, 80), box(240, 80)];

  it('moves along a row and down a column', () => {
    expect(pickNext(grid[0]!, grid, 'right')).toBe(1);
    expect(pickNext(grid[1]!, grid, 'right')).toBe(2);
    expect(pickNext(grid[1]!, grid, 'down')).toBe(4);
    expect(pickNext(grid[4]!, grid, 'up')).toBe(1);
    expect(pickNext(grid[5]!, grid, 'left')).toBe(4);
  });

  it('returns -1 at an edge', () => {
    expect(pickNext(grid[2]!, grid, 'right')).toBe(-1);
    expect(pickNext(grid[0]!, grid, 'up')).toBe(-1);
    expect(pickNext(grid[3]!, grid, 'left')).toBe(-1);
  });

  it('prefers a box in the same lane over a nearer one off to the side', () => {
    const origin = box(0, 0);
    const inLane = box(0, 200); // straight below, further away
    const offside = box(300, 70); // just below but far to the right
    expect(pickNext(origin, [offside, inLane], 'down')).toBe(1);
  });

  it('reaches a tall rail on the left from any row', () => {
    const rail = box(-90, 0, 60, 300);
    const card = box(0, 200);
    expect(pickNext(card, [rail, ...grid], 'left')).toBe(0);
  });

  it('ignores boxes that are not past the origin', () => {
    const origin = box(100, 100);
    expect(isBeyond(origin, box(100, 100), 'right')).toBe(false);
    expect(isBeyond(origin, box(50, 40, 300, 180), 'down')).toBe(false);
    expect(score(origin, box(90, 100), 'right')).toBe(Infinity);
  });

  it('maps arrow keys (and the old DPAD names) to directions', () => {
    expect(directionOf('ArrowUp')).toBe('up');
    expect(directionOf('Down')).toBe('down');
    expect(directionOf('ArrowLeft')).toBe('left');
    expect(directionOf('Right')).toBe('right');
    expect(directionOf('Enter')).toBeNull();
  });
});

describe('stage scoring (the design TV template)', () => {
  const HEADER = 72;
  const at = (b: Box, inHeader = false) => ({ box: b, inHeader });
  const cand = (b: Box, sameRow = true, inHeader = false) => ({ box: b, sameRow, inHeader });

  it('keeps left / right inside the row', () => {
    const o = at(box(0, 200));
    expect(stageScore(o, cand(box(120, 200), false), 'right', HEADER)).toBe(Infinity);
    expect(stageScore(o, cand(box(120, 200)), 'right', HEADER)).toBeLessThan(Infinity);
  });

  it('prefers the page over the header when moving up', () => {
    const o = at(box(100, 400));
    const page = cand(box(100, 200));
    const header = cand(box(100, 10, 60, 40), true, true);
    expect(pickStage(o, [header, page], 'up', HEADER)).toBe(1);
    // With nothing above in the page, the header is still reachable.
    expect(pickStage(at(box(100, 120)), [header], 'up', HEADER)).toBe(0);
  });

  it('down from the header skips anything still under it', () => {
    const o = at(box(100, 10, 60, 40), true);
    expect(stageScore(o, cand(box(100, 50, 100, 60)), 'down', HEADER)).toBe(Infinity);
    expect(pickStage(o, [cand(box(100, 50, 100, 60)), cand(box(100, 300))], 'down', HEADER)).toBe(1);
  });

  it('returns -1 with nothing that way', () => {
    expect(pickStage(at(box(0, 0)), [cand(box(0, 200))], 'up', HEADER)).toBe(-1);
  });
});
