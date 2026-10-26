import { describe, expect, it } from 'vitest';
import { SeedingRulesSettings, TorrentSlowModeState, TorrentSpeedSettings, type SpeedScheduleRange } from '@arclight/shared';
import { nextScheduleChange, scheduleActive, slowModeOn, speedMode } from './speed.js';

// Local-time dates (new Date(y, m, d, h, min)) keep these independent of the host time zone.
// 2026-10-26 is a Monday (day 1).
const mon = (h: number, m = 0) => new Date(2026, 9, 26, h, m);
const sun = (h: number, m = 0) => new Date(2026, 9, 25, h, m);
const sat = (h: number, m = 0) => new Date(2026, 9, 31, h, m);

const weekdays: SpeedScheduleRange = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' };
const overnight: SpeedScheduleRange = { days: [6], start: '22:00', end: '06:00' };

describe('scheduleActive', () => {
  it('matches a window on its days only', () => {
    expect(scheduleActive([weekdays], mon(9))).toBe(true);
    expect(scheduleActive([weekdays], mon(17, 29))).toBe(true);
    expect(scheduleActive([weekdays], mon(17, 30))).toBe(false);
    expect(scheduleActive([weekdays], mon(8, 59))).toBe(false);
    expect(scheduleActive([weekdays], sun(12))).toBe(false);
  });

  it('runs past midnight and wraps from Saturday into Sunday', () => {
    expect(scheduleActive([overnight], sat(23))).toBe(true);
    expect(scheduleActive([overnight], sun(5, 59))).toBe(true);
    expect(scheduleActive([overnight], sun(6))).toBe(false);
    expect(scheduleActive([overnight], sat(21))).toBe(false);
  });

  it('treats equal start and end as a whole day', () => {
    expect(scheduleActive([{ days: [1], start: '00:00', end: '00:00' }], mon(13))).toBe(true);
  });
});

describe('nextScheduleChange', () => {
  it('finds the next edge in either direction', () => {
    expect(nextScheduleChange([weekdays], mon(8))?.getTime()).toBe(mon(9).getTime());
    expect(nextScheduleChange([weekdays], mon(10))?.getTime()).toBe(mon(17, 30).getTime());
    // Friday evening -> Monday morning
    expect(nextScheduleChange([weekdays], new Date(2026, 9, 30, 18))?.getTime()).toBe(new Date(2026, 10, 2, 9).getTime());
    expect(nextScheduleChange([overnight], sat(23))?.getTime()).toBe(new Date(2026, 10, 1, 6).getTime());
  });

  it('skips edges inside overlapping windows and returns null without changes', () => {
    const a: SpeedScheduleRange = { days: [1], start: '09:00', end: '12:00' };
    const b: SpeedScheduleRange = { days: [1], start: '11:00', end: '14:00' };
    expect(nextScheduleChange([a, b], mon(10))?.getTime()).toBe(mon(14).getTime());
    expect(nextScheduleChange([], mon(10))).toBeNull();
    expect(nextScheduleChange([{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' }], mon(10))).toBeNull();
  });
});

describe('speedMode', () => {
  const normal = { downloadLimitKbps: 0, uploadLimitKbps: 500 };
  const speed = TorrentSpeedSettings.parse({ altDownloadLimitKbps: 100, altUploadLimitKbps: 10, scheduleEnabled: true, schedule: [weekdays] });
  const off = TorrentSlowModeState.parse({});

  it('uses the normal limits outside the schedule and the alternative ones inside', () => {
    expect(speedMode(speed, off, normal, mon(8))).toMatchObject({ mode: 'normal', reason: null, downloadLimit: 0, uploadLimit: 500 * 1024 });
    expect(speedMode(speed, off, normal, mon(8)).nextChange).toBe(mon(9).toISOString());
    expect(speedMode(speed, off, normal, mon(10))).toMatchObject({ mode: 'alternative', reason: 'schedule', downloadLimit: 100 * 1024, uploadLimit: 10 * 1024 });
    expect(speedMode({ ...speed, scheduleEnabled: false }, off, normal, mon(10))).toMatchObject({ mode: 'normal' });
  });

  it('lets manual slow mode win until its end time', () => {
    const slow = { enabled: true, until: mon(12).toISOString() };
    expect(speedMode(speed, slow, normal, sun(10))).toMatchObject({ mode: 'alternative', reason: 'manual', slowMode: true, slowModeUntil: slow.until });
    expect(slowModeOn(slow, mon(12))).toBe(false);
    expect(speedMode({ ...speed, scheduleEnabled: false }, slow, normal, mon(13))).toMatchObject({ mode: 'normal', slowMode: false, slowModeUntil: null });
    expect(slowModeOn({ enabled: true, until: null }, mon(13))).toBe(true);
  });
});

describe('seeding rule contract', () => {
  it('fills defaults and needs a ratio or a seeding time', () => {
    const parsed = SeedingRulesSettings.parse({ rules: [{ id: 'a', name: 'TV', categories: ['tv'], ratio: 1 }] });
    expect(parsed.rules[0]).toMatchObject({ enabled: true, action: 'pause', deleteFiles: false, seedTimeMinutes: null, indexerIds: [], trackers: [] });
    expect(SeedingRulesSettings.safeParse({ rules: [{ id: 'a', name: 'TV' }] }).success).toBe(false);
  });
});
