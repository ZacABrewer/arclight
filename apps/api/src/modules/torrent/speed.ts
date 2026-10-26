import type { SpeedScheduleRange, TorrentSlowModeState, TorrentSpeedMode, TorrentSpeedSettings } from '@arclight/shared';

// Normal vs alternative ("slow mode") limits of the built-in engine. Pure: the service feeds in
// the stored sections and the clock, and applies the result to the Session.
//
// The schedule is a set of weekly windows in server-local time. Each window is placed on a
// minute-of-week axis (0 = Sunday 00:00, 10080 minutes per week); a window whose end is at or
// before its start runs past midnight, and one that spills past Saturday wraps to Sunday.

const DAY = 1440;
const WEEK = 7 * DAY;

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minute of the week of a local time. */
function minuteOfWeek(at: Date): number {
  return at.getDay() * DAY + at.getHours() * 60 + at.getMinutes();
}

/** [start, end) intervals on the minute-of-week axis; `end` may exceed WEEK (wraps). */
function intervals(ranges: readonly SpeedScheduleRange[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    const s = minutes(r.start);
    let e = minutes(r.end);
    if (e <= s) e += DAY;
    for (const d of new Set(r.days)) out.push([d * DAY + s, d * DAY + e]);
  }
  return out;
}

function activeAt(spans: Array<[number, number]>, mow: number): boolean {
  return spans.some(([s, e]) => (mow >= s && mow < e) || (mow + WEEK >= s && mow + WEEK < e));
}

/** Whether `at` (local time) falls inside one of the windows. */
export function scheduleActive(ranges: readonly SpeedScheduleRange[], at: Date): boolean {
  return activeAt(intervals(ranges), minuteOfWeek(at));
}

/**
 * The next time (minute precision, local) the schedule switches between active and inactive,
 * or null when it never does (no windows, or windows covering the whole week).
 */
export function nextScheduleChange(ranges: readonly SpeedScheduleRange[], at: Date): Date | null {
  const spans = intervals(ranges);
  if (spans.length === 0) return null;
  const now = minuteOfWeek(at);
  const current = activeAt(spans, now);
  const deltas = new Set<number>();
  for (const [s, e] of spans) {
    for (const edge of [s % WEEK, e % WEEK]) deltas.add(((edge - now + WEEK) % WEEK) || WEEK);
  }
  for (const delta of [...deltas].sort((a, b) => a - b)) {
    if (activeAt(spans, (now + delta) % WEEK) !== current) {
      const next = new Date(at);
      next.setSeconds(0, 0);
      next.setMinutes(next.getMinutes() + delta);
      return next;
    }
  }
  return null;
}

/** Slow mode with an end time in the past counts as off. */
export function slowModeOn(slow: TorrentSlowModeState, at: Date): boolean {
  return slow.enabled && (slow.until === null || Date.parse(slow.until) > at.getTime());
}

/** The limits to apply now: manual slow mode first, then the schedule, else the normal limits. */
export function speedMode(
  speed: TorrentSpeedSettings,
  slow: TorrentSlowModeState,
  normal: { downloadLimitKbps: number; uploadLimitKbps: number },
  at: Date,
): TorrentSpeedMode {
  const manual = slowModeOn(slow, at);
  const scheduled = speed.scheduleEnabled && scheduleActive(speed.schedule, at);
  const reason = manual ? 'manual' : scheduled ? 'schedule' : null;
  const kbps = reason ? { down: speed.altDownloadLimitKbps, up: speed.altUploadLimitKbps } : { down: normal.downloadLimitKbps, up: normal.uploadLimitKbps };
  const out: TorrentSpeedMode = {
    mode: reason ? 'alternative' : 'normal',
    reason,
    slowMode: manual,
    slowModeUntil: manual ? slow.until : null,
    downloadLimit: kbps.down * 1024,
    uploadLimit: kbps.up * 1024,
  };
  const next = speed.scheduleEnabled ? nextScheduleChange(speed.schedule, at) : null;
  if (next) out.nextChange = next.toISOString();
  return out;
}
