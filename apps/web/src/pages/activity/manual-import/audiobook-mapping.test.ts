import { describe, expect, it } from 'vitest';
import { QUALITIES, type AudiobookManualImportItem } from '@arclight/shared';
import { bookGroupProblems, bookImportableCount, bookReducer, durationMismatch, initBookState, partNumbers, toBookImportRequest } from './audiobook-mapping.js';

const quality = { quality: { ...QUALITIES['AB-MP3'] }, revision: { version: 1, real: 0, isRepack: false } };
const tags = { title: null, author: null, album: null, narrator: null, series: null, seriesPart: null, asin: null, isbn: null, trackNo: null, discNo: null, durationMs: 1_000, chapterCount: null, codec: null, bitrateKbps: null };

function item(path: string, part: number, over: Partial<AudiobookManualImportItem> = {}): AudiobookManualImportItem {
  return {
    path,
    relativePath: path,
    name: path,
    sizeBytes: 1,
    quality,
    mediaType: 'audiobook',
    groupKey: 'g',
    groupFolder: 'Book',
    partNumber: part,
    partCount: 3,
    confidence: 0.6,
    groupDurationMs: 3_000,
    runtimeMs: 3_000,
    tags,
    rejections: [],
    warnings: [],
    ...over,
  } as AudiobookManualImportItem;
}

describe('audiobook manual import mapping', () => {
  it('groups by folder and orders files by proposed part, sharing the proposal', () => {
    const state = initBookState([item('c', 3), item('a', 1, { authorId: 2, bookId: 7 }), item('b', 2), item('x', 1, { groupKey: 'h', groupFolder: 'Other', runtimeMs: null })]);
    expect(state.groups.map((g) => g.key)).toEqual(['g', 'h']);
    expect(state.groups[0]!.files.map((f) => f.path)).toEqual(['a', 'b', 'c']);
    expect(state.groups[0]).toMatchObject({ authorId: 2, bookId: 7, confidence: 0.6 });
    expect(bookGroupProblems(state.groups[1]!)).toEqual(['Choose an author']);
  });

  it('reorders, leaves files out and renumbers the parts', () => {
    let state = initBookState([item('a', 1, { authorId: 2, bookId: 7 }), item('b', 2), item('c', 3)]);
    state = bookReducer(state, { type: 'move', key: 'g', path: 'c', by: -1 });
    state = bookReducer(state, { type: 'move', key: 'g', path: 'a', by: -1 }); // already first: no-op
    state = bookReducer(state, { type: 'include', key: 'g', path: 'b', included: false });
    expect([...partNumbers(state.groups[0]!).entries()]).toEqual([
      ['a', 1],
      ['c', 2],
      ['b', null],
    ]);
    expect(bookImportableCount(state)).toBe(2);
    expect(toBookImportRequest(state, 'copy')).toEqual({
      importMode: 'copy',
      items: [
        { path: 'a', mediaType: 'audiobook', authorId: 2, bookId: 7, partNumber: 1 },
        { path: 'c', mediaType: 'audiobook', authorId: 2, bookId: 7, partNumber: 2 },
      ],
    });
  });

  it('a new author clears the book; groups without a book are not imported', () => {
    let state = initBookState([item('a', 1, { authorId: 2, bookId: 7 })]);
    state = bookReducer(state, { type: 'author', key: 'g', authorId: 3 });
    expect(state.groups[0]).toMatchObject({ authorId: 3, bookId: null });
    expect(bookGroupProblems(state.groups[0]!)).toEqual(['Choose a book']);
    expect(toBookImportRequest(state, 'auto').items).toEqual([]);
  });

  it('flags a duration mismatch from the scan or from the included files', () => {
    const ok = initBookState([item('a', 1), item('b', 2), item('c', 3)]).groups[0]!;
    expect(durationMismatch(ok)).toBe(false);
    const short = bookReducer({ groups: [ok] }, { type: 'include', key: 'g', path: 'c', included: false }).groups[0]!;
    expect(durationMismatch(short)).toBe(true);
    const flagged = initBookState([item('a', 1, { runtimeMs: null, rejections: [{ reason: 'durationMismatch', message: 'Too short', type: 'permanent' }] })]).groups[0]!;
    expect(durationMismatch(flagged)).toBe(true);
    // A duration mismatch alone does not leave the file out.
    expect(flagged.files[0]!.included).toBe(true);
  });
});
