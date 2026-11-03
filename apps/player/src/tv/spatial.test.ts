import { describe, expect, it } from 'vitest';
import { directionOf, isBeyond, pickNext, score, type Box } from './spatial';

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
