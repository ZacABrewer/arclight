import { describe, expect, it, vi } from 'vitest';
import { DEBUG_COMMANDS, DEBUG_MAX_COMMANDS, type LogRecord, type TorrentSessionStatus, type VpnStatus } from '@arclight/shared';
import { parseInput, runCommands } from './commands.js';
import { arrayBufferCensus } from './inspector.js';
import { handleCensus, readCgroup } from './probes.js';
import { redactJson, redactText } from './redact.js';
import { DebugService, type DebugSources } from './service.js';

const MiB = 1024 * 1024;

function svc(over: Partial<DebugSources> = {}): DebugService {
  return new DebugService({ version: '9.9.9-test', isDocker: true, readFile: () => null, ...over });
}

async function one(service: DebugService, input: string) {
  const { results } = await runCommands(service, input);
  expect(results).toHaveLength(1);
  return results[0]!;
}

function record(id: number, message: string, extra: Partial<LogRecord> = {}): LogRecord {
  return { id, time: `2026-01-01T00:00:${String(id % 60).padStart(2, '0')}.000Z`, level: 'info', message, ...extra };
}

/** A logs source over a fixed newest-first list, like the module's ring-buffer adapter. */
function logsOf(records: LogRecord[]): NonNullable<DebugSources['logs']> {
  const newestFirst = [...records].sort((a, b) => b.id - a.id);
  return (limit, match) => newestFirst.filter(match).slice(0, limit);
}

describe('parseInput', () => {
  it('reads one command per line, skipping blank lines and # comments', () => {
    const { commands, skipped } = parseInput('  MEMORY \n\n# a comment\nlogs 20 error\r\n   # indented comment\nping http://x');
    expect(commands.map((c) => [c.name, c.args])).toEqual([
      ['memory', []],
      ['logs', ['20', 'error']],
      ['ping', ['http://x']],
    ]);
    expect(commands[0]!.raw).toBe('MEMORY');
    expect(skipped).toBe(0);
  });

  it(`caps a run at ${DEBUG_MAX_COMMANDS} commands`, () => {
    const { commands, skipped } = parseInput(Array.from({ length: 25 }, () => 'version').join('\n'));
    expect(commands).toHaveLength(DEBUG_MAX_COMMANDS);
    expect(skipped).toBe(5);
  });
});

describe('runCommands', () => {
  it('runs a pasted block in order and reports unknown commands without running anything', async () => {
    const { results } = await runCommands(svc(), 'version\nrm -rf /\nprocess.exit(1)\nhelp');
    expect(results.map((r) => [r.command, r.ok])).toEqual([
      ['version', true],
      ['rm -rf /', false],
      ['process.exit(1)', false],
      ['help', true],
    ]);
    expect(results[1]!.output).toBe('Unknown command "rm". Try `help` for the list.');
    expect(results[0]!.output).toContain('9.9.9-test');
    for (const r of results) expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('notes the commands past the cap', async () => {
    const res = await runCommands(svc(), Array.from({ length: 22 }, () => 'version').join('\n'));
    expect(res.results).toHaveLength(DEBUG_MAX_COMMANDS + 1);
    expect(res.results.at(-1)!.output).toContain('2 skipped');
    expect(res.truncated).toBe(true);
  });

  it('cuts output at the per-run size limit', async () => {
    const helpLength = (await one(svc(), 'help')).output.length;
    const res = await runCommands(svc(), 'help\nhelp\nhelp', { maxOutput: helpLength + 100 });
    expect(res.truncated).toBe(true);
    expect(res.results[0]!.output).toHaveLength(helpLength);
    expect(res.results[1]!.output).toContain('output truncated');
    expect(res.results[2]!.output).toContain('Skipped');
    expect(res.results.reduce((n, r) => n + r.output.length, 0)).toBeLessThan(helpLength + 200);
  });

  it('rejects arguments on commands that take none', async () => {
    const r = await one(svc(), 'memory now');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('takes no arguments');
  });
});

describe('redaction', () => {
  it('masks secrets in free text, URLs, JSON and WireGuard keys', () => {
    const wgKey = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
    const text = [
      'apikey=abc123def&page=2',
      'X-Api-Key: 0123456789abcdef',
      'password: hunter2',
      '{"apiKey":"s3cret","name":"Sonarr","token":"t0k"}',
      'http://admin:pa55word@sonarr:8989/api',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      `WIREGUARD_PRIVATE_KEY=${wgKey}`,
      `peer key ${wgKey} end`,
    ].join('\n');
    const out = redactText(text);
    for (const secret of ['abc123def', '0123456789abcdef', 'hunter2', 's3cret', 't0k', 'pa55word', 'eyJhbGciOiJIUzI1NiJ9', wgKey]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('page=2');
    expect(out).toContain('"name":"Sonarr"');
    expect(out).toContain('http://admin:********@sonarr:8989/api');
    expect(redactText(out)).toBe(out);
  });

  it('masks secret keys in structured values', () => {
    expect(redactJson({ url: 'http://x', apiKey: 'k', nested: { password: 'p', user: 'u' } })).toBe(
      '{"url":"http://x","apiKey":"********","nested":{"password":"********","user":"u"}}',
    );
  });

  it('never lets a secret through any command output', async () => {
    const service = svc({
      logs: logsOf([record(1, 'connecting to http://qbit:8080?password=topsecret', { context: { apiKey: 'leak-me', host: 'qbit' } })]),
      vpn: () => ({ status: { enabled: true, connected: false, lastChecked: null, lastChanged: null, error: 'gluetun said token=abcdef123' }, pauseGrabsWhenDown: true }),
    });
    const { results } = await runCommands(service, 'logs\nvpn\nreport');
    const all = results.map((r) => r.output).join('\n');
    expect(all).not.toContain('topsecret');
    expect(all).not.toContain('leak-me');
    expect(all).not.toContain('abcdef123');
    expect(all).toContain('host');
  });
});

describe('commands', () => {
  it('help lists every command with a description', async () => {
    const r = await one(svc(), 'HELP');
    expect(r.ok).toBe(true);
    for (const c of DEBUG_COMMANDS) expect(r.output).toMatch(new RegExp(`^  ${c}\\s+\\S`, 'm'));
  });

  it('memory shows process, heap and cgroup figures', async () => {
    const files: Record<string, string> = {
      '/sys/fs/cgroup/memory.max': `${2048 * MiB}\n`,
      '/sys/fs/cgroup/memory.current': `${1024 * MiB}\n`,
      '/sys/fs/cgroup/memory.stat': `anon ${700 * MiB}\nfile ${300 * MiB}\nkernel 1234\n`,
    };
    const service = svc({
      readFile: (p) => files[p] ?? null,
      memoryUsage: () => ({ rss: 512 * MiB, heapTotal: 200 * MiB, heapUsed: 150 * MiB, external: 40 * MiB, arrayBuffers: 30 * MiB }),
      eventLoopLagP99Ms: () => 12.34,
    });
    const r = await one(service, 'memory');
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/rss\s+512\.0 MiB\s+\(536,870,912 B\)/);
    expect(r.output).toMatch(/arrayBuffers\s+30\.0 MiB/);
    expect(r.output).toContain('Container (cgroup v2)');
    expect(r.output).toMatch(/limit\s+2\.00 GiB/);
    expect(r.output).toMatch(/usage\s+1\.00 GiB \(50% of limit\)/);
    expect(r.output).toMatch(/anon\s+700\.0 MiB/);
    expect(r.output).toMatch(/event loop lag p99\s+12\.3 ms/);
  });

  it('reads cgroup v1 and treats the huge v1 limit as unlimited', () => {
    const files: Record<string, string> = {
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1000\n',
      '/sys/fs/cgroup/memory/memory.stat': 'cache 10\nrss 20\ntotal_cache 11\ntotal_rss 21\n',
    };
    expect(readCgroup((p) => files[p] ?? null)).toEqual({ version: 1, limit: null, usage: 1000, anon: 21, file: 11 });
    expect(readCgroup(() => null)).toEqual({ version: null, limit: null, usage: null, anon: null, file: null });
  });

  it('handles groups active handles by type with queued bytes', async () => {
    class Socket {
      constructor(readonly writableLength: number) {}
    }
    class Timer {}
    const list = [new Socket(100), new Socket(5000), new Socket(0), new Timer()];
    expect(handleCensus(() => list)).toEqual({
      available: true,
      total: 4,
      queuedBytes: 5100,
      byType: [
        { type: 'Socket', count: 3, queuedBytes: 5100, maxQueuedBytes: 5000 },
        { type: 'Timer', count: 1, queuedBytes: 0, maxQueuedBytes: 0 },
      ],
    });
    const r = await one(svc({ activeHandles: () => list }), 'handles');
    expect(r.output).toContain('4 active handles, 5.0 KiB queued for writing');
    expect(r.output).toMatch(/Socket\s+3\s+5\.0 KiB\s+4\.9 KiB/);
    expect(handleCensus(() => undefined).available).toBe(false);
    // The real runtime exposes them.
    expect(handleCensus().available).toBe(true);
  });

  it('logs returns the last n lines oldest first and filters case-insensitively', async () => {
    const records = Array.from({ length: 80 }, (_v, i) => record(i + 1, i % 10 === 0 ? `Torrent STALLED ${i + 1}` : `tick ${i + 1}`, { component: 'engine' }));
    const service = svc({ logs: logsOf(records) });
    const def = await one(service, 'logs');
    const lines = def.output.split('\n');
    expect(lines[0]).toBe('Last 50 log lines (oldest first)');
    expect(lines).toHaveLength(51);
    expect(lines[1]).toContain('STALLED 31');
    expect(lines.at(-1)).toContain('tick 80');
    expect(lines[2]).toMatch(/^2026-01-01T00:00:32\.000Z INFO  \[engine\] tick 32$/);

    const filtered = await one(service, 'logs 3 stalled');
    expect(filtered.output.split('\n')).toEqual([
      'Last 3 log lines matching "stalled" (oldest first)',
      expect.stringContaining('Torrent STALLED 51'),
      expect.stringContaining('Torrent STALLED 61'),
      expect.stringContaining('Torrent STALLED 71'),
    ]);
    const capped = await one(service, 'logs 100000');
    expect(capped.output.split('\n')[0]).toBe('Last 80 log lines (oldest first)');
  });

  it('logs filters on the redacted line, so a filter cannot probe a secret', async () => {
    const service = svc({ logs: logsOf([record(1, 'login password=hunter2')]) });
    expect((await one(service, 'logs hunter')).output).toContain('(none)');
    expect((await one(service, 'logs login')).output).toContain('password=********');
  });

  it('ping reports status and time through the injected fetch, never the body', async () => {
    const fetch = vi.fn(async () => new Response('secret body', { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'text/html', server: 'nginx' } }));
    const service = svc({ fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await one(service, 'ping http://sonarr:8989/api/v3/system/status?apikey=abc123');
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://sonarr:8989/api/v3/system/status?apikey=abc123', expect.objectContaining({ method: 'GET', redirect: 'manual' }));
    expect(r.output).toContain('GET http://sonarr:8989/api/v3/system/status?apikey=********');
    expect(r.output).toMatch(/status\s+401 Unauthorized/);
    expect(r.output).toMatch(/time\s+\d+ ms/);
    expect(r.output).toMatch(/server\s+nginx/);
    expect(r.output).not.toContain('secret body');
    expect(r.output).not.toContain('abc123');
  });

  it('ping reports network errors and rejects non-http URLs', async () => {
    const failing = svc({
      fetch: (async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:8989' } });
      }) as unknown as typeof globalThis.fetch,
    });
    const r = await one(failing, 'ping http://sonarr:8989');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/GET http:\/\/sonarr:8989\/ failed after \d+ ms: fetch failed: ECONNREFUSED/);
    const fetch = vi.fn();
    const service = svc({ fetch: fetch as unknown as typeof globalThis.fetch });
    for (const bad of ['ping file:///etc/passwd', 'ping ftp://x', 'ping notaurl', 'ping']) {
      const res = await one(service, bad);
      expect([bad, res.ok]).toEqual([bad, false]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dns lists the resolved addresses', async () => {
    const service = svc({ lookup: async () => [{ address: '10.0.0.5', family: 4 }, { address: 'fd00::5', family: 6 }] });
    const r = await one(service, 'dns gluetun');
    expect(r.output).toMatch(/^gluetun resolved in \d+ ms\n  IPv4  10\.0\.0\.5\n  IPv6  fd00::5$/);
    expect((await one(service, 'dns bad;host')).ok).toBe(false);
  });

  it('engine and vpn summarise the services; report hides the public IP', async () => {
    const engine = {
      enabled: true,
      state: 'running',
      listenPort: 51413,
      configuredListenPort: 6881,
      boundAddress: '10.2.0.2',
      vpn: { bindToVpn: true, enabled: true, connected: true, tunnelAddress: '10.2.0.2', forwardedPort: 51413, killSwitchEngaged: false },
      dhtNodes: 300,
      peers: 42,
      downloadRate: 2 * MiB,
      uploadRate: 512 * 1024,
      torrents: { total: 5, downloading: 2, seeding: 3, paused: 0, queued: 0, checking: 0, error: 0 },
    } satisfies TorrentSessionStatus;
    const status: VpnStatus = {
      enabled: true,
      provider: 'gluetun',
      connected: true,
      publicIp: '203.0.113.7',
      forwardedPort: 51413,
      killSwitchEngaged: false,
      lastChecked: '2026-01-01T00:00:00.000Z',
      lastChanged: null,
    };
    const service = svc({ torrent: () => engine, vpn: () => ({ status, pauseGrabsWhenDown: true }) });
    const { results } = await runCommands(service, 'engine\nvpn\nreport');
    expect(results[0]!.output).toMatch(/state\s+running/);
    expect(results[0]!.output).toMatch(/torrents\s+5 total: 2 downloading, 3 seeding/);
    expect(results[0]!.output).toMatch(/download\s+2\.0 MiB\/s/);
    expect(results[1]!.output).toMatch(/public IP\s+203\.0\.113\.7/);
    expect(results[1]!.output).toMatch(/forwarded port\s+51413/);
    expect(results[2]!.output).not.toContain('203.0.113.7');
    for (const s of ['== version ==', '== memory ==', '== handles ==', '== engine ==', '== vpn ==', '== logs ==']) expect(results[2]!.output).toContain(s);
    const snap = service.snapshot();
    expect(snap.engine).toMatchObject({ state: 'running', torrents: 5, peers: 42, listenPort: 51413 });
    expect(snap.vpn).toMatchObject({ provider: 'gluetun', connected: true, forwardedPort: 51413 });
    expect(snap.version).toBe('9.9.9-test');
    expect(snap.memory.rss).toBeGreaterThan(0);
  });

  it('a failing source degrades to "not available" instead of failing the run', async () => {
    const service = svc({
      torrent: () => {
        throw new Error('boom');
      },
    });
    const r = await one(service, 'engine');
    expect(r.output).toBe('Torrent engine: not available.');
    expect(service.snapshot().engine).toBeNull();
  });
});

describe('buffers (real in-process inspector)', () => {
  it('counts retained 64 KiB ArrayBuffers and groups them by size and first bytes', async () => {
    const keep: ArrayBuffer[] = [];
    for (let i = 0; i < 8; i++) {
      const ab = new ArrayBuffer(64 * 1024);
      new Uint8Array(ab).set([0xde, 0xb6, 0x99, 0x01, 0x41, 0x52, 0x43, 0x4c]); // de b6 99 01 "ARCL"
      keep.push(ab);
    }
    const census = await arrayBufferCensus(15);
    expect(census.count).toBeGreaterThanOrEqual(8);
    expect(census.totalBytes).toBeGreaterThanOrEqual(8 * 64 * 1024);
    const group = census.groups.find((g) => g.size === 65536 && g.head === 'deb69901');
    expect(group?.count).toBe(8);
    expect(group?.sampleHex).toBe('deb699014152434c00000000');
    expect(census.buckets.find((b) => b.label === '64-256 KiB')?.count).toBeGreaterThanOrEqual(8);

    const r = await one(svc(), 'buffers');
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^\d+ ArrayBuffers retained after GC, [\d.]+ MB total/);
    expect(r.output).toMatch(/65536\s+8\s+0\.50\s+de b6 99 01 41 52 43 4c 00 00 00 00\s+\.\.\.\.ARCL\.\.\.\./);
    expect(keep).toHaveLength(8);
  });

  it('gc reports memory before and after', async () => {
    const r = await one(svc(), 'gc');
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^Full GC took \d+ ms/);
    expect(r.output).toMatch(/heapUsed\s+[\d.]+ MiB\s+[\d.]+ MiB/);
  });

  it('falls back to totals when the census cannot run', async () => {
    const r = await one(
      svc({
        census: async () => {
          throw new Error('inspector unavailable');
        },
      }),
      'buffers',
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('could not run in-process (inspector unavailable)');
    expect(r.output).toMatch(/arrayBuffers\s+\S+/);
  });
});
