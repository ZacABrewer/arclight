import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { RetentionAction } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { RecycleBin } from '../imports/mover.js';
import { libraryService } from '../library/index.js';
import { getSection } from '../settings/service.js';

// Applies a retention action through the library service. Files go through the recycle bin
// (Settings > Media management); without one they are deleted. Every change is announced on
// the bus like the library routes do (live UI, history cleanup).

export interface ApplyOptions {
  /** deleteItem: add an import exclusion. */
  addExclusion: boolean;
}

export interface ApplyOutcome {
  /** Bytes moved to the recycle bin or deleted. */
  freedBytes: number;
  /** Where files went in the recycle bin (empty without one). */
  recycled: string[];
}

export type ApplyAction = (action: RetentionAction, mediaType: 'movie' | 'series', mediaId: number, opts: ApplyOptions) => Promise<ApplyOutcome>;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export class RetentionActions {
  constructor(
    private readonly db: Db,
    private readonly bus?: Pick<EventBus, 'publish'>,
  ) {}

  private bin(): RecycleBin {
    return new RecycleBin(getSection(this.db, 'mediaManagement').recycleBinPath);
  }

  private item(mediaType: 'movie' | 'series', id: number): { path: string; rootFolderPath: string; monitored: boolean } {
    return mediaType === 'series' ? libraryService.getSeries(this.db, id) : libraryService.getMovie(this.db, id);
  }

  private unmonitor(mediaType: 'movie' | 'series', id: number): void {
    if (mediaType === 'series') libraryService.updateSeries(this.db, id, { monitored: false });
    else libraryService.updateMovie(this.db, id, { monitored: false });
  }

  private async recycle(bin: RecycleBin, file: string, rootFolderPath: string, recycled: string[]): Promise<void> {
    if (!(await exists(file))) return;
    const target = await bin.recycle(file, relative(rootFolderPath, dirname(file)));
    if (target) recycled.push(target);
  }

  readonly apply: ApplyAction = async (action, mediaType, mediaId, opts) => {
    const item = this.item(mediaType, mediaId);
    const outcome: ApplyOutcome = { freedBytes: 0, recycled: [] };
    const files = libraryService.listMediaFiles(this.db, mediaType === 'series' ? { seriesId: mediaId } : { movieId: mediaId });
    switch (action) {
      case 'unmonitor':
        this.unmonitor(mediaType, mediaId);
        this.bus?.publish({ type: 'library', action: 'updated', mediaType, id: mediaId });
        return outcome;
      case 'deleteFiles': {
        const bin = this.bin();
        // Unmonitor first so nothing searches for the files while they disappear.
        this.unmonitor(mediaType, mediaId);
        for (const file of files) {
          await this.recycle(bin, file.path, item.rootFolderPath, outcome.recycled);
          await libraryService.deleteMediaFile(this.db, file.id, { deleteFromDisk: false });
          outcome.freedBytes += file.sizeBytes;
        }
        this.bus?.publish({ type: 'library', action: 'fileDeleted', mediaType, id: mediaId });
        return outcome;
      }
      case 'deleteItem': {
        const bin = this.bin();
        // Everything in the folder (videos, subtitles, extras) goes to the bin before the row and
        // the then-empty folder are removed; a failure stops before anything is deleted from the db.
        for (const file of await walkFiles(item.path)) await this.recycle(bin, file, item.rootFolderPath, outcome.recycled);
        outcome.freedBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
        const deleteOpts = { deleteFiles: true, addExclusion: opts.addExclusion };
        if (mediaType === 'series') await libraryService.deleteSeries(this.db, mediaId, deleteOpts);
        else await libraryService.deleteMovie(this.db, mediaId, deleteOpts);
        this.bus?.publish({ type: 'library', action: 'deleted', mediaType, id: mediaId });
        return outcome;
      }
    }
  };
}
