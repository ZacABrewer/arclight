import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { WhisperProbeResult } from '@arclight/subtitles';
import type { HealthDeps } from '../health/types.js';
import { subtitlesRoutes } from './routes.js';
import { WHISPER_AUTO_KEY, type SubtitlesService } from './service.js';
import { FakeProvider, GOOD_EPISODE, candidate, setup, type Fixture } from './test-support.js';
import { whisperUnreachableCheck } from './whisper.js';

// Bundled Whisper: auto-registration, status, health check and the onlyWhenNoOtherResult flag.

const URL = 'http://whisper:9000';

let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.service.idle();
  await fx?.cleanup();
  fx = undefined;
});

function prober(up: boolean) {
  const calls: string[] = [];
  const probe = async (url: string): Promise<WhisperProbeResult> => {
    calls.push(url);
    return up ? { ok: true, via: 'docs', message: `Whisper answered at ${url}/docs (200)` } : { ok: false, via: null, message: `Whisper not reachable at ${url}: fetch failed` };
  };
  return { probe, calls };
}

async function withWhisper(o: { url?: string | undefined; up?: boolean } = {}) {
  fx = await setup();
  const p = prober(o.up ?? true);
  const whisper = new FakeProvider('whisperai');
  const service = fx.makeService({
    whisperUrl: 'url' in o ? o.url : URL,
    probeWhisper: p.probe,
    createProvider: (id) => {
      const fake = id === 'whisperai' ? whisper : (fx!.providers as Record<string, FakeProvider | undefined>)[id];
      if (!fake) throw new Error(`no fake for ${id}`);
      return fake;
    },
  });
  return { f: fx, service, probe: p, whisper };
}

const whisperEntry = (service: SubtitlesService) => service.settings().providers.find((p) => p.id === 'whisperai');

describe('WhisperAutoDetect', () => {
  it('registers Whisper last, enabled, onlyWhenNoOtherResult, when the URL answers', async () => {
    const { service, f } = await withWhisper();
    expect(await service.whisperAutoDetect()).toMatch(/registered at http:\/\/whisper:9000/);
    const ids = service.settings().providers.map((p) => p.id);
    expect(ids[ids.length - 1]).toBe('whisperai');
    expect(whisperEntry(service)).toEqual({ id: 'whisperai', enabled: true, settings: { endpoint: URL, onlyWhenNoOtherResult: true, [WHISPER_AUTO_KEY]: true } });
    expect(f.events.some((e) => e.type === 'subtitle' && e.action === 'settings')).toBe(true);
    expect(await service.whisperAutoDetect()).toBe('Whisper provider already registered');
  });

  it('registers nothing while the service does not answer', async () => {
    const { service } = await withWhisper({ up: false });
    expect(await service.whisperAutoDetect()).toMatch(/^Whisper not detected: .*fetch failed/);
    expect(whisperEntry(service)).toBeUndefined();
  });

  it('is a no-op without ARCLIGHT_WHISPER_URL', async () => {
    const { service, probe } = await withWhisper({ url: undefined });
    expect(await service.whisperAutoDetect()).toBe('ARCLIGHT_WHISPER_URL is not set');
    expect(probe.calls).toHaveLength(0);
  });

  it('leaves a hand-configured Whisper entry alone but follows the URL for its own entry', async () => {
    const { service, f } = await withWhisper();
    f.settings((s) => {
      s.providers.push({ id: 'whisperai', enabled: false, settings: { endpoint: 'http://gpu-box:9000' } });
    });
    expect(await service.whisperAutoDetect()).toMatch(/configured by hand/);
    expect(whisperEntry(service)!.settings['endpoint']).toBe('http://gpu-box:9000');
    f.settings((s) => {
      s.providers = s.providers.filter((p) => p.id !== 'whisperai');
      s.providers.push({ id: 'whisperai', enabled: true, settings: { endpoint: 'http://old:9000', [WHISPER_AUTO_KEY]: true } });
    });
    expect(await service.whisperAutoDetect()).toBe(`Whisper endpoint updated to ${URL}`);
    expect(whisperEntry(service)!.settings['endpoint']).toBe(URL);
  });
});

describe('Whisper status and health', () => {
  it('GET /subtitle/whisper/status reports registration and a live probe', async () => {
    const { service } = await withWhisper();
    await service.whisperAutoDetect();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('auth', null);
    app.addHook('onRequest', async (req) => {
      req.auth = { user: null, via: 'apiKey', isAdmin: true } as never;
    });
    await app.register(subtitlesRoutes(service), { prefix: '/api/v1' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/subtitle/whisper/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ envUrl: URL, endpoint: URL, registered: true, enabled: true, autoRegistered: true, onlyWhenNoOtherResult: true, reachable: true });
    await app.close();
  });

  it('status without any configuration has nothing to probe', async () => {
    const { service, probe } = await withWhisper({ url: undefined });
    expect(await service.whisperStatus()).toMatchObject({ envUrl: null, registered: false, reachable: null });
    expect(probe.calls).toHaveLength(0);
  });

  it('WhisperUnreachable warns only for an enabled provider that does not answer', async () => {
    const down = await withWhisper({ up: false });
    down.f.settings((s) => {
      s.providers.push({ id: 'whisperai', enabled: true, settings: { endpoint: URL } });
    });
    const deps = (svc: SubtitlesService) => ({ whisper: () => svc.whisperStatus() }) as unknown as HealthDeps;
    const findings = await whisperUnreachableCheck.run(deps(down.service));
    expect(findings).toEqual([expect.objectContaining({ source: 'WhisperUnreachable', status: 'warning', wikiUrl: '/docs/system/health#whisper-unreachable' })]);
    down.f.settings((s) => {
      s.providers = s.providers.map((p) => (p.id === 'whisperai' ? { ...p, enabled: false } : p));
    });
    expect(await whisperUnreachableCheck.run(deps(down.service))).toEqual([]);
    expect(await whisperUnreachableCheck.run({} as HealthDeps)).toEqual([]);
  });
});

describe('onlyWhenNoOtherResult in the pipeline', () => {
  it('uses Whisper only when the other providers found nothing acceptable', async () => {
    const { service, f, whisper } = await withWhisper();
    await service.whisperAutoDetect();
    whisper.candidates = [candidate('whisperai', 'asr-en', { matches: ['series', 'season', 'episode', 'year', 'source'] })];
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    await service.searchFile(f.files.s1e1);
    expect(whisper.searches).toHaveLength(0);
    // Nothing from the other providers for the next file: Whisper is searched and used.
    f.providers.podnapisi.candidates = [];
    await service.searchFile(f.files.s2e1);
    expect(whisper.searches).toHaveLength(1);
    expect(whisper.downloads).toEqual(['asr-en']);
  });
});
