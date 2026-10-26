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
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
