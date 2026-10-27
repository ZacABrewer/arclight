import { LOG_LEVEL_VALUES, redactText, type DebugCommandResult, type DebugSnapshot, type LogLevel, type LogRecord } from '@arclight/shared';

// System → Debugging helpers: the plain-text forms the Copy buttons put on the clipboard and
// the console history. Copied text is for pasting into a support thread, so it stays plain
// ASCII-ish monospace and is not translated (the api's own command output is English too).

function mib(n: number): string {
  return `${(n / 1048576).toFixed(1)} MiB`;
}

/** Share of the container limit in use, 0–100; null without a limit. */
export function memoryShare(s: Pick<DebugSnapshot, 'memory' | 'cgroup'>): number | null {
  const limit = s.cgroup.limit;
  if (!limit) return null;
  const used = s.cgroup.usage ?? s.memory.rss;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function engineLine(s: DebugSnapshot): string {
  const e = s.engine;
  if (!e) return 'not available';
  if (!e.enabled) return 'disabled';
  const port = e.listenPort === null ? 'not listening' : `port ${e.listenPort}`;
  const extra = e.error ? ` · error: ${e.error}` : e.warning ? ` · warning: ${e.warning}` : '';
  return `${e.state} · ${port} · ${e.torrents} torrents (${e.downloading} down, ${e.seeding} seed) · ${e.peers} peers${extra}`;
}

/** `withIp`: the public IP is left out of copied text unless asked for. */
export function vpnLine(s: DebugSnapshot, withIp = false): string {
  const v = s.vpn;
  if (!v) return 'not available';
  if (!v.enabled) return 'disabled';
  const parts = [v.provider ?? 'vpn', v.connected ? 'connected' : 'disconnected'];
  if (withIp && v.publicIp) parts.push(v.publicIp);
  if (v.forwardedPort !== undefined) parts.push(`forwarded port ${v.forwardedPort}`);
  if (v.killSwitchEngaged) parts.push('kill switch engaged');
  if (v.error) parts.push(`error: ${v.error}`);
  return parts.join(' · ');
}

/** The snapshot as plain text for the clipboard. */
export function snapshotText(s: DebugSnapshot): string {
  const m = s.memory;
  const cg = s.cgroup;
  const rows: [string, string][] = [
    ['time', s.time],
    ['version', s.version],
    ['node', `${s.node} ${s.platform} ${s.arch}${s.isDocker ? ' (docker)' : ''}`],
    ['uptime', `${Math.round(s.uptimeSeconds)} s`],
    ['rss', mib(m.rss)],
    ['heap', `${mib(m.heapUsed)} used of ${mib(m.heapTotal)}`],
    ['external', mib(m.external)],
    ['arrayBuffers', mib(m.arrayBuffers)],
    [
      'container',
      cg.version === null
        ? 'not readable'
        : `cgroup v${cg.version}: ${cg.usage === null ? '?' : mib(cg.usage)} of ${cg.limit === null ? 'unlimited' : mib(cg.limit)}${cg.anon !== null ? `, anon ${mib(cg.anon)}` : ''}${cg.file !== null ? `, file ${mib(cg.file)}` : ''}`,
    ],
    ['event loop p99', s.eventLoopLagP99Ms === null ? 'not measured' : `${s.eventLoopLagP99Ms.toFixed(1)} ms`],
    ['handles', s.handles.available ? `${s.handles.total} (${s.handles.byType.map((h) => `${h.type} ${h.count}`).join(', ')}), ${mib(s.handles.queuedBytes)} queued` : 'not available'],
    ['engine', engineLine(s)],
    ['vpn', vpnLine(s)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return ['Arclight snapshot', ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`)].join('\n');
}

/** One console result as text: a "> command" header, then the output. */
export function resultText(r: DebugCommandResult): string {
  return `> ${r.command}  [${r.ok ? 'ok' : 'error'}, ${Math.round(r.durationMs)} ms]\n${r.output}`;
}

export function resultsText(results: readonly DebugCommandResult[]): string {
  return results.map(resultText).join('\n\n');
}

/** A log record as one redacted line (the api's console prints the same shape). */
export function logLine(r: LogRecord): string {
  const comp = r.component ? ` [${r.component}]` : '';
  const ctx = r.context && Object.keys(r.context).length > 0 ? ` ${JSON.stringify(r.context)}` : '';
  return redactText(`${r.time} ${r.level.toUpperCase().padEnd(5)}${comp} ${r.message}${ctx}`).replace(/\r?\n/g, '\\n');
}

export function levelAtLeast(level: LogLevel, min: LogLevel | ''): boolean {
  return !min || LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[min];
}

export const HISTORY_CAP = 30;

/** Newest first, no consecutive duplicates. */
export function pushHistory(history: readonly string[], entry: string, cap = HISTORY_CAP): string[] {
  const e = entry.trim();
  if (!e) return [...history];
  return [e, ...history.filter((h) => h !== e)].slice(0, cap);
}

/** Append a command as a new line of the console input. */
export function appendCommand(input: string, command: string): string {
  if (!input.trim()) return command;
  return input.endsWith('\n') ? `${input}${command}` : `${input}\n${command}`;
}
