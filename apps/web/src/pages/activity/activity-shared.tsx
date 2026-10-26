import { Button } from '../../components/button.js';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Milliseconds as h:mm:ss (or d hh:mm when longer than a day). */
export function formatEta(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${pad(h)}:${pad(m)}` : `${h}:${pad(m)}:${pad(s)}`;
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pager" aria-label="Pagination">
      <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">
        «
      </Button>
      <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        ‹
      </Button>
      <span className="pager-info">
        Page {Math.min(page, pages)} of {pages} · {total} total
      </span>
      <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        ›
      </Button>
      <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page">
        »
      </Button>
    </nav>
  );
}

export function ProgressBar({ value, tone = 'info' }: { value: number; tone?: 'info' | 'ok' | 'warning' | 'error' }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <span className={`progress progress-${tone}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-label">{pct}%</span>
    </span>
  );
}
