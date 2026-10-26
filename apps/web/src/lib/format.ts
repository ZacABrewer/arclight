import { formatDateTime as formatPreferredDateTime } from './ui-preferences.js';
import { t, formatDecimal, intlLocale } from '../i18n/index.js';

export function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${totalSeconds % 60}s`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  let text: string;
  if (abs < 60) text = `${Math.round(abs)}s`;
  else if (abs < 3600) text = `${Math.round(abs / 60)}m`;
  else if (abs < 86_400) text = `${Math.round(abs / 3600)}h`;
  else text = `${Math.round(abs / 86_400)}d`;
  return diff < 0 ? t('lib.format.ago', { time: text }) : t('lib.format.in', { time: text });
}

/** Date and time in the signed-in user's preferred formats (Settings → General → UI). */
export function formatDateTime(iso: string): string {
  return formatPreferredDateTime(iso);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${formatDecimal(ms / 1000, 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Bytes as a short binary-unit string (B, KiB, MiB, ...). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${formatDecimal(n, i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Bytes per second as a human-readable rate, e.g. "1.5 MiB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return '—';
  return `${formatSize(bytesPerSecond)}/s`;
}

/** Language codes as names in the UI language ("en" -> "English"); unknown codes pass through. */
export function languageNames(codes: readonly string[] | null | undefined): string {
  if (!codes || codes.length === 0) return '—';
  let names: Intl.DisplayNames | null = null;
  try {
    const locale = intlLocale();
    names = new Intl.DisplayNames(locale ? [locale] : [], { type: 'language' });
  } catch {
    names = null;
  }
  return codes
    .map((code) => {
      if (code.toLowerCase() === 'unknown') return t('common.unknownLanguage');
      try {
        return names?.of(code) ?? code;
      } catch {
        return code;
      }
    })
    .join(', ');
}
