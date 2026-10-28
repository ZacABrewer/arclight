import { describe, expect, it } from 'vitest';
import { QUALITIES, type CustomFormat, type CustomFormatSpec, type ReleaseAudioEvaluation, type ReleaseEvaluation } from '@arclight/shared';
import { formatMatches, resolveFileLayout, specMatches, type AudioLayoutHints } from './index.js';

// Audiobook custom-format specs: fileLayout, formatType, narrator (design section 7).

type Audio = ReleaseAudioEvaluation & AudioLayoutHints;

const audio = (over: Partial<Audio> = {}): Audio => ({ codec: 'AAC', hasLog: false, hasCue: false, ...over });

const book = (a: Audio | undefined, over: Partial<ReleaseEvaluation> & AudioLayoutHints = {}): ReleaseEvaluation => ({
  title: 'Author - Title (Unabridged) [m4b]',
  languages: [],
  quality: { quality: { ...QUALITIES['AB-AAC'], mediaTypes: [...QUALITIES['AB-AAC'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
  mediaType: 'audiobook',
  releaseKind: 'single',
  ...(a ? { audio: a } : {}),
  ...over,
});

const spec = <I extends CustomFormatSpec['implementation']>(
  implementation: I,
  fields: Extract<CustomFormatSpec, { implementation: I }>['fields'],
  negate = false,
): CustomFormatSpec => ({ implementation, name: implementation, negate, required: false, fields }) as CustomFormatSpec;

const single = spec('fileLayout', { layout: 'single' });
const multi = spec('fileLayout', { layout: 'multi' });

describe('fileLayout', () => {
  type Row = [label: string, a: Audio, ev: AudioLayoutHints, single: boolean, multi: boolean];
  const rows: Row[] = [
    ['one file', audio({ fileCount: 1 }), {}, true, false],
    ['many files', audio({ fileCount: 24 }), {}, false, true],
    ['file count beats the container', audio({ fileCount: 30, container: 'm4b' }), {}, false, true],
    ['file count beats the stated layout', audio({ fileCount: 1, fileLayout: 'multi' }), {}, true, false],
    ['file count on the evaluation', audio({ container: 'mp3' }), { fileCount: 1 }, true, false],
    ['stated layout', audio({ fileLayout: 'multi' }), {}, false, true],
    ['stated layout beats the container', audio({ fileLayout: 'single', container: 'mp3' }), {}, true, false],
    ['m4b hints single', audio({ container: 'm4b' }), {}, true, false],
    ['.M4B hints single', audio({ container: '.M4B' }), {}, true, false],
    ['mp3 hints multi', audio({ codec: 'MP3', container: 'mp3' }), {}, false, true],
    ['flac hints multi', audio({ codec: 'FLAC', container: 'flac' }), {}, false, true],
    ['container on the evaluation', audio(), { container: 'm4b' }, true, false],
    ['m4a tells nothing', audio({ container: 'm4a' }), {}, false, false],
    ['zero files is unknown', audio({ fileCount: 0 }), {}, false, false],
    ['nothing known', audio(), {}, false, false],
  ];

  it.each(rows)('%s', (_label, a, ev, wantSingle, wantMulti) => {
    expect(specMatches(single, book(a, ev))).toBe(wantSingle);
    expect(specMatches(multi, book(a, ev))).toBe(wantMulti);
  });

  it('negates the raw match', () => {
    // Unknown layout: the raw spec is false, so the negated spec is true.
    expect(specMatches(spec('fileLayout', { layout: 'single' }, true), book(audio()))).toBe(true);
    expect(specMatches(spec('fileLayout', { layout: 'single' }, true), book(audio({ container: 'm4b' })))).toBe(false);
  });

  it('is false without an audio block', () => {
    expect(specMatches(single, book(undefined, { fileCount: 1 }))).toBe(false);
  });

  it('resolves the layout on its own', () => {
    expect(resolveFileLayout(audio({ fileCount: 2 }))).toBe('multi');
    expect(resolveFileLayout(audio({ container: 'opus' }))).toBeUndefined();
  });
});

describe('formatType', () => {
  type Row = [want: 'unabridged' | 'abridged' | 'dramatized', have: Audio['formatType'], expected: boolean];
  const rows: Row[] = [
    ['unabridged', 'unabridged', true],
    ['unabridged', 'abridged', false],
    ['abridged', 'abridged', true],
    ['dramatized', 'dramatized', true],
    ['dramatized', 'unabridged', false],
    ['unabridged', undefined, false],
    ['abridged', undefined, false],
  ];
  it.each(rows)('%s vs %s → %s', (want, have, expected) => {
    expect(specMatches(spec('formatType', { formatType: want }), book(audio(have ? { formatType: have } : {})))).toBe(expected);
  });
});

describe('narrator', () => {
  type Row = [pattern: string, narrators: string[] | undefined, expected: boolean];
  const rows: Row[] = [
    ['Simon Vale', ['Simon Vale'], true],
    ['simon vale', ['Simon Vale'], true],
    ['^Nina', ['Simon Vale', 'Nina Brook'], true],
    ['^Nina', ['Simon Vale'], false],
    ['Brook$', [' Nina Brook '], true],
    ['Vale|Brook', ['Kate Morrow', 'Leo Grant'], false],
    ['Vale|Brook', ['Kate Morrow', 'Nina Brook'], true],
    ['.', [], false],
    ['.', undefined, false],
    ['(', ['Simon Vale'], false],
  ];
  it.each(rows)('/%s/ against %j → %s', (pattern, narrators, expected) => {
    expect(specMatches(spec('narrator', { pattern }), book(audio(narrators ? { narrators } : {})))).toBe(expected);
  });
});

describe('audiobook formats', () => {
  const format = (...specifications: CustomFormatSpec[]): CustomFormat => ({ id: 1, name: 'cf', includeWhenRenaming: false, specifications });

  it('combines layout, format type and narrator', () => {
    const preferred = format(single, spec('formatType', { formatType: 'unabridged' }), spec('narrator', { pattern: 'Vale' }));
    expect(formatMatches(preferred, book(audio({ container: 'm4b', formatType: 'unabridged', narrators: ['Simon Vale'] })))).toBe(true);
    expect(formatMatches(preferred, book(audio({ container: 'mp3', formatType: 'unabridged', narrators: ['Simon Vale'] })))).toBe(false);
    expect(formatMatches(preferred, book(audio({ fileCount: 1, container: 'mp3', formatType: 'unabridged', narrators: ['Simon Vale'] })))).toBe(true);
    expect(formatMatches(preferred, book(audio({ container: 'm4b', formatType: 'abridged', narrators: ['Simon Vale'] })))).toBe(false);
  });

  it('rejects abridged releases with a negated spec', () => {
    const notAbridged = format(spec('formatType', { formatType: 'abridged' }, true));
    expect(formatMatches(notAbridged, book(audio({ formatType: 'abridged' })))).toBe(false);
    expect(formatMatches(notAbridged, book(audio({ formatType: 'unabridged' })))).toBe(true);
    expect(formatMatches(notAbridged, book(audio()))).toBe(true);
  });
});
