import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTORY_FILTER, historyQuery } from '../../api/history.js';
import { historyFilterFromSearch, parseHistorySearch } from './history-search.js';

describe('history deep links', () => {
  it('keeps known event types and positive ids only', () => {
    expect(parseHistorySearch({ eventType: 'grabbed', episodeId: '12', seriesId: 3, movieId: 'x' })).toEqual({ eventType: 'grabbed', episodeId: 12, seriesId: 3 });
    expect(parseHistorySearch({ eventType: 'nonsense', seriesId: 0, episodeId: -4 })).toEqual({});
    expect(parseHistorySearch({})).toEqual({});
  });

  it('turns a deep link into the page filter and the GET /history query', () => {
    const filter = historyFilterFromSearch({ eventType: 'grabbed', episodeId: 12 });
    expect(filter).toEqual({ ...DEFAULT_HISTORY_FILTER, eventTypes: ['grabbed'], episodeId: 12 });
    expect(historyQuery(filter)).toEqual({ page: 1, pageSize: 25, sortKey: 'date', sortDirection: 'desc', eventType: 'grabbed', episodeId: 12 });
    expect(historyFilterFromSearch({})).toEqual(DEFAULT_HISTORY_FILTER);
  });
});
