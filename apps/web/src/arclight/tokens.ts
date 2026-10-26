// Typed mirror of design/arclight-kit/handoff/tokens.json for the parts components need in
// code (status vocabulary, sizes, breakpoints, motion). Colours stay in CSS variables; the
// status table below records which token each status uses so tests can pin the mapping.

/** The status vocabulary. Labels are exact (handoff README "Status vocabulary"). */
export const STATUS_LABELS = {
  downloaded: 'Downloaded',
  downloading: 'Downloading',
  importing: 'Importing',
  monitored: 'Monitored',
  unmonitored: 'Unmonitored',
  unaired: 'Unaired',
  queued: 'Queued',
  paused: 'Paused',
  waiting: 'Waiting for air date',
  missing: 'Missing',
  cutoffUnmet: 'Cutoff unmet',
  stalled: 'Stalled',
  failed: 'Failed',
} as const;

export type StatusKey = keyof typeof STATUS_LABELS;
export type StatusLabel = (typeof STATUS_LABELS)[StatusKey];

/** Dot shape: a filled square, a hollow ring, or a hollow warn ring (tokens.json `dot`). */
export type StatusDot = 'fill' | 'ring' | 'ring-warn';

export interface StatusStyle {
  /** Value written to `data-status` — the selector arclight.css styles. */
  attr: string;
  border: string;
  text: string;
  dot: StatusDot;
  dotColor: string | null;
  fill: string | null;
  /** tokens.json `live`: the state is happening now (no glow on chips — rule 1). */
  live: boolean;
}

// Token references are written exactly as tokens.json writes them.
export const STATUS_STYLES: Record<StatusKey, StatusStyle> = {
  downloaded: { attr: 'downloaded', border: 'line.3', text: 'text.2', dot: 'fill', dotColor: 'accent.cyan', fill: null, live: false },
  downloading: { attr: 'downloading', border: 'accent.cyan', text: 'text.1', dot: 'fill', dotColor: 'accent.cyan', fill: 'rgba(110,246,255,.12)', live: true },
  importing: { attr: 'importing', border: 'accent.cyan', text: 'text.1', dot: 'fill', dotColor: 'accent.cyan', fill: 'rgba(110,246,255,.12)', live: true },
  monitored: { attr: 'monitored', border: 'accent.cyan', text: 'text.1', dot: 'fill', dotColor: 'accent.cyan', fill: 'rgba(110,246,255,.10)', live: false },
  unaired: { attr: 'unaired', border: 'signal.neutralLine', text: '#8fb3bd', dot: 'ring', dotColor: null, fill: null, live: false },
  queued: { attr: 'queued', border: 'signal.neutralLine', text: 'text.3', dot: 'fill', dotColor: 'text.5', fill: null, live: false },
  paused: { attr: 'paused', border: 'signal.neutralLine', text: 'text.3', dot: 'fill', dotColor: 'text.5', fill: null, live: false },
  // Not in tokens.json; the Pages file renders "Waiting for air date" with the queued style.
  waiting: { attr: 'queued', border: 'signal.neutralLine', text: 'text.3', dot: 'fill', dotColor: 'text.5', fill: null, live: false },
  unmonitored: { attr: 'unmonitored', border: 'rgba(143,179,189,.2)', text: 'text.5', dot: 'ring', dotColor: null, fill: null, live: false },
  missing: { attr: 'missing', border: 'signal.warnLine', text: 'signal.warnText', dot: 'fill', dotColor: 'signal.warn', fill: null, live: false },
  // arclight.css names this one `cutoff`; tokens.json names it `cutoffUnmet`.
  cutoffUnmet: { attr: 'cutoff', border: 'signal.warnLine', text: 'signal.warnText', dot: 'ring-warn', dotColor: null, fill: null, live: false },
  stalled: { attr: 'stalled', border: 'signal.warnLine', text: 'signal.warnText', dot: 'fill', dotColor: 'signal.warn', fill: 'rgba(255,154,77,.06)', live: false },
  failed: { attr: 'failed', border: 'signal.dangerLine', text: 'signal.dangerText', dot: 'fill', dotColor: 'signal.danger', fill: 'rgba(255,90,70,.06)', live: false },
};

/** Statuses whose label must carry a cause ("Failed · sample only", "Stalled · no peers"). */
export const STATUS_NEEDS_CAUSE: ReadonlySet<StatusKey> = new Set<StatusKey>(['failed', 'stalled']);

const LABEL_TO_KEY = new Map<string, StatusKey>(
  (Object.entries(STATUS_LABELS) as Array<[StatusKey, string]>).map(([k, v]) => [v.toLowerCase(), k]),
);

/**
 * Resolve a status from a key or a vocabulary label (case-insensitive). A label with a
 * cause ("Failed · sample only") resolves by its first segment. Unknown → undefined.
 */
export function resolveStatus(input: string): StatusKey | undefined {
  if (input in STATUS_LABELS) return input as StatusKey;
  const head = input.split('·')[0]?.trim().toLowerCase() ?? '';
  if (head === 'cutoff') return 'cutoffUnmet';
  return LABEL_TO_KEY.get(head);
}

/** "Failed" + "sample only" → "Failed · sample only". */
export function statusLabel(status: StatusKey, cause?: string | undefined): string {
  const base = STATUS_LABELS[status];
  return cause ? `${base} · ${cause}` : base;
}

export const SIZE = {
  rail: 84,
  railCompact: 64,
  topbar: 60,
  control: 38,
  controlSm: 32,
  controlLg: 46,
  input: 40,
  chip: 24,
  rowDense: 44,
  rowRich: 62,
  chamfer: 22,
  chamferSm: 14,
  mobileTabBar: 86,
} as const;

export const BREAKPOINTS = { mobile: 0, tablet: 768, desktop: 1280 } as const;

export const MOTION = {
  press: 60,
  hover: 120,
  base: 200,
  enter: 240,
  derezz: 320,
  chamferSweep: 600,
  pulse: 1600,
  breathe: 2400,
} as const;

/** Toasts: bottom-right, max 3 visible, 5 s (Design Kit §08). */
export const TOAST_LIMIT = 3;
export const TOAST_DURATION_MS = 5000;
