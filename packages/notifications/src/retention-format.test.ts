import { describe, expect, it } from 'vitest';
import { EVENT_LABELS, formatEvent, MESSAGE_EVENTS, type RetentionEvent } from './index.js';

const EVENT: RetentionEvent = {
  type: 'retention',
  instanceName: 'Arclight',
  applicationUrl: 'https://mt.example.com/',
  timestamp: '2026-10-26T03:30:00.000Z',
  staged: [
    {
      mediaType: 'movie',
      title: 'Harbour Lights',
      year: 2021,
      rule: 'Watched movies',
      action: 'deleteFiles',
      sizeBytes: 4_000_000_000,
      reasons: ['watched by all 2 users'],
      applyAfter: '2026-11-02T03:30:00.000Z',
    },
  ],
  applied: [{ mediaType: 'series', title: 'Signal Lost', rule: 'Old shows', action: 'deleteItem', sizeBytes: 10, reasons: [] }],
  failed: [{ mediaType: 'movie', title: 'Paper Moons', rule: 'Old', action: 'unmonitor', sizeBytes: 0, reasons: [], error: 'disk on fire' }],
  totalStaged: 3,
  totalApplied: 1,
  totalFailed: 1,
  freedBytes: 2_147_483_648,
};

describe('retention notification event', () => {
  it('is a message event with a label', () => {
    expect(MESSAGE_EVENTS.has('retention')).toBe(true);
    expect(EVENT_LABELS.retention).toBe('Retention Summary');
  });

  it('formats a summary with staged, applied and failed lists and a review link', () => {
    const f = formatEvent(EVENT);
    expect(f.subject).toBe('Retention Summary');
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('3 staged, 1 applied, 1 failed');
    const byName = Object.fromEntries(f.fields.map((x) => [x.name, x.value]));
    expect(byName['Staged']).toBe('Harbour Lights (2021) - Watched movies: delete files after 2026-11-02\n...and 2 more');
    expect(byName['Applied']).toBe('Signal Lost - Old shows: delete');
    expect(byName['Failed']).toContain('(disk on fire)');
    expect(byName['Freed']).toBeDefined();
    expect(f.link).toBe('https://mt.example.com/retention');
  });
});
