import { formatDecimal, intlLocale } from '../../i18n/index.js';
// Mono data formatting shared by the dashboard and the System pages (copy rules: numbers in
// mono with units: "72.4 MB/s", "412 GB", "3d 7h", "03:00").

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1.5 KB". Binary multiples, as file managers show them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const exp = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  return `${value >= 99.95 || exp === 0 ? Math.round(value) : formatDecimal(value, 1)} ${UNITS[exp]}`;
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
  return bytesPerSecond == null ? '—' : `${formatBytes(bytesPerSecond)}/s`;
}

/** Duration in ms → "3d 7h", "2h 14m", "12m", "40s". */
export function formatSpan(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** 24-hour clock "19:42" in local time. */
export function formatClock(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "2026-10-25 19:42:05" — sortable local timestamp for tables. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "Sun 25 Oct" */
export function formatDay(d: Date): string {
  const wd = d.toLocaleDateString(intlLocale() ?? 'en-GB', { weekday: 'short' });
  const mon = d.toLocaleDateString(intlLocale() ?? 'en-GB', { month: 'short' });
  return `${wd} ${d.getDate()} ${mon}`;
}
