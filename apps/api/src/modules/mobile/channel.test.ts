import { describe, expect, it } from 'vitest';
import { channelFor } from './service.js';

describe('channelFor', () => {
  it('maps push tags to the Android channels the app creates', () => {
    expect(channelFor('request-12')).toBe('requests');
    expect(channelFor('available-movie-3')).toBe('downloads');
    expect(channelFor('health-disk')).toBe('health');
    expect(channelFor('issue-4')).toBe('general');
    expect(channelFor(undefined)).toBe('general');
  });
});
