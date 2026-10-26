import { describe, expect, it } from 'vitest';
import { DecisionLogBatch, type DecisionLogEntry } from '@arclight/shared';
import { batchCounts, decisionRowState, decisionSourceLabel, grabHistorySearch, orderDecisions, pageCount, rejectionTone } from './decisions-model.js';
import { makeBatch, makeDecision } from './fixtures.js';

describe('decision log model', () => {
  it('fixtures parse with the shared contract', () => {
    expect(() => DecisionLogBatch.parse(makeBatch())).not.toThrow();
  });

  it('orders rows by rank, unranked last, then approved and score', () => {
    const rows: DecisionLogEntry[] = [
      makeDecision({ id: 1, rank: null, approved: false, score: 500 }),
      makeDecision({ id: 2, rank: 2 }),
      makeDecision({ id: 3, rank: 1 }),
      makeDecision({ id: 4, rank: null, approved: true, score: 10 }),
      makeDecision({ id: 5, rank: null, approved: true, score: 90 }),
    ];
    expect(orderDecisions(rows).map((r) => r.id)).toEqual([3, 2, 5, 4, 1]);
  });

  it('marks the grabbed row, the winner and the rest', () => {
    expect(decisionRowState({ id: 1, chosen: true, approved: true }, 1)).toBe('grabbed');
    expect(decisionRowState({ id: 2, chosen: false, approved: true }, 2)).toBe('winner');
    expect(decisionRowState({ id: 3, chosen: false, approved: true }, 2)).toBe('approved');
    expect(decisionRowState({ id: 4, chosen: false, approved: false }, null)).toBe('rejected');
  });

  it('tones rejections by type and labels sources and counts', () => {
    expect(rejectionTone({ type: 'temporary' })).toBe('warn');
    expect(rejectionTone({ type: 'permanent' })).toBe('danger');
    expect(decisionSourceLabel('rss')).toBe('RSS sync');
    expect(decisionSourceLabel('pending')).toBe('Pending re-check');
    expect(decisionSourceLabel('somethingNew')).toBe('somethingNew');
    expect(batchCounts({ total: 1, approved: 1 })).toBe('1 release · 1 approved · 0 rejected');
    expect(batchCounts({ total: 24, approved: 3 })).toBe('24 releases · 3 approved · 21 rejected');
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(21, 10)).toBe(3);
  });

  it('points "View grab in History" at the grabbed item', () => {
    const grabbed = makeBatch();
    expect(grabHistorySearch({ ...grabbed, grabbed: false }, { seriesId: 1 })).toBeNull();
    expect(grabHistorySearch(grabbed, { episodeId: 12 })).toEqual({ eventType: 'grabbed', episodeId: 12 });
    expect(grabHistorySearch(grabbed, { movieId: 7 })).toEqual({ eventType: 'grabbed', movieId: 7 });
    // Series scope: the chosen row covers exactly one episode → narrow to it.
    expect(grabHistorySearch(grabbed, { seriesId: 1 })).toEqual({ eventType: 'grabbed', episodeId: 12 });
    // A season pack covers several episodes → the whole series.
    const pack = makeBatch({ decisions: [makeDecision({ id: 1, chosen: true, episodeIds: [12, 13] })] });
    expect(grabHistorySearch(pack, { seriesId: 1 })).toEqual({ eventType: 'grabbed', seriesId: 1 });
  });
});
