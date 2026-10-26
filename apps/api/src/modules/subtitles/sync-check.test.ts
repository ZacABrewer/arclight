import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { subtitleBlacklist, subtitleFiles } from './schema.js';
import { subtitlesRoutes } from './routes.js';
import { GOOD_EPISODE, candidate, setup, type Fixture, type RunnerCall } from './test-support.js';

// Sync-quality scoring in the service: the fake runner answers ffmpeg silencedetect with speech
// that matches GOOD_SRT exactly; BAD_SRT is the same subtitle 3 s early.

const STARTS = Array.from({ length: 60 }, (_, i) => 3000 + i * 4000 + ((i * i * 37) % 1900));
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ts = (ms: number) => `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
const srtFrom = (shift: number) => STARTS.map((s, i) => `${i + 1}\n${ts(s + shift)} --> ${ts(s + shift + 1500)}\nLine ${i + 1}\n`).join('\n');
const GOOD_SRT = srtFrom(0);
const BAD_SRT = srtFrom(-3000);

/** silencedetect output for speech at STARTS (1.5 s each) in a window starting at 0. */
function silenceLog(): string {
  const lines = ['[silencedetect @ 0x1] silence_start: 0'];
  for (const s of STARTS) {
    lines.push(`[silencedetect @ 0x1] silence_end: ${(s / 1000).toFixed(3)} | silence_duration: 1`);
    lines.push(`[silencedetect @ 0x1] silence_start: ${((s + 1500) / 1000).toFixed(3)}`);
  }
  return lines.join('\n');
}

const isAudioScan = (c: RunnerCall) => c.args.some((a) => a.startsWith('silencedetect'));

/** Runner: silencedetect answers with the true speech; ffsubsync writes `fixed` to its -o path. */
function runner(fixed = GOOD_SRT) {
  return async (call: RunnerCall) => {
    if (isAudioScan(call)) return { stderr: silenceLog() };
    if (call.command === 'ffsubsync') {
      await writeFile(call.args[call.args.indexOf('-o') + 1]!, fixed);
      return { stderr: 'offset seconds: 3.000\nframerate scale factor: 1.000' };
    }
    return undefined;
  };
}

let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.service.idle();
  await fx?.cleanup();
  fx = undefined;
});

async function fixture(run = runner()): Promise<Fixture> {
  fx = await setup({ runner: run });
  fx.settings((s) => {
    s.sync.autoCheck = true;
  });
  return fx;
}

const subPath = (f: Fixture) => f.videos.s1e1.replace(/\.mkv$/, '.en.srt');
const stateOf = (f: Fixture) => f.service.fileSubtitles({ mediaFileId: f.files.s1e1 })[0]!.subtitles.find((s) => !s.embedded)!;

describe('sync check after download', () => {
  it('scores an in-sync download and stores it on the file and its history entry', async () => {
    const f = await fixture();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('good', GOOD_SRT);
    await f.service.searchFile(f.files.s1e1);
    const st = stateOf(f);
    expect(st.syncScore).toBeGreaterThanOrEqual(95);
    expect(Math.abs(st.syncOffsetMs!)).toBeLessThan(100);
    expect(st).toMatchObject({ syncDriftPpm: 0, syncMethod: 'builtin' });
    expect(st.syncCheckedAt).toBeTruthy();
    const scan = f.runner.calls.find(isAudioScan)!;
    expect(scan.args).toEqual(expect.arrayContaining(['-ss', '0.000', '-t', '600.000', '-i', f.videos.s1e1]));
    const h = f.service.history({ page: 1, pageSize: 5, action: 'downloaded' }).records[0]!;
    expect(h.syncScore).toBe(st.syncScore);
  });

  it('does nothing while autoCheck is off', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.sync.autoCheck = false;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('good', GOOD_SRT);
    await f.service.searchFile(f.files.s1e1);
    expect(f.runner.calls.some(isAudioScan)).toBe(false);
    expect(stateOf(f).syncScore).toBeNull();
  });

  it('autoFixBelow runs the sync tool and scores the fixed file again', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.sync.autoFixBelow = 70;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'bad', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('bad', BAD_SRT);
    await f.service.searchFile(f.files.s1e1);
    expect(f.runner.calls.filter((c) => c.command === 'ffsubsync')).toHaveLength(1);
    expect(f.runner.calls.filter(isAudioScan)).toHaveLength(2);
    expect(await readFile(subPath(f), 'utf8')).toBe(GOOD_SRT);
    expect(stateOf(f).syncScore).toBeGreaterThanOrEqual(95);
    expect(f.service.history({ page: 1, pageSize: 5, action: 'synced' }).records).toHaveLength(1);
  });

  it('autoRetryProviderBelow blacklists a badly timed download and takes the next candidate', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.sync.autoRetryProviderBelow = 50;
    });
    f.providers.podnapisi.candidates = [
      candidate('podnapisi', 'bad', { matches: [...GOOD_EPISODE, 'resolution', 'video_codec'] }),
      candidate('podnapisi', 'good', { matches: GOOD_EPISODE }),
    ];
    f.providers.podnapisi.contents.set('bad', BAD_SRT);
    f.providers.podnapisi.contents.set('good', GOOD_SRT);
    const r = await f.service.searchFile(f.files.s1e1);
    expect(r.downloaded).toBe(1);
    expect(f.providers.podnapisi.downloads).toEqual(['bad', 'good']);
    expect(stateOf(f)).toMatchObject({ providerSubtitleId: 'good' });
    expect(stateOf(f).syncScore).toBeGreaterThanOrEqual(95);
    expect(f.db.select().from(subtitleBlacklist).all().map((b) => b.providerSubtitleId)).toEqual(['bad']);
    const deleted = f.service.history({ page: 1, pageSize: 10, action: 'deleted' }).records[0]!;
    expect(deleted.description).toMatch(/blacklisted: sync score \d+ is below 50/);
    expect(deleted.syncScore).toBeLessThan(50);
  });

  it('stops retrying after maxProviderRetries and keeps the last download', async () => {
    const f = await fixture();
    f.settings((s) => {
      s.sync.autoRetryProviderBelow = 50;
      s.sync.maxProviderRetries = 0;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'bad', { matches: GOOD_EPISODE }), candidate('podnapisi', 'good2', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('bad', BAD_SRT);
    await f.service.searchFile(f.files.s1e1);
    expect(f.providers.podnapisi.downloads).toEqual(['bad']);
    expect(stateOf(f).syncScore).toBeLessThan(50);
    expect(f.db.select().from(subtitleBlacklist).all()).toHaveLength(0);
  });
});

describe('on-demand and batch checks', () => {
  async function withSubtitle(text: string, run = runner()) {
    const f = await fixture(run);
    f.settings((s) => {
      s.sync.autoCheck = false;
    });
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'x', { matches: GOOD_EPISODE })];
    f.providers.podnapisi.contents.set('x', text);
    await f.service.searchFile(f.files.s1e1);
    return { f, id: stateOf(f).id };
  }

  it('POST /subtitle/:id/synccheck measures and GET /subtitle/file exposes the result', async () => {
    const { f, id } = await withSubtitle(BAD_SRT);
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('auth', null);
    app.addHook('onRequest', async (req) => {
      req.auth = { user: null, via: 'apiKey', isAdmin: true } as never;
    });
    await app.register(subtitlesRoutes(f.service), { prefix: '/api/v1' });
    const res = await app.inject({ method: 'POST', url: `/api/v1/subtitle/${id}/synccheck` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, actions: [], check: { method: 'builtin', reliable: true, driftPpm: 0 } });
    expect(Math.abs(body.check.offsetMs - 3000)).toBeLessThan(100);
    expect(body.check.syncScore).toBeLessThan(10);
    const file = await app.inject({ method: 'GET', url: `/api/v1/subtitle/file?mediaFileId=${f.files.s1e1}` });
    expect(file.json()[0].subtitles[0]).toMatchObject({ syncScore: body.check.syncScore, syncMethod: 'builtin' });
    const embedded = await app.inject({ method: 'POST', url: '/api/v1/subtitle/99999/synccheck' });
    expect(embedded.statusCode).toBe(404);
    await app.close();
  });

  it('the tool method compares the sync tool output and removes its scratch file', async () => {
    const shifted = srtFrom(1200);
    const { f, id } = await withSubtitle(GOOD_SRT, runner(shifted));
    f.settings((s) => {
      s.sync.checkMethod = 'tool';
    });
    const r = await f.service.syncCheck(id);
    expect(r.check).toMatchObject({ method: 'ffsubsync', offsetMs: 1200, driftPpm: 0, meanErrorMs: 1200 });
    const call = f.runner.calls.find((c) => c.command === 'ffsubsync')!;
    expect(call.args).toContain('--no-fix-framerate');
    expect(existsSync(subPath(f).replace(/\.srt$/, '.synccheck.srt'))).toBe(false);
    expect(await readFile(subPath(f), 'utf8')).toBe(GOOD_SRT);
  });

  it('reports a failed audio analysis without storing a score', async () => {
    const { f, id } = await withSubtitle(GOOD_SRT, async (call) => (isAudioScan(call) ? { ok: false, exitCode: 1, stderr: 'no audio' } : undefined));
    const r = await f.service.syncCheck(id);
    expect(r).toMatchObject({ ok: false, check: null });
    expect(r.message).toMatch(/audio analysis failed/);
    expect(stateOf(f).syncCheckedAt).toBeNull();
  });

  it('the SubtitleSyncCheck job scores unchecked subtitles only while autoCheck is on', async () => {
    const { f, id } = await withSubtitle(GOOD_SRT);
    expect(await f.service.syncCheckBatch()).toMatch(/off/);
    f.settings((s) => {
      s.sync.autoCheck = true;
    });
    expect(await f.service.syncCheckBatch()).toMatch(/^Checked 1 subtitle/);
    expect(f.db.select().from(subtitleFiles).where(eq(subtitleFiles.id, id)).get()!.syncScore).toBeGreaterThanOrEqual(95);
    expect(await f.service.syncCheckBatch()).toMatch(/^Checked 0 subtitle/);
  });

  it('the job re-searches when a provider subtitle scores below autoRetryProviderBelow', async () => {
    const { f, id } = await withSubtitle(BAD_SRT);
    f.settings((s) => {
      s.sync.autoCheck = true;
      s.sync.autoRetryProviderBelow = 50;
    });
    expect(await f.service.syncCheckBatch()).toMatch(/1 re-searched/);
    await f.service.idle();
    expect(f.db.select().from(subtitleBlacklist).all().map((b) => b.providerSubtitleId)).toEqual(['x']);
    expect(f.db.select().from(subtitleFiles).where(eq(subtitleFiles.id, id)).get()).toBeUndefined();
  });
});
