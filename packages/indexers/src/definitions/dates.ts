/**
 * Date handling for definition fields and filters (spec S6.1-S6.5). Every parser returns a
 * `Date`; filters render it with `toIsoString` (ISO-8601 UTC, second precision).
 * Zone-less inputs are interpreted in the definition's `timezone` (default UTC, S6.3).
 */

export interface DateContext {
  /** Epoch ms used as "now" for relative dates. */
  now: number;
  /** IANA zone for zone-less dates; default `UTC`. */
  timeZone?: string;
  /** Numeric `A/B/YYYY` is day-first when true (UK); default month-first (US). */
  dayFirst?: boolean;
}

export function toIsoString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function monthIndex(name: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower === 'sept') return 8;
  const i = MONTHS.indexOf(lower.slice(0, 3));
  return i >= 0 ? i : undefined;
}

// ---------------------------------------------------------------------------------------
// Time zones

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface Fields {
  year: number;
  month: number; // 0-based
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  ms?: number;
  /** Explicit offset in minutes east of UTC. */
  offsetMinutes?: number;
}

/** Wall-clock fields to a Date, honouring an explicit offset or else the context zone. */
function fromFields(f: Fields, ctx: DateContext): Date | undefined {
  if ((f.hour ?? 0) > 23 || (f.minute ?? 0) > 59 || (f.second ?? 0) > 60) return undefined;
  const wall = Date.UTC(f.year, f.month, f.day, f.hour ?? 0, f.minute ?? 0, f.second ?? 0, f.ms ?? 0);
  if (!Number.isFinite(wall)) return undefined;
  const check = new Date(wall);
  if (check.getUTCDate() !== f.day || check.getUTCMonth() !== f.month) return undefined;
  if (f.offsetMinutes !== undefined) return new Date(wall - f.offsetMinutes * 60_000);
  const tz = ctx.timeZone ?? 'UTC';
  if (tz === 'UTC' || tz === 'Etc/UTC') return check;
  const first = zoneOffset(wall, tz);
  let utc = wall - first;
  const second = zoneOffset(utc, tz);
  if (second !== first) utc = wall - second;
  return new Date(utc);
}

/** Calendar fields of an instant as seen in the context zone. */
function wallFields(ms: number, ctx: DateContext): Fields {
  const tz = ctx.timeZone ?? 'UTC';
  const shifted = new Date(tz === 'UTC' ? ms : ms + zoneOffset(ms, tz));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

// ---------------------------------------------------------------------------------------
// Go reference-time layouts (S6.2)

type LayoutToken = { kind: 'literal'; text: string } | { kind: 'space' } | { kind: 'field'; token: string };

const GO_TOKENS = [
  'January', 'Monday', 'Jan', 'Mon', 'MST', '2006', 'Z07:00', 'Z0700', 'Z07', '-07:00', '-0700', '-07',
  '06', '01', '02', '_2', '15', '03', '04', '05', 'PM', 'pm', '1', '2', '3', '4', '5',
];

const layoutCache = new Map<string, LayoutToken[]>();

function compileLayout(layout: string): LayoutToken[] {
  const cached = layoutCache.get(layout);
  if (cached) return cached;
  const tokens: LayoutToken[] = [];
  let i = 0;
  outer: while (i < layout.length) {
    const ch = layout[i] ?? '';
    if (/\s/.test(ch)) {
      while (i < layout.length && /\s/.test(layout[i] ?? '')) i++;
      tokens.push({ kind: 'space' });
      continue;
    }
    const frac = /^[.,](0+|9+)(?!\d)/.exec(layout.slice(i));
    if (frac && tokens.length > 0) {
      tokens.push({ kind: 'field', token: frac[1]?.startsWith('9') ? '.9' : '.0' });
      i += frac[0].length;
      continue;
    }
    for (const t of GO_TOKENS) {
      if (layout.startsWith(t, i)) {
        tokens.push({ kind: 'field', token: t });
        i += t.length;
        continue outer;
      }
    }
    tokens.push({ kind: 'literal', text: ch });
    i++;
  }
  layoutCache.set(layout, tokens);
  return tokens;
}

/** Parse `value` with a Go layout; undefined when it does not fit. */
export function parseGoLayout(value: string, layout: string, ctx: DateContext): Date | undefined {
  const tokens = compileLayout(layout);
  const s = value.trim();
  let pos = 0;
  const f: Partial<Fields> & { pm?: boolean } = {};

  const digits = (min: number, max: number): number | undefined => {
    let end = pos;
    while (end < s.length && end - pos < max && s.charCodeAt(end) >= 48 && s.charCodeAt(end) <= 57) end++;
    if (end - pos < min) return undefined;
    const n = Number(s.slice(pos, end));
    pos = end;
    return n;
  };
  const word = (): string | undefined => {
    const m = /^[A-Za-z]+/.exec(s.slice(pos));
    if (!m) return undefined;
    pos += m[0].length;
    return m[0];
  };
  const zone = (allowZ: boolean): boolean => {
    const rest = s.slice(pos);
    if (allowZ && /^Z/i.test(rest)) {
      pos += 1;
      f.offsetMinutes = 0;
      return true;
    }
    const m = /^([+-])(\d{2}):?(\d{2})?/.exec(rest);
    if (!m) return false;
    pos += m[0].length;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
    f.offsetMinutes = m[1] === '-' ? -minutes : minutes;
    return true;
  };

  for (const t of tokens) {
    if (t.kind === 'space') {
      while (pos < s.length && /\s/.test(s[pos] ?? '')) pos++;
      continue;
    }
    if (t.kind === 'literal') {
      if ((s[pos] ?? '').toLowerCase() !== t.text.toLowerCase()) return undefined;
      pos++;
      continue;
    }
    let n: number | undefined;
    switch (t.token) {
      case '2006':
        if ((n = digits(4, 4)) === undefined) return undefined;
        f.year = n;
        break;
      case '06':
        if ((n = digits(2, 2)) === undefined) return undefined;
        f.year = n + (n < 70 ? 2000 : 1900);
        break;
      case 'January':
      case 'Jan': {
        const w = word();
        const m = w === undefined ? undefined : monthIndex(w);
        if (m === undefined) return undefined;
        f.month = m;
        break;
      }
      case 'Monday':
      case 'Mon': {
        const w = word();
        if (w === undefined || !WEEKDAYS.includes(w.slice(0, 3).toLowerCase())) return undefined;
        break;
      }
      case '01':
      case '1':
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.month = n - 1;
        break;
      case '02':
      case '2':
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.day = n;
        break;
      case '_2':
        while (s[pos] === ' ') pos++;
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.day = n;
        break;
      case '15':
      case '03':
      case '3':
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.hour = n;
        break;
      case '04':
      case '4':
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.minute = n;
        break;
      case '05':
      case '5':
        if ((n = digits(1, 2)) === undefined) return undefined;
        f.second = n;
        break;
      case 'PM':
      case 'pm': {
        const m = /^([ap])\.?m\.?/i.exec(s.slice(pos));
        if (!m) return undefined;
        pos += m[0].length;
        f.pm = m[1]?.toLowerCase() === 'p';
        break;
      }
      case '.0':
      case '.9': {
        const m = /^[.,](\d+)/.exec(s.slice(pos));
        if (!m) {
          if (t.token === '.0') return undefined;
          break;
        }
        pos += m[0].length;
        f.ms = Math.round(Number(`0.${m[1]}`) * 1000);
        break;
      }
      case 'MST': {
        const w = word();
        if (w === undefined) return undefined;
        if (/^(utc|gmt|z)$/i.test(w)) f.offsetMinutes = 0;
        break;
      }
      case 'Z07:00':
      case 'Z0700':
      case 'Z07':
        if (!zone(true)) return undefined;
        break;
      default:
        if (!zone(false)) return undefined;
    }
  }
  if (s.slice(pos).trim() !== '') return undefined;

  if (f.pm !== undefined && f.hour !== undefined) {
    if (f.pm && f.hour < 12) f.hour += 12;
    if (!f.pm && f.hour === 12) f.hour = 0;
  }
  const today = wallFields(ctx.now, ctx);
  const dateKnown = f.year !== undefined || f.month !== undefined || f.day !== undefined;
  return fromFields(
    {
      year: f.year ?? today.year,
      month: f.month ?? (dateKnown ? 0 : today.month),
      day: f.day ?? (dateKnown ? 1 : today.day),
      ...(f.hour === undefined ? {} : { hour: f.hour }),
      ...(f.minute === undefined ? {} : { minute: f.minute }),
      ...(f.second === undefined ? {} : { second: f.second }),
      ...(f.ms === undefined ? {} : { ms: f.ms }),
      ...(f.offsetMinutes === undefined ? {} : { offsetMinutes: f.offsetMinutes }),
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------------------
// Relative dates (S6.4)

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function unitMs(unit: string): number | undefined {
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (u.startsWith('mo')) return 30 * DAY;
  if (u.startsWith('sec') || u === 's') return SECOND;
  if (u.startsWith('min') || u === 'm') return MINUTE;
  if (u.startsWith('hour') || u.startsWith('hr') || u === 'h') return HOUR;
  if (u.startsWith('day') || u === 'd') return DAY;
  if (u.startsWith('week') || u.startsWith('wk') || u === 'w') return 7 * DAY;
  if (u.startsWith('year') || u.startsWith('yr') || u === 'y') return 365 * DAY;
  return undefined;
}

/** `2 hours 1 day ago`, `1.5h`, `just now`, `an hour ago`. Undefined on unknown units. */
export function parseTimeAgo(value: string, now: number): Date | undefined {
  let s = value.toLowerCase();
  if (s.includes('now')) return new Date(now);
  s = s.replace(/,/g, ' ').replace(/\bago\b/g, ' ').replace(/\band\b/g, ' ');
  s = s.replace(/\b(an?|one)\s+(?=[a-z])/g, '1 ');
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([^\d\s]+)/g)) {
    const ms = unitMs(m[2] ?? '');
    if (ms === undefined) return undefined;
    total += Number(m[1]) * ms;
    found = true;
  }
  if (!found) return undefined;
  return new Date(now - total);
}

// ---------------------------------------------------------------------------------------
// fuzzytime (S6.5)

const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]\.?m\.?)?/i;

function parseClock(text: string | undefined): { hour: number; minute: number; second: number } | undefined {
  if (!text) return { hour: 0, minute: 0, second: 0 };
  const m = TIME_RE.exec(text);
  if (!m) {
    const short = /^\s*(\d{1,2})\s*([ap])\.?m\.?\s*$/i.exec(text);
    if (!short) return undefined;
    let h = Number(short[1]);
    if (short[2]?.toLowerCase() === 'p' && h < 12) h += 12;
    if (short[2]?.toLowerCase() === 'a' && h === 12) h = 0;
    return { hour: h, minute: 0, second: 0 };
  }
  let hour = Number(m[1]);
  const meridiem = m[4]?.[0]?.toLowerCase();
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  return { hour, minute: Number(m[2]), second: Number(m[3] ?? 0) };
}

function zoneSuffix(text: string): number | undefined {
  const m = /(?:\s|\d)(Z|UTC|GMT|[+-]\d{2}:?\d{2})\s*$/i.exec(text);
  if (!m) return undefined;
  const z = m[1] ?? '';
  if (/^(z|utc|gmt)$/i.test(z)) return 0;
  const sign = z.startsWith('-') ? -1 : 1;
  const digitsOnly = z.slice(1).replace(':', '');
  return sign * (Number(digitsOnly.slice(0, 2)) * 60 + Number(digitsOnly.slice(2)));
}

function withClock(base: Fields, clock: string | undefined, ctx: DateContext): Date | undefined {
  const c = parseClock(clock);
  if (!c) return undefined;
  const offset = clock ? zoneSuffix(clock) : undefined;
  return fromFields({ ...base, ...c, ...(offset === undefined ? {} : { offsetMinutes: offset }) }, ctx);
}

/** Best-effort parser for the many human date formats seen on tracker pages. */
export function parseFuzzyTime(value: string, ctx: DateContext): Date | undefined {
  const s = value.trim().replace(/\s+/g, ' ');
  if (!s) return undefined;
  const lower = s.toLowerCase();

  // (1) ISO-8601 with an explicit zone, or RFC 1123/2822 with zone.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const iso = s
      .replace(' ', 'T')
      .replace(/\s+(?=[Z+-][^T]*$)/i, '')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return new Date(t);
  }
  if (/^([a-z]{3},?\s+)?\d{1,2}\s+[a-z]{3,}\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?\s*(gmt|utc|ut|z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(/([+-]\d{2}):(\d{2})$/, '$1$2'));
    if (Number.isFinite(t)) return new Date(t);
  }
  // (2) Unix timestamps.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(s.length >= 13 ? n : n * 1000);
  }
  // (3) / (4) relative.
  if (lower.includes('now')) return new Date(ctx.now);
  if (/\bago\b/.test(lower)) return parseTimeAgo(lower, ctx.now);

  // (5) today / yesterday / tomorrow [at] time.
  const rel = /^(today|yesterday|tomorrow)(?:[\s,]*(?:at\s*)?(.*))?$/i.exec(s);
  if (rel) {
    const word = rel[1]?.toLowerCase();
    const shift = word === 'yesterday' ? -1 : word === 'tomorrow' ? 1 : 0;
    const day = wallFields(ctx.now + shift * DAY, ctx);
    return withClock(day, rel[2] || undefined, ctx);
  }
  // (6) weekday at time -> most recent such weekday (today counts).
  const wd = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?(?:\s+at)?\s+(.+)$/i.exec(s);
  if (wd && /^\d{1,2}(:\d{2})/.test(wd[2] ?? '')) {
    const target = WEEKDAYS.indexOf(wd[1]?.toLowerCase() ?? '');
    const today = wallFields(ctx.now, ctx);
    const todayDow = new Date(Date.UTC(today.year, today.month, today.day)).getUTCDay();
    const back = (todayDow - target + 7) % 7;
    return withClock(wallFields(ctx.now - back * DAY, ctx), wd[2], ctx);
  }

  const year = wallFields(ctx.now, ctx).year;
  let m: RegExpExecArray | null;

  // (8a) ISO-ish without zone: 2024-03-05[ T]14:03[:00]
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s,]+(.+))?$/.exec(s))) {
    return withClock({ year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) }, m[4], ctx);
  }
  // (8b) DD Mon[,] YYYY [time]   e.g. "05 Mar 2024 14:03", "5-Mar-2024", "5th March 2024"
  m = /^(?:[a-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s\-./]+([a-z]{3,9})\.?[\s\-./,]+(\d{4}|\d{2}(?![:\d]))(?:[\s,T]+(.+))?$/i.exec(s);
  if (m) {
    const month = monthIndex(m[2] ?? '');
    if (month !== undefined) {
      const y = Number(m[3]);
      return withClock({ year: y < 100 ? 2000 + y : y, month, day: Number(m[1]) }, m[4], ctx);
    }
  }
  // (8c) Mon DD[,] YYYY [time]   e.g. "Mar 5, 2024", "March 05 2024 14:03"
  m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:[\s,T]+(?:at\s+)?(.+))?$/i.exec(s);
  if (m) {
    const month = monthIndex(m[1] ?? '');
    if (month !== undefined) return withClock({ year: Number(m[3]), month, day: Number(m[2]) }, m[4], ctx);
  }
  // (7) missing year: "D Mon HH:MM", "Mon D HH:MM", "MM-DD HH:MM"
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?(?:[\s,]+(.+))?$/i.exec(s))) {
    const month = monthIndex(m[2] ?? '');
    if (month !== undefined) return withClock({ year, month, day: Number(m[1]) }, m[3], ctx);
  }
  if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(.+))?$/i.exec(s))) {
    const month = monthIndex(m[1] ?? '');
    if (month !== undefined) return withClock({ year, month, day: Number(m[2]) }, m[3], ctx);
  }
  if ((m = /^(\d{1,2})-(\d{1,2})(?:\s+(.+))?$/.exec(s))) {
    return withClock({ year, month: Number(m[1]) - 1, day: Number(m[2]) }, m[3], ctx);
  }
  // (8d) numeric A/B/YYYY, A-B-YYYY, A.B.YYYY (month first unless dayFirst)
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[\s,T]+(.+))?$/.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let month = ctx.dayFirst ? b : a;
    let day = ctx.dayFirst ? a : b;
    if (month > 12 && day <= 12) [month, day] = [day, month];
    const y = Number(m[3]);
    return withClock({ year: y < 100 ? 2000 + y : y, month: month - 1, day }, m[4], ctx);
  }
  // Last resort: the platform parser for anything with an explicit zone.
  if (/(gmt|utc|[+-]\d{4})$/i.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(t);
  }
  return undefined;
}

/**
 * Value of a `date` field: the normalised ISO/RFC form produced by filters, a Unix
 * timestamp, or anything `fuzzytime` understands.
 */
export function parseDateValue(value: string, ctx: DateContext): Date | undefined {
  return parseFuzzyTime(value, ctx);
}
