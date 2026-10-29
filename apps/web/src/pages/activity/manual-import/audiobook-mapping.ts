import type { AudioManualImportRequestInput, AudiobookManualImportItem, ImportMode } from '@arclight/shared';
import { t } from '../../../i18n/index.js';

// Pure state for the audiobook mode of manual import (GET/POST /manualimport/audio with
// `mediaType: 'audiobook'`). The scan answers one item per file; files of one book folder share
// a `groupKey` and get one proposed author and book. Each file has a proposed part number; the
// user can reorder parts, leave files out, or pick another author and book. A group imports as
// one book with parts numbered 1..n in the order shown.

export interface BookFileRow {
  path: string;
  relativePath: string;
  sizeBytes: number;
  qualityName: string | null;
  durationMs: number | null;
  /** The file's own title tag. */
  tagTitle: string | null;
  narrator: string | null;
  /** Left out of the import when false. */
  included: boolean;
  rejections: string[];
  /** Reasons of the rejections (`durationMismatch` ...). */
  rejectionReasons: string[];
  warnings: string[];
  downloadId: string | null;
}

export interface BookGroupState {
  key: string;
  folder: string;
  authorId: number | null;
  bookId: number | null;
  /** The proposed book's title (when the server names it). */
  bookTitle: string | null;
  /** The group's book match (0..1). */
  confidence: number | null;
  /** Sum of the group's file durations, and the book's catalogue runtime. */
  groupDurationMs: number | null;
  runtimeMs: number | null;
  /** In part order. */
  files: BookFileRow[];
}

export interface BookImportState {
  groups: BookGroupState[];
}

/** Groups from the scan (server order of their first files); files sorted by proposed part. */
export function initBookState(items: readonly AudiobookManualImportItem[]): BookImportState {
  const groups = new Map<string, { group: BookGroupState; parts: Map<string, number> }>();
  for (const it of items) {
    let entry = groups.get(it.groupKey);
    if (!entry) {
      entry = {
        group: {
          key: it.groupKey,
          folder: it.groupFolder,
          authorId: it.authorId ?? null,
          bookId: it.bookId ?? null,
          bookTitle: it.bookTitle ?? null,
          confidence: it.confidence,
          groupDurationMs: it.groupDurationMs ?? null,
          runtimeMs: it.runtimeMs ?? null,
          files: [],
        },
        parts: new Map(),
      };
      groups.set(it.groupKey, entry);
    }
    const g = entry.group;
    if (g.authorId === null && it.authorId !== undefined) g.authorId = it.authorId;
    if (g.bookId === null && it.bookId !== undefined) g.bookId = it.bookId;
    if (g.bookTitle === null && it.bookTitle !== undefined) g.bookTitle = it.bookTitle;
    const permanent = it.rejections.some((r) => r.type === 'permanent' && r.reason !== 'durationMismatch');
    entry.parts.set(it.path, it.partNumber);
    g.files.push({
      path: it.path,
      relativePath: it.relativePath,
      sizeBytes: it.sizeBytes,
      qualityName: it.quality.quality.name,
      durationMs: it.tags.durationMs,
      tagTitle: it.tags.title,
      narrator: it.tags.narrator,
      included: !permanent,
      rejections: it.rejections.map((r) => r.message),
      rejectionReasons: it.rejections.map((r) => r.reason),
      warnings: it.warnings,
      downloadId: it.downloadId ?? null,
    });
  }
  return {
    groups: [...groups.values()].map(({ group, parts }) => ({
      ...group,
      files: [...group.files].sort((a, b) => (parts.get(a.path) ?? 0) - (parts.get(b.path) ?? 0) || a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true })),
    })),
  };
}

export type BookAction =
  | { type: 'reset'; state: BookImportState }
  | { type: 'author'; key: string; authorId: number | null }
  | { type: 'book'; key: string; bookId: number | null }
  /** Move a file one place up (-1) or down (+1) in the part order. */
  | { type: 'move'; key: string; path: string; by: -1 | 1 }
  | { type: 'include'; key: string; path: string; included: boolean };

export function bookReducer(state: BookImportState, action: BookAction): BookImportState {
  if (action.type === 'reset') return action.state;
  const patch = (key: string, fn: (g: BookGroupState) => BookGroupState) => ({ groups: state.groups.map((g) => (g.key === key ? fn(g) : g)) });
  switch (action.type) {
    case 'author':
      // Another author: the proposed book (and its runtime) no longer applies.
      return patch(action.key, (g) => (g.authorId === action.authorId ? g : { ...g, authorId: action.authorId, bookId: null, bookTitle: null, runtimeMs: null }));
    case 'book':
      return patch(action.key, (g) => (g.bookId === action.bookId ? g : { ...g, bookId: action.bookId, bookTitle: null }));
    case 'move':
      return patch(action.key, (g) => {
        const i = g.files.findIndex((f) => f.path === action.path);
        const j = i + action.by;
        if (i < 0 || j < 0 || j >= g.files.length) return g;
        const files = [...g.files];
        [files[i], files[j]] = [files[j]!, files[i]!];
        return { ...g, files };
      });
    case 'include':
      return patch(action.key, (g) => ({ ...g, files: g.files.map((f) => (f.path === action.path ? { ...f, included: action.included } : f)) }));
  }
}

/** Part numbers (1-based) of the included files, in the order shown; null for left-out files. */
export function partNumbers(g: BookGroupState): Map<string, number | null> {
  let n = 0;
  return new Map(g.files.map((f) => [f.path, f.included ? ++n : null]));
}

/** What still blocks or deserves a look in a group. */
export function bookGroupProblems(g: BookGroupState): string[] {
  const out: string[] = [];
  if (g.authorId === null) out.push(t('activity.manualImport.audiobook.chooseAnAuthor'));
  else if (g.bookId === null) out.push(t('activity.manualImport.audiobook.chooseABook'));
  if (g.files.length > 0 && g.files.every((f) => !f.included)) out.push(t('activity.manualImport.audiobook.noFilesIncluded'));
  if (durationMismatch(g)) out.push(t('activity.manualImport.audiobook.durationMismatch'));
  return out;
}

/** The scan flagged the duration, or the included files differ from the runtime by more than `tolerance` (fraction). */
export function durationMismatch(g: BookGroupState, tolerance = 0.05): boolean {
  if (g.files.some((f) => f.rejectionReasons.includes('durationMismatch'))) return true;
  if (!g.runtimeMs) return false;
  const total = includedDurationMs(g);
  if (total === null) return false;
  return Math.abs(total - g.runtimeMs) > g.runtimeMs * tolerance;
}

/** Sum of the included files' durations; null when none reports one. */
export function includedDurationMs(g: BookGroupState): number | null {
  const ds = g.files.filter((f) => f.included && f.durationMs != null).map((f) => f.durationMs!);
  return ds.length ? ds.reduce((a, b) => a + b, 0) : null;
}

const ready = (g: BookGroupState) => g.authorId !== null && g.bookId !== null;

/** Files that would be imported (included, in a group with an author and a book). */
export function bookImportableCount(state: BookImportState): number {
  return state.groups.filter(ready).reduce((n, g) => n + g.files.filter((f) => f.included).length, 0);
}

/** POST /manualimport/audio body: one item per included file, parts numbered in the order shown. */
export function toBookImportRequest(state: BookImportState, importMode: ImportMode): AudioManualImportRequestInput {
  const items: AudioManualImportRequestInput['items'] = [];
  for (const g of state.groups) {
    if (!ready(g)) continue;
    const parts = partNumbers(g);
    for (const f of g.files) {
      const partNumber = parts.get(f.path);
      if (partNumber == null) continue;
      items.push({
        path: f.path,
        mediaType: 'audiobook',
        authorId: g.authorId!,
        bookId: g.bookId!,
        partNumber,
        ...(f.downloadId ? { downloadId: f.downloadId } : {}),
      });
    }
  }
  return { importMode, items };
}
