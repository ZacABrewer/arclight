import type { NotificationEvent } from '@arclight/notifications';
import type { QuietHoursSettings } from '@arclight/shared';

// Quiet hours: a daily window (server local time) in which non-urgent alerts are held for the
// connections that respect it. A window whose end is earlier than its start runs past midnight
// and belongs to the day it starts on.

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether `at` (read in the server's local time zone) falls inside quiet hours. */
export function isQuietAt(settings: QuietHoursSettings, at: Date): boolean {
  if (!settings.enabled || settings.days.length === 0) return false;
  const start = minutesOf(settings.start);
  const end = minutesOf(settings.end);
  if (start === end) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  const startsOn = (d: number) => settings.days.includes(d);
  if (start < end) return startsOn(day) && minutes >= start && minutes < end;
  return (startsOn(day) && minutes >= start) || (startsOn((day + 6) % 7) && minutes < end);
}

/** Events that never wait for quiet hours to end. */
export function bypassesQuietHours(event: NotificationEvent): boolean {
  return event.urgent === true || event.type === 'test' || event.type === 'heldAlerts';
}
