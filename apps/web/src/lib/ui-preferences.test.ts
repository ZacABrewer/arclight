import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFERENCES, formatDate, formatDateTime, formatTime, hourLabel, readUiPreferences } from './ui-preferences.js';

const at = new Date(2026, 9, 6, 21, 5);

describe('ui preferences', () => {
  it('reads settings with defaults for missing or invalid keys', () => {
    expect(readUiPreferences(undefined)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(readUiPreferences({ firstDayOfWeek: 0, timeFormat: '12h', dateFormat: 'DD/MM/YYYY', posterColumns: 9, locale: 'en' })).toEqual({
      firstDayOfWeek: 0,
      timeFormat: '12h',
      dateFormat: 'DD/MM/YYYY',
      posterColumns: 9,
      locale: 'en',
    });
    expect(readUiPreferences({ firstDayOfWeek: 3, timeFormat: 'x', dateFormat: 'nope', posterColumns: 42 })).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('formats dates in each pattern', () => {
    expect(formatDate(at, { dateFormat: 'YYYY-MM-DD' })).toBe('2026-10-06');
    expect(formatDate(at, { dateFormat: 'DD/MM/YYYY' })).toBe('06/10/2026');
    expect(formatDate(at, { dateFormat: 'MM/DD/YYYY' })).toBe('10/06/2026');
    expect(formatDate(at, { dateFormat: 'D MMM YYYY' })).toBe('6 Oct 2026');
    // Date-only strings are calendar dates, not instants.
    expect(formatDate('2026-01-02', { dateFormat: 'YYYY-MM-DD' })).toBe('2026-01-02');
    expect(formatDate(null, { dateFormat: 'YYYY-MM-DD' })).toBe('—');
    expect(formatDate('not a date', { dateFormat: 'YYYY-MM-DD' })).toBe('not a date');
  });

  it('formats times and date-times in 12h and 24h', () => {
    expect(formatTime(at, { timeFormat: '24h' })).toBe('21:05');
    expect(formatTime(at, { timeFormat: '12h' })).toBe('9:05 PM');
    expect(formatTime(new Date(2026, 0, 1, 0, 30), { timeFormat: '12h' })).toBe('12:30 AM');
    expect(formatDateTime(at, { dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })).toBe('2026-10-06 21:05');
    expect(formatDateTime(at.toISOString(), { dateFormat: 'MM/DD/YYYY', timeFormat: '12h' })).toBe('10/06/2026 9:05 PM');
    expect(hourLabel(0, '12h')).toBe('12 AM');
    expect(hourLabel(13, '12h')).toBe('1 PM');
    expect(hourLabel(9, '24h')).toBe('09:00');
  });
});
