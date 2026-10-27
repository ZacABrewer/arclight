import { DEBUG_COMMANDS, DEBUG_MAX_COMMANDS, type DebugCommandName, type DebugCommandResult, type DebugRunResponse } from '@arclight/shared';
import { bytes, duration, hexToAscii, kv, mib, rate, spacedHex, table } from './format.js';
import { redactText } from './redact.js';
import type { DebugService } from './service.js';

// The debug console. Input is parsed into lines; each line names one built-in, read-only
// command and its arguments. Nothing typed here is ever evaluated as code or passed to a
// shell: an unknown name is an error result, nothing more.

/** Total output one run may return; the rest is cut with a note. */
export const DEBUG_MAX_OUTPUT = 1024 * 1024;
export const LOGS_DEFAULT = 50;
export const LOGS_MAX = 500;
export const PING_TIMEOUT_MS = 10_000;

export interface ParsedCommand {
  /** The line as typed, trimmed. */
  raw: string;
  /** Lower-cased first word. */
  name: string;
  args: string[];
}

export interface ParsedInput {
  commands: ParsedCommand[];
  /** Command lines past DEBUG_MAX_COMMANDS. */
  skipped: number;
}

/** One command per line; blank lines and `#` comments are ignored; at most `max` commands. */
export function parseInput(input: string, max = DEBUG_MAX_COMMANDS): ParsedInput {
  const commands: ParsedCommand[] = [];
  let skipped = 0;
  for (const line of input.split(/\r?\n/)) {
    const raw = line.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    if (commands.length >= max) {
      skipped++;
      continue;
    }
    const [first = '', ...args] = raw.split(/\s+/);
    commands.push({ raw, name: first.toLowerCase(), args });
  }
  return { commands, skipped };
}

class UsageError extends Error {}

type Command = (svc: DebugService, args: string[]) => string | Promise<string>;

const DESCRIPTIONS: Record<DebugCommandName, string> = {
  help: 'List the commands.',
  report: 'version, memory, handles, engine, vpn and recent logs in one block, for a bug report.',
  memory: 'Process memory, V8 heap and container (cgroup) limit and usage.',
  buffers: 'Census of retained ArrayBuffers (after a GC): sizes and the biggest groups.',
  gc: 'Force a garbage collection and show memory before and after.',
  handles: 'Active handles (sockets, timers, servers) by type with bytes queued for writing.',
  engine: 'Built-in torrent engine: state, port, torrents by state, peers, rates, VPN binding.',
  vpn: 'VPN status: provider, connection, public IP, forwarded port, last check, kill switch.',
  logs: 'logs [n] [filter]: the last n log lines (default 50, max 500), optional text filter.',
  ping: 'ping <url>: HTTP GET from the server (10 s timeout); status and time, no body.',
  dns: 'dns <host>: resolve a host name from the server.',
  version: 'App version, Node.js and platform.',
};

function help(): string {
  const width = Math.max(...DEBUG_COMMANDS.map((c) => c.length));
  return [
    'Built-in, read-only diagnostics. One command per line; lines starting with # are ignored.',
    '',
    ...DEBUG_COMMANDS.map((c) => `  ${c.padEnd(width)}  ${DESCRIPTIONS[c]}`),
  ].join('\n');
}

function memoryBlock(m: NodeJS.MemoryUsage): string {
  const row = (label: string, n: number) => [label, `${mib(n).padStart(11)}  (${n.toLocaleString('en-US')} B)`] as const;
  return kv([row('rss', m.rss), row('heapTotal', m.heapTotal), row('heapUsed', m.heapUsed), row('external', m.external), row('arrayBuffers', m.arrayBuffers)]);
}

function memory(svc: DebugService): string {
  const m = svc.memoryUsage();
  const heap = svc.heapStatistics();
  const cg = svc.cgroup();
  const lag = svc.eventLoopLagP99Ms();
  const out = ['Process memory', memoryBlock(m), '', 'V8 heap'];
  out.push(
    kv([
      ['heap size limit', bytes(heap.heap_size_limit)],
      ['used heap', bytes(heap.used_heap_size)],
      ['malloced', bytes(heap.malloced_memory)],
      ['native contexts', heap.number_of_native_contexts],
      ['detached contexts', heap.number_of_detached_contexts],
    ]),
    '',
  );
  if (cg.version === null) {
    out.push('Container (cgroup): not readable (not Linux, or no cgroup memory controller)');
  } else {
    const pct = cg.limit && cg.usage !== null ? ` (${((cg.usage / cg.limit) * 100).toFixed(0)}% of limit)` : '';
    out.push(
      `Container (cgroup v${cg.version})`,
      kv([
        ['limit', cg.limit === null ? 'unlimited' : bytes(cg.limit)],
        ['usage', `${bytes(cg.usage)}${pct}`],
        ['anon', bytes(cg.anon)],
        ['file (page cache)', bytes(cg.file)],
      ]),
    );
  }
  out.push('', kv([['event loop lag p99', lag === null ? 'not measured' : `${lag.toFixed(1)} ms`]], ''));
  return out.join('\n');
}

function handles(svc: DebugService): string {
  const h = svc.handles();
  if (!h.available) return 'process._getActiveHandles() is not available in this runtime.';
  const rows = h.byType.map((g) => [g.type, g.count, bytes(g.queuedBytes), bytes(g.maxQueuedBytes)]);
  return [`${h.total} active handles, ${bytes(h.queuedBytes)} queued for writing`, '', table(['type', 'count', 'queued', 'max queued'], rows)].join('\n');
}

async function buffers(svc: DebugService): Promise<string> {
  let c;
  try {
    c = await svc.census();
  } catch (err) {
    const m = svc.memoryUsage();
    const heap = svc.heapStatistics();
    return [
      `The ArrayBuffer census could not run in-process (${err instanceof Error ? err.message : String(err)}).`,
      'Fallback: totals only.',
      '',
      kv([
        ['arrayBuffers', bytes(m.arrayBuffers)],
        ['external', bytes(m.external)],
        ['heap used', bytes(heap.used_heap_size)],
        ['malloced', bytes(heap.malloced_memory)],
      ]),
    ].join('\n');
  }
  const mb = (n: number) => (n / 1048576).toFixed(2);
  const out = [`${c.count} ArrayBuffers retained after GC, ${mb(c.totalBytes)} MB total${c.detached ? ` (${c.detached} detached)` : ''}`, '', 'By size'];
  out.push(table(['bucket', 'count', 'MB'], c.buckets.map((b) => [b.label, b.count, mb(b.totalBytes)])), '', `Top ${c.groups.length} groups by (size, first 4 bytes)`);
  out.push(
    table(
      ['size', 'count', 'total MB', 'first 12 bytes (hex)', 'ascii'],
      c.groups.map((g) => [g.size, g.count, mb(g.totalBytes), spacedHex(g.sampleHex) || '—', hexToAscii(g.sampleHex)]),
    ),
  );
  return out.join('\n');
}

async function gc(svc: DebugService): Promise<string> {
  const before = svc.memoryUsage();
  const t0 = performance.now();
  await svc.gc();
  const ms = performance.now() - t0;
  const after = svc.memoryUsage();
  const keys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'] as const;
  const rows = keys.map((k) => [k, mib(before[k]), mib(after[k]), `${after[k] - before[k] <= 0 ? '' : '+'}${mib(after[k] - before[k])}`]);
  return [`Full GC took ${ms.toFixed(0)} ms`, '', table(['', 'before', 'after', 'change'], rows)].join('\n');
}

function engine(svc: DebugService): string {
  const s = svc.torrent();
  if (!s) return 'Torrent engine: not available.';
  const t = s.torrents;
  return [
    'Torrent engine',
    kv([
      ['enabled', s.enabled],
      ['state', s.state],
      ['start at boot', s.bootBlocked ? 'blocked by ARCLIGHT_TORRENT_ENGINE=0' : undefined],
      ['tunnel guard', s.tunnelGuard ? `limiting to ${s.tunnelGuard.downloadLimit === null ? 'unlimited' : `${(s.tunnelGuard.downloadLimit / 1048576).toFixed(1)} MiB/s`} down, ${s.tunnelGuard.uploadLimit === null ? 'unlimited' : `${(s.tunnelGuard.uploadLimit / 1024).toFixed(0)} KiB/s`} up` : undefined],
      ['listen port', s.listenPort === null ? 'not listening' : s.listenPort],
      ['configured port', s.configuredListenPort],
      ['bound address', s.boundAddress ?? 'all interfaces'],
      ['torrents', `${t.total} total: ${t.downloading} downloading, ${t.seeding} seeding, ${t.paused} paused, ${t.queued} queued, ${t.checking} checking, ${t.error} error`],
      ['peers', `${s.peers}${s.encryptedPeers !== undefined ? ` (${s.encryptedPeers} encrypted)` : ''}`],
      ['dht nodes', `${s.dhtNodes}${s.dht6Nodes ? ` + ${s.dht6Nodes} IPv6` : ''}`],
      ['utp connections', s.utpConnections],
      ['download', rate(s.downloadRate)],
      ['upload', rate(s.uploadRate)],
      ['speed mode', s.speed?.mode],
      ['warning', s.warning],
      ['error', s.error],
      ['lockdown reason', s.lockdownReason],
      ['lockdown since', s.lockdownSince],
      ['lockdowns last hour', s.lockdownsLastHour],
      ['paused by kill switch', s.killSwitchPaused],
    ]),
    '',
    'VPN binding',
    kv([
      ['bind to VPN', s.vpn.bindToVpn],
      ['VPN enabled', s.vpn.enabled],
      ['VPN connected', s.vpn.connected],
      ['tunnel address', s.vpn.tunnelAddress],
      ['forwarded port', s.vpn.forwardedPort],
      ['kill switch engaged', s.vpn.killSwitchEngaged],
    ]),
  ].join('\n');
}

/** `forReport`: the public IP and peer endpoint are left out of text meant for pasting publicly. */
function vpn(svc: DebugService, forReport = false): string {
  const d = svc.vpn();
  if (!d) return 'VPN: not available.';
  const s = d.status;
  const hidden = forReport ? '(hidden in the report; run `vpn` to see it)' : undefined;
  return [
    'VPN',
    kv([
      ['enabled', s.enabled],
      ['provider', s.provider ?? 'none'],
      ['connected', s.connected],
      ['public IP', s.publicIp ? (hidden ?? s.publicIp) : undefined],
      ['location', [s.city, s.region, s.country].filter(Boolean).join(', ') || undefined],
      ['forwarded port', s.forwardedPort],
      ['tunnel address', s.tunnelAddress],
      ['interface', s.interfaceName],
      ['endpoint', s.endpoint ? (hidden ?? s.endpoint) : undefined],
      ['last handshake', s.lastHandshake],
      ['leak detected', s.leak],
      ['kill switch engaged', s.killSwitchEngaged ?? false],
      ['pause grabs when down', d.pauseGrabsWhenDown],
      ['provider kill switch', d.providerKillSwitch],
      ['port synced to client', s.downloadClientPortSynced],
      ['last check', s.lastChecked ?? 'never'],
      ['last change', s.lastChanged ?? undefined],
      ['warning', s.warning],
      ['last error', s.error],
    ]),
  ].join('\n');
}

function logs(svc: DebugService, args: string[]): string {
  let n = LOGS_DEFAULT;
  let rest = args;
  if (args[0] !== undefined && /^\d+$/.test(args[0])) {
    n = Math.min(LOGS_MAX, Math.max(1, Number(args[0])));
    rest = args.slice(1);
  }
  const filter = rest.join(' ');
  const lines = svc.logLines(n, filter || undefined);
  const head = `Last ${lines.length} log line${lines.length === 1 ? '' : 's'}${filter ? ` matching "${filter}"` : ''} (oldest first)`;
  return lines.length ? `${head}\n${lines.join('\n')}` : `${head}\n  (none)`;
}

async function ping(svc: DebugService, args: string[]): Promise<string> {
  const target = args[0];
  if (!target || args.length > 1) throw new UsageError('usage: ping <http(s)://host[:port][/path]>');
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new UsageError(`not a URL: ${target} (include http:// or https://)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('only http:// and https:// URLs can be pinged');
  const shown = redactText(url.toString());
  const t0 = performance.now();
  try {
    const res = await svc.fetch(url.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const ms = performance.now() - t0;
    // Status and a few headers only; the body is never read or returned.
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    return [
      `GET ${shown}`,
      kv([
        ['status', `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`],
        ['time', `${ms.toFixed(0)} ms`],
        ['content-type', res.headers.get('content-type') ?? undefined],
        ['server', res.headers.get('server') ?? undefined],
        ['location', location ? redactText(location) : undefined],
      ]),
    ].join('\n');
  } catch (err) {
    const ms = performance.now() - t0;
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const reason = e.name === 'TimeoutError' ? `timed out after ${PING_TIMEOUT_MS / 1000} s` : [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(': ');
    throw new Error(`GET ${shown} failed after ${ms.toFixed(0)} ms: ${reason}`);
  }
}

async function dns(svc: DebugService, args: string[]): Promise<string> {
  const host = args[0];
  if (!host || args.length > 1) throw new UsageError('usage: dns <host>');
  if (host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) throw new UsageError(`not a host name: ${host}`);
  const t0 = performance.now();
  try {
    const addrs = await svc.lookup(host);
    const ms = performance.now() - t0;
    return [`${host} resolved in ${ms.toFixed(0)} ms`, ...addrs.map((a) => `  IPv${a.family}  ${a.address}`)].join('\n');
  } catch (err) {
    const ms = performance.now() - t0;
    const e = err as { code?: string; message?: string };
    throw new Error(`${host} did not resolve after ${ms.toFixed(0)} ms: ${e.code ?? e.message ?? String(err)}`);
  }
}

function version(svc: DebugService): string {
  return [
    'Arclight',
    kv([
      ['version', svc.version],
      ['node', process.version],
      ['v8', process.versions.v8],
      ['platform', `${process.platform} ${process.arch}`],
      ['docker', svc.isDocker],
      ['pid', process.pid],
      ['uptime', duration(process.uptime())],
      ['started', new Date(svc.now() - process.uptime() * 1000).toISOString()],
    ]),
  ].join('\n');
}

function report(svc: DebugService): string {
  const section = (title: string, body: string) => `== ${title} ==\n${body}`;
  const safe = (fn: () => string) => {
    try {
      return fn();
    } catch (err) {
      return `(failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  };
  return [
    `Arclight debug report, ${new Date(svc.now()).toISOString()}`,
    '',
    section('version', safe(() => version(svc))),
    section('memory', safe(() => memory(svc))),
    section('handles', safe(() => handles(svc))),
    section('engine', safe(() => engine(svc))),
    section('vpn', safe(() => vpn(svc, true))),
    section('logs', safe(() => logs(svc, ['100']))),
  ].join('\n\n');
}

const COMMANDS: Record<DebugCommandName, Command> = {
  help,
  report,
  memory,
  buffers,
  gc,
  handles,
  engine,
  vpn: (svc) => vpn(svc),
  logs,
  ping,
  dns,
  version,
};

/** Commands that take no arguments reject extra words, so typos do not pass silently. */
const TAKES_ARGS = new Set<DebugCommandName>(['logs', 'ping', 'dns']);

function isCommand(name: string): name is DebugCommandName {
  return Object.hasOwn(COMMANDS, name);
}

async function runOne(svc: DebugService, cmd: ParsedCommand): Promise<{ ok: boolean; output: string }> {
  if (!isCommand(cmd.name)) return { ok: false, output: `Unknown command "${cmd.name}". Try \`help\` for the list.` };
  if (!TAKES_ARGS.has(cmd.name) && cmd.args.length > 0) return { ok: false, output: `${cmd.name} takes no arguments. Try \`help\`.` };
  try {
    return { ok: true, output: await COMMANDS[cmd.name](svc, cmd.args) };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** Run every command of the input in order. Output is redacted and capped at `maxOutput` in total. */
export async function runCommands(svc: DebugService, input: string, opts: { maxOutput?: number } = {}): Promise<DebugRunResponse> {
  const max = opts.maxOutput ?? DEBUG_MAX_OUTPUT;
  const { commands, skipped } = parseInput(input);
  const results: DebugCommandResult[] = [];
  let used = 0;
  let truncated = false;
  for (const cmd of commands) {
    const command = redactText(cmd.raw);
    if (used >= max) {
      truncated = true;
      results.push({ command, ok: false, output: 'Skipped: the output limit for one run was reached.', durationMs: 0 });
      continue;
    }
    const t0 = performance.now();
    const { ok, output } = await runOne(svc, cmd);
    let text = redactText(output);
    if (used + text.length > max) {
      text = `${text.slice(0, Math.max(0, max - used))}\n… output truncated (limit ${bytes(max)} per run)`;
      truncated = true;
    }
    used += text.length;
    results.push({ command, ok, output: text, durationMs: Math.round((performance.now() - t0) * 10) / 10 });
  }
  if (skipped > 0) {
    truncated = true;
    results.push({
      command: `(${skipped} more)`,
      ok: false,
      output: `Only the first ${DEBUG_MAX_COMMANDS} commands of one run are executed; ${skipped} skipped.`,
      durationMs: 0,
    });
  }
  return { results, truncated };
}
