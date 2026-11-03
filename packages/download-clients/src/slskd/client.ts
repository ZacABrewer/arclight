/**
 * slskd web API (v0) client: connection test, searches, download queueing and transfer
 * state. slskd is a Soulseek client daemon the user runs and configures themselves;
 * Arclight only talks to its HTTP API with an API key.
 */
import { z } from 'zod';
import { buildBaseUrl, httpStatusError, parseJson, sendHttp } from '../http.js';
import { readBodyText } from '../body.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import {
  SlskdApplication,
  SlskdResponse,
  SlskdSearchState,
  SlskdTransferList,
  type SlskdFile,
  type SlskdTransfer,
} from './schemas.js';
import type { SlskdSettings } from './settings.js';

export const SLSKD = 'slskd';

export interface SlskdTestResult {
  version: string | undefined;
  /** Logged in to the Soulseek server. */
  loggedIn: boolean;
  message: string;
}

export interface SlskdSearchOptions {
  /** How long slskd collects responses, in ms (default 15 s). */
  searchTimeoutMs?: number;
  /** Max responses slskd keeps (default 100). */
  responseLimit?: number;
  /** Max files slskd keeps (default 10 000). */
  fileLimit?: number;
  /** How often Arclight polls for completion (default 1 s). */
  pollMs?: number;
}

/** The phase of one queued file, normalised from slskd's state strings. */
export type SlskdTransferPhase = 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface SlskdDownload extends SlskdTransfer {
  /** The remote directory this file came from (slskd groups transfers by it). */
  directory: string;
  phase: SlskdTransferPhase;
}

/**
 * slskd reports transfer states as flag lists such as "Queued, Remotely",
 * "InProgress" or "Completed, Succeeded".
 */
export function transferPhase(state: string): SlskdTransferPhase {
  const flags = state.split(',').map((s) => s.trim().toLowerCase());
  if (flags.includes('completed')) {
    if (flags.includes('succeeded')) return 'completed';
    if (flags.includes('cancelled')) return 'cancelled';
    return 'failed';
  }
  if (flags.includes('inprogress')) return 'downloading';
  return 'queued';
}

/** The last segment of a Soulseek path (they use backslashes, some peers use slashes). */
export function remoteBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-1) ?? path;
}

/** The directory part of a Soulseek path, separators kept. */
export function remoteDirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut < 0 ? '' : path.slice(0, cut);
}

export class SlskdClient {
  readonly name = SLSKD;
  private readonly baseUrl: string;

  constructor(
    private readonly settings: SlskdSettings,
    private readonly runtime: ClientRuntime,
  ) {
    this.baseUrl = buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase);
  }

  private async request(method: string, path: string, what: string, body?: unknown): Promise<string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.settings.apiKey !== '') headers['X-API-Key'] = this.settings.apiKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await sendHttp(this.runtime, SLSKD, `${this.baseUrl}/api/v0${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await readBodyText(SLSKD, response);
    if (!response.ok) throw httpStatusError(SLSKD, response.status, what, text);
    return text;
  }

  private async json<T extends z.ZodType>(method: string, path: string, what: string, schema: T, body?: unknown): Promise<z.infer<T>> {
    return parseJson(SLSKD, what, await this.request(method, path, what, body), schema);
  }

  async test(): Promise<SlskdTestResult> {
    const app = await this.json('GET', '/application', 'application', SlskdApplication);
    const version = app.version?.full ?? app.version?.current;
    const loggedIn = app.server?.isLoggedIn ?? app.server?.isConnected ?? false;
    const named = version ? `slskd ${version}` : 'slskd';
    return {
      version,
      loggedIn,
      message: loggedIn ? `Connected to ${named}.` : `Reached ${named}, but it is not logged in to the Soulseek server.`,
    };
  }

  /** Starts a search with a caller-chosen id (a UUID), so it can be found again. */
  async startSearch(id: string, searchText: string, options: SlskdSearchOptions = {}): Promise<SlskdSearchState> {
    return this.json('POST', '/searches', 'start search', SlskdSearchState, {
      id,
      searchText,
      searchTimeout: options.searchTimeoutMs ?? 15_000,
      responseLimit: options.responseLimit ?? 100,
      fileLimit: options.fileLimit ?? 10_000,
      filterResponses: true,
    });
  }

  async getSearch(id: string): Promise<SlskdSearchState> {
    return this.json('GET', `/searches/${encodeURIComponent(id)}`, 'search state', SlskdSearchState);
  }

  async getResponses(id: string): Promise<SlskdResponse[]> {
    return this.json('GET', `/searches/${encodeURIComponent(id)}/responses`, 'search responses', z.array(SlskdResponse));
  }

  async deleteSearch(id: string): Promise<void> {
    await this.request('DELETE', `/searches/${encodeURIComponent(id)}`, 'delete search');
  }

  /**
   * Runs a whole search: starts it, polls until slskd marks it complete (or the search
   * timeout plus a grace period passes), reads the responses and deletes the search.
   */
  async search(id: string, searchText: string, options: SlskdSearchOptions = {}): Promise<SlskdResponse[]> {
    const timeout = options.searchTimeoutMs ?? 15_000;
    const poll = options.pollMs ?? 1000;
    await this.startSearch(id, searchText, options);
    const deadline = this.runtime.now() + timeout + 10_000;
    try {
      for (;;) {
        const state = await this.getSearch(id);
        if (state.isComplete === true || (state.state ?? '').toLowerCase().startsWith('completed')) break;
        if (this.runtime.now() >= deadline) break;
        await this.runtime.sleep(poll);
      }
      return await this.getResponses(id);
    } finally {
      await this.deleteSearch(id).catch(() => undefined);
    }
  }

  /** Queues files from one peer. slskd answers 201 with the enqueued transfers (ignored). */
  async enqueue(username: string, files: ReadonlyArray<Pick<SlskdFile, 'filename' | 'size'>>): Promise<void> {
    if (files.length === 0) throw new DownloadClientError('rejected', 'No files to download.');
    await this.request(
      'POST',
      `/transfers/downloads/${encodeURIComponent(username)}`,
      'enqueue download',
      files.map((f) => ({ filename: f.filename, size: f.size })),
    );
  }

  /** Every download transfer slskd knows about, flattened. */
  async listDownloads(): Promise<SlskdDownload[]> {
    const users = await this.json('GET', '/transfers/downloads', 'downloads', SlskdTransferList);
    const out: SlskdDownload[] = [];
    for (const user of users) {
      for (const dir of user.directories) {
        for (const file of dir.files) out.push({ ...file, directory: dir.directory, phase: transferPhase(file.state) });
      }
    }
    return out;
  }

  /** Cancels a transfer; `remove` also drops it from slskd's list. A missing one is ignored. */
  async cancelDownload(username: string, id: string, remove = true): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=${remove}`,
        'cancel download',
      );
    } catch (error) {
      if (error instanceof DownloadClientError && error.code === 'not-found') return;
      throw error;
    }
  }
}
