import type { CalendarItem, CalendarReleaseKind } from '@arclight/shared';

// RFC 5545 iCalendar rendering. Lines end in CRLF, are folded at 75 octets, and TEXT values
// escape backslash, semicolon, comma and newlines.

const RELEASE_LABEL: Record<CalendarReleaseKind, string> = {
  cinema: 'In Cinemas',
  digital: 'Digital Release',
  physical: 'Physical Release',
};

const DEFAULT_EPISODE_MINUTES = 30;

export interface IcsOptions {
  /** DTSTAMP for every event; defaults to now. */
  now?: Date;
  calendarName?: string;
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line to at most 75 octets per physical line (continuations start with a space). */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function dateValue(value: string): string {
  return value.slice(0, 10).replace(/-/g, '');
}

function nextDay(value: string): string {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return dateValue(d.toISOString());
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function eventLines(item: CalendarItem, stamp: string): string[] {
  if (item.type === 'episode') {
    const ep = item.episode;
    const code = `S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
    const lines = [
      'BEGIN:VEVENT',
      `UID:arclight-episode-${ep.id}@arclight`,
      `DTSTAMP:${stamp}`,
    ];
    if (ep.airDateUtc) {
      const start = new Date(ep.airDateUtc);
      const minutes = ep.runtimeMinutes ?? item.series?.runtimeMinutes ?? DEFAULT_EPISODE_MINUTES;
      lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(new Date(start.getTime() + minutes * 60_000))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(item.date)}`, `DTEND;VALUE=DATE:${nextDay(item.date)}`);
    }
    lines.push(`SUMMARY:${escapeText(`${item.seriesTitle} - ${code} - ${ep.title}`)}`);
    if (ep.overview) lines.push(`DESCRIPTION:${escapeText(ep.overview)}`);
    if (item.series?.network) lines.push(`CATEGORIES:${escapeText(item.series.network)}`);
    lines.push(`STATUS:${ep.hasFile ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
    return lines;
  }
  const m = item.movie;
  const lines = [
    'BEGIN:VEVENT',
    `UID:arclight-movie-${m.id}-${item.releaseKind}@arclight`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateValue(item.date)}`,
    `DTEND;VALUE=DATE:${nextDay(item.date)}`,
    `SUMMARY:${escapeText(`${m.title} (${RELEASE_LABEL[item.releaseKind]})`)}`,
  ];
  if (m.overview) lines.push(`DESCRIPTION:${escapeText(m.overview)}`);
  if (m.studio) lines.push(`CATEGORIES:${escapeText(m.studio)}`);
  lines.push(`STATUS:${m.hasFile ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
  return lines;
}

export function renderIcs(items: CalendarItem[], options: IcsOptions = {}): string {
  const stamp = utcStamp(options.now ?? new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Arclight//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.calendarName ?? 'Arclight')}`,
    ...items.flatMap((item) => eventLines(item, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
