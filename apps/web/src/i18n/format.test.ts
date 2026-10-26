import { afterEach, describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatList,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  hourLabel,
  monthNames,
  setLocale,
  weekdayNames,
} from './index.js';
import { formatSize, relativeTime } from '../lib/format.js';

const at = new Date(2026, 9, 6, 21, 5);

afterEach(async () => {
  await setLocale('en');
});

describe('locale-aware formatting', () => {
  it('formats numbers, decimals and percentages per locale', () => {
    expect(formatNumber(12345.6, {}, 'en')).toBe('12,345.6');
    expect(formatNumber(12345.6, {}, 'de')).toBe('12.345,6');
    expect(formatDecimal(1.25, 1, 'en')).toBe((1.25).toFixed(1));
    expect(formatDecimal(1.5, 1, 'fr')).toBe('1,5');
    expect(formatPercent(0.684, 0, 'en')).toBe('68%');
    expect(formatNumber(null)).toBe('—');
  });

  it('formats bytes in binary or decimal units', () => {
    expect(formatBytes(0, {}, 'en')).toBe('0 B');
    expect(formatBytes(1536, {}, 'en')).toBe('1.5 KiB');
    expect(formatBytes(1536, {}, 'de')).toBe('1,5 KiB');
    expect(formatBytes(1_600_000_000, { binary: false }, 'en')).toBe('1.6 GB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('formats durations as their two largest units', () => {
    expect(formatDuration(450, 'en')).toBe('450 ms');
    expect(formatDuration(12_000, 'en')).toBe('12s');
    expect(formatDuration((3 * 86_400 + 7 * 3600) * 1000, 'en')).toBe('3d 7h');
    expect(formatDuration((2 * 3600 + 5 * 60) * 1000, 'en')).toBe('2h 5m');
  });

  it('formats relative times and lists in the locale', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(formatRelative(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(formatRelative(now + 2 * 86_400_000, now, 'en')).toBe('in 2 days');
    expect(formatRelative(now - 86_400_000, now, 'de')).toBe('gestern');
    expect(formatList(['A', 'B', 'C'], 'conjunction', 'en')).toBe('A, B, and C');
    expect(formatList(['A', 'B', 'C'], 'conjunction', 'de')).toBe('A, B und C');
  });

  it('starts weeks on the preferred first day', () => {
    expect(weekdayNames(1, 'short', 'en')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayNames(0, 'short', 'en')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayNames(1, 'long', 'de')[0]).toBe('Montag');
    expect(monthNames('long', 'fr')[9]).toBe('octobre');
  });

  it('honours the date format and 12/24-hour preferences in any locale', () => {
    expect(formatDate(at, { dateFormat: 'YYYY-MM-DD' }, 'de')).toBe('2026-10-06');
    expect(formatDate(at, { dateFormat: 'D MMM YYYY' }, 'en')).toBe('6 Oct 2026');
    expect(formatDate(at, { dateFormat: 'D MMM YYYY' }, 'de')).toMatch(/^6 Okt\.? 2026$/);
    expect(formatTime(at, { timeFormat: '24h' }, 'fr')).toBe('21:05');
    expect(formatTime(at, { timeFormat: '12h' }, 'en')).toBe('9:05 PM');
    expect(formatTime(at, { timeFormat: '12h' }, 'es')).toMatch(/^9:05 p\.?\s?m\.?$/i);
    expect(formatDateTime(at, { dateFormat: 'DD/MM/YYYY', timeFormat: '12h' }, 'en')).toBe('06/10/2026 9:05 PM');
    expect(hourLabel(9, '12h', 'en')).toBe('9 AM');
  });

  it('keeps the existing English mono formats and localises the decimal separator', async () => {
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toBe('2m ago');
    await setLocale('de');
    expect(formatSize(1536)).toBe('1,5 KiB');
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toBe('[de] 2m ago');
  });
});
