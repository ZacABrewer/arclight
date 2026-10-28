import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { normalizeTitle } from '@arclight/parser';
import { extensionOf, isInWorkingFolder, ScanError, type ScannedFile } from '../scan.js';
import { createCombinedTagReader, type AudioTags, type TagReader } from './tags.js';

// Enumerating a music (or audiobook) folder: audio files plus their extras (cue sheets, rip
// logs, lyrics, text, cover images), filtered like the video scanner, then grouped into album
// candidates. Filesystem and tag reads only; no database.

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.flac', '.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.ape', '.wv', '.dsf', '.dff',
]);
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

export type AudioExtraKind = 'cue' | 'log' | 'lyrics' | 'text' | 'cover' | 'image';

const EXTRA_KIND_BY_EXTENSION: Record<string, AudioExtraKind> = { '.cue': 'cue', '.log': 'log', '.lrc': 'lyrics', '.txt': 'text' };
const COVER_STEM = /^(cover|folder|front|album|albumart(?:small|_\{.*\}_large)?|thumb)$/i;

export function isAudioExtension(ext: string): boolean {
  return AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

/** The extra kind of a non-audio file, or null when it is neither audio nor a known extra. */
export function audioExtraKind(name: string): AudioExtraKind | null {
  const ext = extensionOf(name);
  const byExt = EXTRA_KIND_BY_EXTENSION[ext];
  if (byExt) return byExt;
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return COVER_STEM.test(name.slice(0, -ext.length)) ? 'cover' : 'image';
}

// Same exclusions as the video scanner (`scan.ts`): hidden and NAS/OS system entries.
const EXCLUDED_FOLDERS = new Set(['@eadir', '.@__thumb', '#recycle', '$recycle.bin', 'system volume information', 'lost+found']);
const EXCLUDED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function excludedFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || EXCLUDED_FOLDERS.has(lower);
}

function excludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || lower.startsWith('._') || EXCLUDED_FILES.has(lower);
}

/**
 * Scene-style audio samples: a `Sample(s)` folder, or a file whose stem is `sample` or ends in
 * `-sample` / `.sample` / `_sample`. Looser than the video rule on purpose: a track can be
 * titled "Sample" ("04 - Sample.flac" stays).
 */
export function isAudioSample(path: string): boolean {
  const name = basename(path);
  const ext = extensionOf(name);
  const stem = (ext ? name.slice(0, -ext.length) : name).toLowerCase();
  if (stem === 'sample' || /[-._]sample$/.test(stem) || /^sample[-._]/.test(stem)) return true;
  const parent = basename(dirname(path)).toLowerCase();
  return parent === 'sample' || parent === 'samples';
}

const DISC_FOLDER = /^(?:cd|disc|disk|dvd|side|vinyl|lp)\s*[-_.]?\s*(\d{1,2})\b/i;

/** "CD2", "Disc 02 - Bonus", "disk_3" -> 2/2/3; null for anything else. */
export function discNumberFromFolder(name: string): number | null {
  const m = DISC_FOLDER.exec(name.trim());
  return m ? Number(m[1]) : null;
}

/** The album folder of a file: its parent, or the grandparent for disc subfolders. */
export function albumFolderOf(filePath: string): string {
  const dir = dirname(filePath);
  return discNumberFromFolder(basename(dir)) !== null ? dirname(dir) : dir;
}

// ---------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------

export interface AudioScanFile extends ScannedFile {
  /** Null when no reader could parse the file (see `error`). */
  tags: AudioTags | null;
  error: string | null;
  /** Disc number implied by a `CD2`-style parent folder. */
  discFromFolder: number | null;
}

export interface AudioExtraFile extends ScannedFile {
  kind: AudioExtraKind;
  /** For `.lrc`: the audio file with the same stem in the same folder. */
  forFile: string | null;
}

export type AudioGroupBasis = 'releaseGroupId' | 'releaseId' | 'albumTags' | 'folder';

export interface AudioGroup {
  /** Stable within one scan: basis + folder + identity. */
  key: string;
  basis: AudioGroupBasis;
  /** The album folder (disc subfolders fold into their parent). */
  folder: string;
  album: string | null;
  albumArtist: string | null;
  mbReleaseId: string | null;
  mbReleaseGroupId: string | null;
  /** Distinct release ids seen in the group's files (more than one hints at mixed releases). */
  releaseIds: string[];
  /** Sorted by disc, track, then path. */
  files: AudioScanFile[];
  extras: AudioExtraFile[];
  hasCue: boolean;
}

export interface AudioScanSkip {
  path: string;
  reason: 'sample' | 'excluded' | 'unsupported';
}

export interface AudioScanResult {
  root: string;
  isFile: boolean;
  groups: AudioGroup[];
  /** Every audio file (also reachable through `groups`). */
  files: AudioScanFile[];
  extras: AudioExtraFile[];
  /** Files no reader could parse (they are still grouped by folder). */
  unreadable: AudioScanFile[];
  skipped: AudioScanSkip[];
  unpacking: boolean;
  /** Wall time of the tag reads, for logging. */
  tagReadMs: number;
}

export interface AudioScanOptions {
  tagReader?: TagReader;
  /** Parallel tag reads. Default 4. */
  concurrency?: number;
  workingFolders?: readonly string[];
}

const DEFAULT_WORKING_FOLDERS = ['_UNPACK_', '_FAILED_'];

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------

/** Walk `path` (a folder, or a single audio file), read tags and group into album candidates. */
export async function scanAudioPath(path: string, options: AudioScanOptions = {}): Promise<AudioScanResult> {
  const info = await statOrNull(path);
  if (!info) {
    throw new ScanError(
      'NOT_FOUND',
      `${path} does not exist or is not accessible. Make sure the Arclight service user can read it` +
        (process.platform === 'win32' ? ' (mapped network drives are not visible to services; use a UNC path).' : '.'),
    );
  }
  const working = options.workingFolders ?? DEFAULT_WORKING_FOLDERS;
  const root = info.isFile() ? dirname(path) : path;
  const audio: ScannedFile[] = [];
  const extras: AudioExtraFile[] = [];
  const skipped: AudioScanSkip[] = [];
  let unpacking = false;

  const consider = (full: string, size: number, mtimeMs: number) => {
    const name = basename(full);
    const file: ScannedFile = { path: full, relativePath: relative(root, full), name, extension: extensionOf(name), sizeBytes: size, mtimeMs };
    if (isAudioExtension(file.extension)) {
      if (isAudioSample(full)) skipped.push({ path: full, reason: 'sample' });
      else audio.push(file);
      return;
    }
    const kind = audioExtraKind(name);
    if (kind) extras.push({ ...file, kind, forFile: null });
    else skipped.push({ path: full, reason: 'unsupported' });
  };

  if (info.isFile()) {
    consider(path, info.size, info.mtimeMs);
    unpacking = isInWorkingFolder(path, working);
  } else {
    unpacking = working.some((p) => basename(path).toLowerCase().startsWith(p.toLowerCase()));
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludedFolder(entry.name)) {
            skipped.push({ path: full, reason: 'excluded' });
            continue;
          }
          if (working.some((p) => entry.name.toLowerCase().startsWith(p.toLowerCase()))) unpacking = true;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (excludedFile(entry.name)) {
          skipped.push({ path: full, reason: 'excluded' });
          continue;
        }
        const s = await statOrNull(full);
        if (s) consider(full, s.size, s.mtimeMs);
      }
    };
    await walk(path);
  }

  audio.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  extras.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  const reader = options.tagReader ?? createCombinedTagReader();
  const started = performance.now();
  const files = await mapLimit(audio, options.concurrency ?? 4, async (f): Promise<AudioScanFile> => {
    const discFromFolder = discNumberFromFolder(basename(dirname(f.path)));
    try {
      return { ...f, tags: await reader.read(f.path), error: null, discFromFolder };
    } catch (err) {
      return { ...f, tags: null, error: err instanceof Error ? err.message : String(err), discFromFolder };
    }
  });
  const tagReadMs = Math.round(performance.now() - started);

  // Lyrics belong to the audio file with the same stem.
  const byStem = new Map(files.map((f) => [stemKey(f.path), f.path]));
  for (const extra of extras) if (extra.kind === 'lyrics') extra.forFile = byStem.get(stemKey(extra.path)) ?? null;

  return {
    root: path,
    isFile: info.isFile(),
    groups: groupAudioFiles(files, extras),
    files,
    extras,
    unreadable: files.filter((f) => f.tags === null),
    skipped,
    unpacking,
    tagReadMs,
  };
}

function stemKey(path: string): string {
  const ext = extensionOf(path);
  return (ext ? path.slice(0, -ext.length) : path).toLowerCase();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------

function albumKey(tags: AudioTags | null): string | null {
  if (!tags?.album) return null;
  const artist = tags.albumArtist ?? (tags.compilation ? 'Various Artists' : null);
  return `${normalizeTitle(tags.album)}|${artist ? normalizeTitle(artist) : ''}`;
}

/**
 * Group scanned files into album candidates, within each album folder:
 * 1. MusicBrainz release-group id (split further by release id when several releases of the
 *    group sit in one folder), else release id alone;
 * 2. album + album-artist tags (files without album artist group by album within the folder,
 *    which keeps untagged-VA compilations together);
 * 3. the folder itself.
 * Files with album tags matching an id group of the same folder join that group.
 */
export function groupAudioFiles(files: readonly AudioScanFile[], extras: readonly AudioExtraFile[] = []): AudioGroup[] {
  const byFolder = new Map<string, AudioScanFile[]>();
  for (const f of files) {
    const folder = albumFolderOf(f.path);
    let list = byFolder.get(folder);
    if (!list) byFolder.set(folder, (list = []));
    list.push(f);
  }

  const groups: AudioGroup[] = [];
  for (const [folder, list] of byFolder) {
    const idGroups = new Map<string, { basis: AudioGroupBasis; files: AudioScanFile[] }>();
    const rest: AudioScanFile[] = [];
    // Release ids per release group in this folder.
    const releasesPerGroup = new Map<string, Set<string>>();
    for (const f of list) {
      const rg = f.tags?.mbReleaseGroupId;
      const rel = f.tags?.mbReleaseId;
      if (rg && rel) {
        let set = releasesPerGroup.get(rg);
        if (!set) releasesPerGroup.set(rg, (set = new Set()));
        set.add(rel);
      }
    }
    for (const f of list) {
      const rg = f.tags?.mbReleaseGroupId ?? null;
      const rel = f.tags?.mbReleaseId ?? null;
      let key: string | null = null;
      let basis: AudioGroupBasis = 'releaseGroupId';
      if (rg) key = (releasesPerGroup.get(rg)?.size ?? 0) > 1 && rel ? `rg:${rg}|rel:${rel}` : `rg:${rg}`;
      else if (rel) {
        key = `rel:${rel}`;
        basis = 'releaseId';
      }
      if (!key) {
        rest.push(f);
        continue;
      }
      let g = idGroups.get(key);
      if (!g) idGroups.set(key, (g = { basis, files: [] }));
      g.files.push(f);
    }

    // Album-tag keys of id groups, so partially tagged files can join them.
    const idByAlbumKey = new Map<string, string>();
    for (const [key, g] of idGroups) {
      for (const f of g.files) {
        const ak = albumKey(f.tags);
        if (ak && !idByAlbumKey.has(ak)) idByAlbumKey.set(ak, key);
      }
    }
    const tagGroups = new Map<string, AudioScanFile[]>();
    const folderFiles: AudioScanFile[] = [];
    for (const f of rest) {
      const ak = albumKey(f.tags);
      const viaId = ak ? idByAlbumKey.get(ak) : undefined;
      if (viaId) idGroups.get(viaId)!.files.push(f);
      else if (ak) {
        let arr = tagGroups.get(ak);
        if (!arr) tagGroups.set(ak, (arr = []));
        arr.push(f);
      } else folderFiles.push(f);
    }
    // "Album|" (no album artist) folds into the only "Album|Artist" group of the same title.
    for (const [key, arr] of [...tagGroups]) {
      if (!key.endsWith('|')) continue;
      const siblings = [...tagGroups.keys()].filter((k) => k !== key && k.startsWith(key));
      if (siblings.length === 1) {
        tagGroups.get(siblings[0]!)!.push(...arr);
        tagGroups.delete(key);
      }
    }

    for (const [key, g] of idGroups) groups.push(makeGroup(`${key}|${folder}`, g.basis, folder, g.files));
    for (const [key, arr] of tagGroups) groups.push(makeGroup(`tags:${key}|${folder}`, 'albumTags', folder, arr));
    if (folderFiles.length > 0) groups.push(makeGroup(`folder:${folder}`, 'folder', folder, folderFiles));
  }

  // Extras attach to every group of their album folder (a cue sheet in "CD1" belongs to it).
  for (const extra of extras) {
    const folder = albumFolderOf(extra.path);
    for (const g of groups) if (g.folder === folder) g.extras.push(extra);
  }
  for (const g of groups) g.hasCue = g.extras.some((e) => e.kind === 'cue');
  groups.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }) || a.key.localeCompare(b.key));
  return groups;
}

function mostCommon(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function makeGroup(key: string, basis: AudioGroupBasis, folder: string, files: AudioScanFile[]): AudioGroup {
  const sorted = [...files].sort(
    (a, b) =>
      (a.tags?.discNo ?? a.discFromFolder ?? 1) - (b.tags?.discNo ?? b.discFromFolder ?? 1) ||
      (a.tags?.trackNo ?? 0) - (b.tags?.trackNo ?? 0) ||
      a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
  const releaseIds = [...new Set(sorted.map((f) => f.tags?.mbReleaseId).filter((v): v is string => !!v))];
  return {
    key,
    basis,
    folder,
    album: mostCommon(sorted.map((f) => f.tags?.album)),
    albumArtist: mostCommon(sorted.map((f) => f.tags?.albumArtist ?? (f.tags?.compilation ? 'Various Artists' : null))),
    mbReleaseId: mostCommon(sorted.map((f) => f.tags?.mbReleaseId)),
    mbReleaseGroupId: mostCommon(sorted.map((f) => f.tags?.mbReleaseGroupId)),
    releaseIds,
    files: sorted,
    extras: [],
    hasCue: false,
  };
}
