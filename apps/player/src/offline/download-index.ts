import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { PlayableItem } from '@arclight/shared';

// What has been downloaded for offline listening: one entry per (account, item), with the item
// as the server described it (so it plays and shows without the server) and the files that make
// it up. The audio itself is downloaded by the native plugin (src/native, `enqueueDownload`);
// this index is the app's own record of it, a JSON file next to the downloads.

export type PartStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';

export interface DownloadedFile {
  /** Native task id. */
  taskId: string;
  /** Relative to the downloads folder. */
  destName: string;
  status: PartStatus;
  bytesWritten: number;
  /** -1 when unknown. */
  totalBytes: number;
  /** Absolute path once completed. */
  path?: string;
  /** WebView-loadable URI once completed (images). */
  uri?: string;
  error?: string;
}

export interface DownloadEntry {
  accountId: string;
  itemKey: string;
  item: PlayableItem;
  /** One per `item.parts`, same order. */
  parts: DownloadedFile[];
  /** Cover image (shared by every track of an album: same taskId). */
  artwork: DownloadedFile | null;
  /** 'original' or e.g. 'aac-128'. */
  quality: string;
  addedAt: string;
}

export type EntryStatus = 'queued' | 'downloading' | 'waiting' | 'paused' | 'completed' | 'failed';

/** One status for a whole entry: failed if any part failed, completed when all are, … */
export function entryStatus(e: DownloadEntry): EntryStatus {
  const s = e.parts.map((p) => p.status);
  if (s.every((x) => x === 'completed')) return 'completed';
  if (s.some((x) => x === 'failed')) return 'failed';
  if (s.some((x) => x === 'running')) return 'downloading';
  if (s.some((x) => x === 'paused')) return 'paused';
  if (s.some((x) => x === 'waiting')) return 'waiting';
  return s.some((x) => x === 'completed') ? 'downloading' : 'queued';
}

/** 0..1 by bytes when sizes are known, else by finished parts. */
export function entryProgress(e: DownloadEntry): number {
  const total = e.parts.reduce((n, p) => n + (p.totalBytes > 0 ? p.totalBytes : 0), 0);
  if (total > 0 && e.parts.every((p) => p.totalBytes > 0)) return Math.min(1, e.parts.reduce((n, p) => n + p.bytesWritten, 0) / total);
  return e.parts.filter((p) => p.status === 'completed').length / Math.max(1, e.parts.length);
}

export function entryBytes(e: DownloadEntry): number {
  return e.parts.reduce((n, p) => n + Math.max(p.bytesWritten, p.status === 'completed' && p.totalBytes > 0 ? p.totalBytes : 0), 0);
}

/** Where the index JSON is read from and written to. */
export interface IndexFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export function memoryIndexFile(initial: string | null = null): IndexFile & { text: string | null } {
  const f = {
    text: initial,
    read: async () => f.text,
    write: async (t: string) => {
      f.text = t;
    },
  };
  return f;
}

const INDEX_PATH = 'arclight-downloads/index.json';

/** `<Data>/arclight-downloads/index.json` (app-private, not backed up: allowBackup is off). */
export const filesystemIndexFile: IndexFile = {
  async read() {
    try {
      const r = await Filesystem.readFile({ path: INDEX_PATH, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : null;
    } catch {
      return null;
    }
  },
  async write(text) {
    await Filesystem.writeFile({ path: INDEX_PATH, directory: Directory.Data, encoding: Encoding.UTF8, data: text, recursive: true });
  },
};

interface Stored {
  version: 1;
  entries: DownloadEntry[];
}

const keyOf = (accountId: string, itemKey: string) => `${accountId}|${itemKey}`;

export class DownloadIndex {
  private entries = new Map<string, DownloadEntry>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: IndexFile = filesystemIndexFile) {}

  load(): Promise<void> {
    this.loading ??= this.file.read().then((text) => {
      if (!text) return;
      try {
        const s = JSON.parse(text) as Stored;
        if (s.version === 1 && Array.isArray(s.entries)) for (const e of s.entries) this.entries.set(keyOf(e.accountId, e.itemKey), e);
      } catch {
        /* a corrupt index starts empty; the files are found again by listDownloads */
      }
    });
    return this.loading;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): Promise<void> {
    for (const l of [...this.listeners]) l();
    const text = JSON.stringify({ version: 1, entries: [...this.entries.values()] } satisfies Stored);
    this.writing = this.writing.then(() => this.file.write(text)).catch(() => undefined);
    return this.writing;
  }

  /** Waits for pending writes (tests, app pause). */
  flush(): Promise<void> {
    return this.writing;
  }

  all(accountId?: string): DownloadEntry[] {
    const list = [...this.entries.values()];
    return (accountId ? list.filter((e) => e.accountId === accountId) : list).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  get(accountId: string, itemKey: string): DownloadEntry | null {
    return this.entries.get(keyOf(accountId, itemKey)) ?? null;
  }

  async put(entry: DownloadEntry): Promise<void> {
    this.entries.set(keyOf(entry.accountId, entry.itemKey), entry);
    await this.changed();
  }

  async remove(accountId: string, itemKey: string): Promise<DownloadEntry | null> {
    const k = keyOf(accountId, itemKey);
    const e = this.entries.get(k) ?? null;
    if (e) {
      this.entries.delete(k);
      await this.changed();
    }
    return e;
  }

  /** Applies a native task update to every file with that task id (artwork is shared). */
  async updateTask(taskId: string, patch: Partial<DownloadedFile>): Promise<boolean> {
    let hit = false;
    for (const e of this.entries.values()) {
      e.parts = e.parts.map((p) => {
        if (p.taskId !== taskId) return p;
        hit = true;
        return { ...p, ...patch };
      });
      if (e.artwork?.taskId === taskId) {
        hit = true;
        e.artwork = { ...e.artwork, ...patch };
      }
    }
    if (hit) await this.changed();
    return hit;
  }

  /** Is any entry other than `except` still using this task's file? */
  isShared(taskId: string, except: { accountId: string; itemKey: string }): boolean {
    for (const e of this.entries.values()) {
      if (e.accountId === except.accountId && e.itemKey === except.itemKey) continue;
      if (e.artwork?.taskId === taskId || e.parts.some((p) => p.taskId === taskId)) return true;
    }
    return false;
  }

  /** Local file of one part, when that part is downloaded. */
  localPart(accountId: string, itemKey: string, partIndex: number): string | null {
    const p = this.get(accountId, itemKey)?.parts[partIndex];
    return p?.status === 'completed' && p.path ? p.path : null;
  }

  /** The item as stored, with its cover pointing at the downloaded image (`toWebUrl` maps file URIs for the WebView). */
  offlineItem(accountId: string, itemKey: string, toWebUrl: (uri: string) => string = (u) => u): PlayableItem | null {
    const e = this.get(accountId, itemKey);
    if (!e || entryStatus(e) !== 'completed') return null;
    const art = e.artwork?.status === 'completed' && (e.artwork.uri || e.artwork.path) ? toWebUrl(e.artwork.uri || e.artwork.path || '') : null;
    return { ...e.item, artworkUrl: art };
  }

  usedBytes(accountId?: string): number {
    return this.all(accountId).reduce((n, e) => n + entryBytes(e), 0);
  }
}
