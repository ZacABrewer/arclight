import { describe, expect, it } from 'vitest';
import {
  CustomFormatSpec as CustomFormatSpecSchema,
  QUALITIES,
  ReleaseKind,
  type CustomFormat,
  type CustomFormatSpec,
  type QualityDefinition,
  type ReleaseAudioEvaluation,
  type ReleaseEvaluation,
} from '@arclight/shared';
import {
  customFormatDomain,
  customFormatDomains,
  customFormatFitsDomain,
  DEFAULT_AUDIO_SIZES,
  defaultQualitySize,
  formatMatches,
  specDomains,
  specImplementations,
  specMatches,
  validateCustomFormat,
} from './index.js';

const qm = (q: QualityDefinition) => ({ quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

const audio = (over: Partial<ReleaseAudioEvaluation> = {}): ReleaseAudioEvaluation => ({
  codec: 'FLAC',
  bitDepth: 24,
  sampleRateHz: 96000,
  source: 'web',
  hasLog: false,
  hasCue: false,
  ...over,
});

const album = (a: ReleaseAudioEvaluation | undefined, over: Partial<ReleaseEvaluation> = {}): ReleaseEvaluation => ({
  title: 'Artist - Album (2020) [FLAC 24-96]',
  languages: [],
  quality: qm(QUALITIES['FLAC-24bit']),
  mediaType: 'music',
  releaseKind: 'single',
  ...(a ? { audio: a } : {}),
  ...over,
});

const spec = <I extends CustomFormatSpec['implementation']>(
  implementation: I,
  fields: Extract<CustomFormatSpec, { implementation: I }>['fields'],
  negate = false,
): CustomFormatSpec => ({ implementation, name: implementation, negate, required: false, fields }) as CustomFormatSpec;

const format = (...specifications: CustomFormatSpec[]): CustomFormat => ({ id: 1, name: 'cf', includeWhenRenaming: false, specifications });

type Row = [label: string, s: CustomFormatSpec, a: ReleaseAudioEvaluation, expected: boolean];

const ROWS: Row[] = [
  // audioCodec
  ['codec FLAC = FLAC', spec('audioCodec', { codec: 'FLAC' }), audio(), true],
  ['codec MP3 != FLAC', spec('audioCodec', { codec: 'MP3' }), audio(), false],
  ['codec Unknown = Unknown', spec('audioCodec', { codec: 'Unknown' }), audio({ codec: 'Unknown' }), true],
  // audioBitrate
  ['bitrate 320 in 256-320', spec('audioBitrate', { minKbps: 256, maxKbps: 320 }), audio({ codec: 'MP3', bitrateKbps: 320 }), true],
  ['bitrate 192 not in 256-320', spec('audioBitrate', { minKbps: 256, maxKbps: 320 }), audio({ codec: 'MP3', bitrateKbps: 192 }), false],
  ['bitrate bounds inclusive', spec('audioBitrate', { minKbps: 192, maxKbps: 192 }), audio({ codec: 'MP3', bitrateKbps: 192 }), true],
  ['V0 counts as 245', spec('audioBitrate', { minKbps: 220, maxKbps: 260 }), audio({ codec: 'MP3', vbrPreset: 'V0' }), true],
  ['V2 counts as 190', spec('audioBitrate', { minKbps: 220, maxKbps: 260 }), audio({ codec: 'MP3', vbrPreset: 'V2' }), false],
  ['no bitrate never matches', spec('audioBitrate', { minKbps: 0, maxKbps: 10000 }), audio(), false],
  // bitDepth
  ['24-bit = 24', spec('bitDepth', { bitDepth: 24 }), audio(), true],
  ['16-bit != 24', spec('bitDepth', { bitDepth: 16 }), audio(), false],
  ['unknown depth never matches', spec('bitDepth', { bitDepth: 16 }), audio({ bitDepth: undefined }), false],
  // sampleRate
  ['96 kHz in 88.2-192', spec('sampleRate', { minKhz: 88.2, maxKhz: 192 }), audio(), true],
  ['44.1 kHz exact band', spec('sampleRate', { minKhz: 44.1, maxKhz: 44.1 }), audio({ sampleRateHz: 44100 }), true],
  ['48 kHz not in 88.2-192', spec('sampleRate', { minKhz: 88.2, maxKhz: 192 }), audio({ sampleRateHz: 48000 }), false],
  ['unknown rate never matches', spec('sampleRate', { minKhz: 0, maxKhz: 1000 }), audio({ sampleRateHz: undefined }), false],
  // audioSource
  ['source web = web', spec('audioSource', { source: 'web' }), audio(), true],
  ['source cd != web', spec('audioSource', { source: 'cd' }), audio(), false],
  ['source vinyl = vinyl', spec('audioSource', { source: 'vinyl' }), audio({ source: 'vinyl' }), true],
  ['source other = other', spec('audioSource', { source: 'other' }), audio({ source: 'other' }), true],
  ['unknown source never matches', spec('audioSource', { source: 'other' }), audio({ source: undefined }), false],
  // ripLog
  ['log required, present', spec('ripLog', { requireLog: true, minScore: 0, requireCue: false }), audio({ hasLog: true }), true],
  ['log required, missing', spec('ripLog', { requireLog: true, minScore: 0, requireCue: false }), audio(), false],
  ['score 100 met', spec('ripLog', { requireLog: false, minScore: 100, requireCue: false }), audio({ hasLog: true, logScore: 100 }), true],
  ['score 100 not met by 95', spec('ripLog', { requireLog: true, minScore: 100, requireCue: false }), audio({ hasLog: true, logScore: 95 }), false],
  ['score needs a stated score', spec('ripLog', { requireLog: true, minScore: 50, requireCue: false }), audio({ hasLog: true }), false],
  ['log + cue required, cue missing', spec('ripLog', { requireLog: true, minScore: 0, requireCue: true }), audio({ hasLog: true }), false],
  ['log + cue required, both', spec('ripLog', { requireLog: true, minScore: 0, requireCue: true }), audio({ hasLog: true, hasCue: true }), true],
  ['cue only', spec('ripLog', { requireLog: false, minScore: 0, requireCue: true }), audio({ hasCue: true }), true],
  ['nothing required: log or cue', spec('ripLog', { requireLog: false, minScore: 0, requireCue: false }), audio({ hasCue: true }), true],
  ['nothing required, neither', spec('ripLog', { requireLog: false, minScore: 0, requireCue: false }), audio(), false],
  // audiobook specs (wave 3 fills these in)
  ['layout single', spec('fileLayout', { layout: 'single' }), audio({ codec: 'AAC', fileLayout: 'single' }), true],
  ['layout multi != single', spec('fileLayout', { layout: 'multi' }), audio({ codec: 'AAC', fileLayout: 'single' }), false],
  ['layout unknown', spec('fileLayout', { layout: 'single' }), audio({ codec: 'AAC' }), false],
  ['format unabridged', spec('formatType', { formatType: 'unabridged' }), audio({ codec: 'AAC', formatType: 'unabridged' }), true],
  ['format abridged != unabridged', spec('formatType', { formatType: 'abridged' }), audio({ codec: 'AAC', formatType: 'unabridged' }), false],
  ['narrator matches one of several', spec('narrator', { pattern: '^jane' }), audio({ codec: 'AAC', narrators: ['John Reader', 'Jane Voice'] }), true],
  ['narrator no match', spec('narrator', { pattern: 'nobody' }), audio({ codec: 'AAC', narrators: ['Jane Voice'] }), false],
  ['narrator unknown', spec('narrator', { pattern: '.' }), audio({ codec: 'AAC' }), false],
];

describe('audio custom-format specs', () => {
  it.each(ROWS)('%s', (_label, s, a, expected) => {
    expect(specMatches(s, album(a))).toBe(expected);
    // Negation flips a decided match.
    expect(specMatches({ ...s, negate: true }, album(a))).toBe(!expected);
  });

  it('evaluates every audio spec false without an audio block', () => {
    for (const [, s] of ROWS) expect(specMatches(s, album(undefined))).toBe(false);
  });

  it('combines audio specs like any other format', () => {
    const hiRes = format(spec('audioCodec', { codec: 'FLAC' }), spec('bitDepth', { bitDepth: 24 }), spec('audioSource', { source: 'web' }));
    expect(formatMatches(hiRes, album(audio()))).toBe(true);
    expect(formatMatches(hiRes, album(audio({ bitDepth: 16 })))).toBe(false);
    // Specs of one kind are alternatives.
    const lossless = format(spec('audioCodec', { codec: 'FLAC' }), spec('audioCodec', { codec: 'ALAC' }));
    expect(formatMatches(lossless, album(audio({ codec: 'ALAC' })))).toBe(true);
    expect(formatMatches(lossless, album(audio({ codec: 'MP3' })))).toBe(false);
  });

  it('matches the new release types', () => {
    expect(specMatches(spec('releaseType', { releaseType: 'discography' }), album(audio(), { releaseKind: 'discography' }))).toBe(true);
    expect(specMatches(spec('releaseType', { releaseType: 'multiAlbum' }), album(audio(), { releaseKind: 'discography' }))).toBe(false);
    expect(specMatches(spec('releaseType', { releaseType: 'bookPack' }), album(audio(), { releaseKind: 'bookPack' }))).toBe(true);
    expect(ReleaseKind.options).toEqual(expect.arrayContaining(['discography', 'multiAlbum', 'bookPack']));
  });

  it('parses every audio spec through the shared schema with defaults', () => {
    const parsed = CustomFormatSpecSchema.parse({ implementation: 'ripLog', name: 'log', fields: {} });
    expect(parsed).toEqual({ implementation: 'ripLog', name: 'log', negate: false, required: false, fields: { requireLog: false, minScore: 0, requireCue: false } });
    expect(() => CustomFormatSpecSchema.parse({ implementation: 'audioSource', name: 's', fields: { source: 'dat' } })).toThrow();
    expect(() => CustomFormatSpecSchema.parse({ implementation: 'bitDepth', name: 'b', fields: { bitDepth: 20 } })).toThrow();
  });

  it('validates ranges and patterns', () => {
    const bad = format(
      spec('audioBitrate', { minKbps: 320, maxKbps: 128 }),
      spec('sampleRate', { minKhz: 96, maxKhz: 44.1 }),
      spec('narrator', { pattern: '(' }),
    );
    expect(validateCustomFormat(bad).map((i) => i.path)).toEqual(['specifications[0]', 'specifications[1]', 'specifications[2]']);
    expect(validateCustomFormat(format(spec('audioBitrate', { minKbps: 128, maxKbps: 320 })))).toEqual([]);
  });

  it('describes the audio specs for the editor', () => {
    const defs = new Map(specImplementations().map((d) => [d.implementation, d]));
    expect(defs.get('audioSource')?.fields[0]?.options?.map((o) => o.value)).toEqual(['cd', 'web', 'vinyl', 'sacd', 'cassette', 'other']);
    expect(defs.get('ripLog')?.fields.map((f) => f.name)).toEqual(['requireLog', 'minScore', 'requireCue']);
    expect(defs.get('audioCodec')?.mediaTypes).toEqual(['music', 'audiobook']);
    expect(defs.get('narrator')?.mediaTypes).toEqual(['audiobook']);
    // Video-only kinds are not offered for audio.
    expect(defs.get('resolution')?.mediaTypes).toEqual(['series', 'movie']);
  });
});

describe('customFormatDomain', () => {
  type DomainRow = [label: string, specs: CustomFormatSpec[], label2: ReturnType<typeof customFormatDomain>, domains: string[]];
  const rows: DomainRow[] = [
    ['no specs', [], 'any', ['video', 'music', 'audiobook']],
    ['title only', [spec('releaseTitle', { pattern: 'x' })], 'any', ['video', 'music', 'audiobook']],
    ['group + size', [spec('releaseGroup', { pattern: 'x' }), spec('size', { minGb: 0, maxGb: 1 })], 'any', ['video', 'music', 'audiobook']],
    ['resolution', [spec('resolution', { resolution: 1080 })], 'video', ['video']],
    ['title + source', [spec('releaseTitle', { pattern: 'x' }), spec('source', { source: 'web' })], 'video', ['video']],
    ['season pack', [spec('releaseType', { releaseType: 'seasonPack' })], 'video', ['video']],
    ['single release', [spec('releaseType', { releaseType: 'single' })], 'any', ['video', 'music', 'audiobook']],
    ['discography', [spec('releaseType', { releaseType: 'discography' })], 'music', ['music']],
    ['book pack', [spec('releaseType', { releaseType: 'bookPack' })], 'audiobook', ['audiobook']],
    ['codec only fits both audio domains', [spec('audioCodec', { codec: 'Opus' })], 'music', ['music', 'audiobook']],
    ['rip log', [spec('ripLog', { requireLog: true, minScore: 100, requireCue: false })], 'music', ['music']],
    ['negated vinyl', [spec('audioSource', { source: 'vinyl' }, true)], 'music', ['music']],
    ['narrator + codec', [spec('narrator', { pattern: 'x' }), spec('audioCodec', { codec: 'AAC' })], 'audiobook', ['audiobook']],
    ['contradictory', [spec('resolution', { resolution: 1080 }), spec('audioCodec', { codec: 'FLAC' })], 'video', []],
  ];

  it.each(rows)('%s', (_label, specs, want, domains) => {
    const f = format(...specs);
    expect(customFormatDomain(f)).toBe(want);
    expect(customFormatDomains(f)).toEqual(domains);
    for (const d of ['video', 'music', 'audiobook'] as const) expect(customFormatFitsDomain(f, d)).toBe(domains.includes(d));
  });

  it('classifies every spec kind', () => {
    for (const def of specImplementations()) {
      const domains = specDomains({ implementation: def.implementation, name: 'x', negate: false, required: false, fields: { releaseType: 'single' } } as CustomFormatSpec);
      expect(domains.length).toBeGreaterThan(0);
    }
  });
});

describe('default audio sizes', () => {
  it('covers every audio quality with ordered bands and none for video', () => {
    for (const q of Object.values(QUALITIES)) {
      const s = defaultQualitySize(q.id);
      if (!q.audio) {
        expect(s).toEqual({ minSize: null, preferredSize: null, maxSize: null });
        continue;
      }
      expect(s.minSize, q.name).not.toBeNull();
      expect(s.minSize!).toBeLessThanOrEqual(s.preferredSize!);
      expect(s.preferredSize!).toBeLessThanOrEqual(s.maxSize!);
    }
  });

  it('uses the design bands', () => {
    expect(DEFAULT_AUDIO_SIZES['MP3-320']).toMatchObject({ minSize: 2.2, maxSize: 2.6 });
    expect(DEFAULT_AUDIO_SIZES['MP3-VBR-V0']).toMatchObject({ minSize: 1.4, maxSize: 2.4 });
    expect(DEFAULT_AUDIO_SIZES.FLAC).toMatchObject({ minSize: 3.5, maxSize: 12 });
    expect(DEFAULT_AUDIO_SIZES['FLAC-24bit']).toMatchObject({ minSize: 8, maxSize: 40 });
    expect(DEFAULT_AUDIO_SIZES['AB-AAC']).toMatchObject({ minSize: 0.25, maxSize: 1.5 });
  });
});
