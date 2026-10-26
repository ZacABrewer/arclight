import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { configError, credentialsChanged, maskProviders, providerSchemas, unmaskSettings } from './providers.js';
import { createFfprobe, embeddedFromMediaInfo, embeddedFromProbe, scanExternal } from './scan.js';
import { fakeRunner } from './test-support.js';

const opts = { ignorePgs: false, ignoreVobsub: false, ignoreAss: false, undefinedLanguage: null };

describe('external subtitle scan', () => {
  let dir: string;
  let video: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-scan-'));
    video = join(dir, 'Show.S01E01.mkv');
    await writeFile(video, 'v');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const touch = (name: string, content = 'x') => writeFile(join(dir, name), content);

  it('parses language, forced and HI suffixes of files next to the video', async () => {
    for (const n of ['Show.S01E01.en.srt', 'Show.S01E01.en.forced.srt', 'Show.S01E01.en.hi.srt', 'Show.S01E01.pt-BR.ass', 'Show.S01E02.en.srt', 'Show.S01E01.nfo']) await touch(n);
    const found = (await scanExternal(video)).map((s) => `${s.language}|${s.forced}|${s.hi}|${s.format}`).sort();
    expect(found).toEqual(['en|false|false|srt', 'en|false|true|srt', 'en|true|false|srt', 'pt-BR|false|false|ass']);
  });

  it('treats sdh and cc as HI, forced wins, and three-letter codes normalize', async () => {
    await touch('Show.S01E01.eng.sdh.srt');
    await touch('Show.S01E01.fre.forced.cc.srt');
    const found = await scanExternal(video);
    expect(found.find((s) => s.language === 'en')).toMatchObject({ hi: true, forced: false });
    expect(found.find((s) => s.language === 'fr')).toMatchObject({ hi: false, forced: true });
  });

  it('skips files without a language and scans extra folders', async () => {
    await touch('Show.S01E01.srt');
    await mkdir(join(dir, 'Subs'));
    await writeFile(join(dir, 'Subs', 'Show.S01E01.de.srt'), 'x');
    const found = await scanExternal(video, [join(dir, 'Subs')]);
    expect(found.map((s) => s.language)).toEqual(['de']);
    expect(found[0]!.size).toBe(1);
  });
});

describe('embedded tracks', () => {
  const probe = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'Forced' } },
      { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'eng', title: 'English SDH' } },
      { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'ger' }, disposition: { forced: 1 } },
      { index: 6, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'und' } },
    ],
  };

  it('maps languages, forced and HI from tags and dispositions', () => {
    expect(embeddedFromProbe(probe, opts).map((t) => [t.streamIndex, t.language, t.forced, t.hi])).toEqual([
      [2, 'en', false, false],
      [3, 'en', true, false],
      [4, 'en', false, true],
      [5, 'de', true, false],
    ]);
  });

  it('honours the ignore options and the undefined-language fallback', () => {
    const t = embeddedFromProbe(probe, { ignorePgs: true, ignoreVobsub: false, ignoreAss: true, undefinedLanguage: 'ja' });
    expect(t.map((x) => x.streamIndex)).toEqual([2, 3, 6]);
    expect(t.find((x) => x.streamIndex === 6)?.language).toBe('ja');
  });

  it('falls back to media info languages', () => {
    expect(embeddedFromMediaInfo({ subtitles: ['eng', 'spa', 'und'] }, opts).map((t) => t.language)).toEqual(['en', 'es']);
  });

  it('ffprobe goes through the runner and returns null on failure', async () => {
    const ok = fakeRunner(() => ({ stdout: Buffer.from(JSON.stringify(probe)) }));
    const result = await createFfprobe(ok.runner, () => 'ffprobe')('/v.mkv');
    expect(result?.streams).toHaveLength(6);
    expect(ok.calls[0]!.args).toEqual(['-v', 'error', '-print_format', 'json', '-show_streams', '/v.mkv']);
    const bad = fakeRunner(() => ({ ok: false, exitCode: null, error: 'spawn ffprobe ENOENT' }));
    expect(await createFfprobe(bad.runner, () => 'ffprobe')('/v.mkv')).toBeNull();
  });
});

describe('provider registry', () => {
  it('exposes a schema for every provider with secret fields marked', () => {
    const schemas = providerSchemas();
    expect(schemas.map((s) => s.id)).toContain('opensubtitlescom');
    const osc = schemas.find((s) => s.id === 'opensubtitlescom')!;
    expect(osc.fields.find((f) => f.name === 'apiKey')).toMatchObject({ secret: true, required: true });
    expect(schemas.find((s) => s.id === 'gestdown')!.mediaTypes).toEqual(['series']);
  });

  it('masks secrets, keeps stored values for the mask and detects credential changes', () => {
    const stored = { username: 'u', password: 'secret', apiKey: 'k' };
    const masked = maskProviders([{ id: 'opensubtitlescom', enabled: true, settings: stored }]);
    expect(masked[0]!.settings).toEqual({ username: 'u', password: SECRET_MASK, apiKey: SECRET_MASK });
    const back = unmaskSettings('opensubtitlescom', masked[0]!.settings, stored);
    expect(back).toEqual(stored);
    expect(credentialsChanged('opensubtitlescom', stored, back)).toBe(false);
    expect(credentialsChanged('opensubtitlescom', stored, { ...back, password: 'new' })).toBe(true);
    expect(configError('opensubtitlescom', { username: 'u' })).toMatch(/Password/);
    expect(configError('podnapisi', {})).toBeNull();
  });
});
