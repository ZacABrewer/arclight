import type {
  AddNzbInput,
  AddNzbResult,
  AddTorrentInput,
  AddTorrentResult,
  DownloadClient,
  DownloadClientStatus,
  DownloadClientTestResult,
  DownloadItem,
} from '@arclight/download-clients';
import { DownloadClientError } from '@arclight/download-clients';
import type { DownloadClientImplementation, DownloadClientResource, ReleaseProtocol } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import * as tables from './schema.js';
import { DownloadClientsService, type DownloadClientInputRaw, type DownloadClientsServiceOptions } from './service.js';

/** In-memory download client for tests. Not used by production code. */
export class FakeDownloadClient implements DownloadClient {
  readonly name = 'fake';
  readonly protocol: ReleaseProtocol;
  items: DownloadItem[] = [];
  added: AddTorrentInput[] = [];
  nzbsAdded: AddNzbInput[] = [];
  removed: Array<{ id: string; deleteData: boolean }> = [];
  categoryChanges: Array<{ id: string; category: string }> = [];
  failGetItems: Error | null = null;
  failAdd: Error | null = null;
  failRemove: Error | null = null;
  testResult: DownloadClientTestResult | Error = { version: '5.0.2', apiVersion: '2.11.2', warnings: [] };
  nextId = 'abc123';

  constructor(readonly config: DownloadClientResource) {
    this.protocol = config.protocol;
  }

  async test(): Promise<DownloadClientTestResult> {
    if (this.testResult instanceof Error) throw this.testResult;
    return this.testResult;
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    if (this.failAdd) throw this.failAdd;
    this.added.push(input);
    return { id: this.nextId, warnings: [] };
  }

  /** Mirrors the real clients: only usenet clients accept NZBs. */
  async addNzb(input: AddNzbInput): Promise<AddNzbResult> {
    if (this.protocol !== 'usenet') throw new DownloadClientError('not-supported', 'fake torrent client does not support NZBs');
    if (this.failAdd) throw this.failAdd;
    this.nzbsAdded.push(input);
    return { id: this.nextId, warnings: [] };
  }

  async getItems(): Promise<DownloadItem[]> {
    if (this.failGetItems) throw this.failGetItems;
    return this.items;
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    if (this.failRemove) throw this.failRemove;
    this.removed.push({ id, deleteData });
    this.items = this.items.filter((i) => i.id !== id);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    return { outputRootDir: this.outputRootDir, isLocalhost: true, removesCompletedDownloads: false };
  }

  async setCategory(id: string, category: string): Promise<void> {
    this.categoryChanges.push({ id, category });
  }

  outputRootDir = '/downloads';
  paused: string[] = [];
  resumed: string[] = [];
  reannounced: string[] = [];
  failReannounce: Error | null = null;

  /** Pausing/resuming flips the staged item's status, as a real client would. */
  async pause(id: string): Promise<void> {
    this.paused.push(id);
    this.items = this.items.map((i) => (i.id === id ? { ...i, status: 'paused' } : i));
  }

  async resume(id: string): Promise<void> {
    this.resumed.push(id);
    this.items = this.items.map((i) => (i.id === id && i.status === 'paused' ? { ...i, status: 'downloading' } : i));
  }

  async reannounce(id: string): Promise<void> {
    if (this.failReannounce) throw this.failReannounce;
    this.reannounced.push(id);
  }
}

export function item(overrides: Partial<DownloadItem> & { id: string }): DownloadItem {
  return {
    title: `Release.${overrides.id}`,
    category: 'arclight',
    totalBytes: 1000,
    remainingBytes: 500,
    downloadedBytes: 500,
    progress: 0.5,
    status: 'downloading',
    outputPath: `/downloads/Release.${overrides.id}`,
    etaSeconds: 60,
    isReadOnly: true,
    canMoveFiles: false,
    canBeRemoved: false,
    ...overrides,
  };
}

export { DownloadClientError };

export async function setup(options: Partial<DownloadClientsServiceOptions> = {}) {
  const db = await createTestDb({ ...tables });
  const fakes = new Map<number, FakeDownloadClient>();
  let built = 0;
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const service = new DownloadClientsService({
    db,
    platform: 'posix',
    directoryExists: async () => true,
    now: () => clock,
    clientFactory: (config) => {
      built++;
      // Keep one fake per id so tests can stage items across rebuilds.
      const existing = fakes.get(config.id);
      const fake = new FakeDownloadClient(config);
      if (existing) {
        fake.items = existing.items;
        fake.added = existing.added;
        fake.nzbsAdded = existing.nzbsAdded;
        fake.removed = existing.removed;
        fake.paused = existing.paused;
        fake.resumed = existing.resumed;
        fake.reannounced = existing.reannounced;
      }
      if (config.id !== 0) fakes.set(config.id, fake);
      return fake;
    },
    ...options,
  });
  return {
    db,
    service,
    fake: (id: number) => {
      service.clientById(id);
      const f = fakes.get(id);
      if (!f) throw new Error(`no fake for ${id}`);
      return f;
    },
    builds: () => built,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

export function qbit(name: string, extra: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return {
    name,
    implementation: 'qbittorrent' as const,
    ...extra,
    settings: { host: 'seedbox', username: 'admin', password: 'secret', ...settings },
  };
}

/** A create body for any implementation (settings get a host and credentials). */
export function clientOf(
  implementation: DownloadClientImplementation,
  name: string,
  extra: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  return {
    name,
    implementation,
    ...extra,
    settings: { host: 'nas', url: 'http://nas:7879', password: 'secret', ...settings },
    // Not narrowed per kind: `builtin` simply ignores host/password (unknown keys are stripped).
  } as DownloadClientInputRaw;
}
