/**
 * Test support: an in-memory slskd web API on top of FakeHttpServer. Enforces the
 * X-API-Key header, keeps searches and transfers in memory and lets tests drive transfer
 * states. Never touches a network. Not exported from the package entry point.
 */
import { FakeHttpServer, type FakeHttpReply, type FakeRequest } from '../fake-http.js';

export interface FakeSlskdFile {
  filename: string;
  size: number;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  length?: number;
}

export interface FakeSlskdPeer {
  username: string;
  files: FakeSlskdFile[];
  hasFreeUploadSlot?: boolean;
  queueLength?: number;
  uploadSpeed?: number;
}

export interface FakeSlskdTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  state: string;
  bytesTransferred: number;
  percentComplete: number;
}

interface FakeSearch {
  searchText: string;
  polls: number;
}

export class FakeSlskd extends FakeHttpServer {
  apiKey = 'test-api-key';
  loggedIn = true;
  version = '0.22.0';
  /** Peers answer a search when every word appears in a file's path. */
  peers: FakeSlskdPeer[] = [];
  /** Polls of GET /searches/{id} before it reports complete. */
  pollsUntilComplete = 1;
  readonly searches = new Map<string, FakeSearch>();
  readonly transfers: FakeSlskdTransfer[] = [];
  private nextTransfer = 1;

  constructor() {
    super();
    // Auth first, then the routes with path parameters (FakeHttpServer matches exact paths).
    this.guard = (request: FakeRequest) => {
      if (request.headers.get('X-API-Key') !== this.apiKey) return { status: 401, body: 'Unauthorized' };
      return this.dynamicRoute(request.method, request.path, request.bodyText)?.();
    };
    this.on('GET', '/api/v0/application', () => ({
      body: {
        version: { full: this.version, current: this.version },
        server: {
          state: this.loggedIn ? 'Connected, LoggedIn' : 'Disconnected',
          isConnected: this.loggedIn,
          isLoggedIn: this.loggedIn,
        },
      },
    }));
    this.on('POST', '/api/v0/searches', (request) => {
      const body = JSON.parse(request.bodyText) as { id: string; searchText: string };
      if (!body.searchText) return { status: 400, body: 'searchText required' };
      this.searches.set(body.id, { searchText: body.searchText, polls: 0 });
      return { body: { id: body.id, searchText: body.searchText, state: 'InProgress', isComplete: false } };
    });
    this.on('GET', '/api/v0/transfers/downloads', () => this.transferList());
  }

  /** Sets every transfer of `filename` to a state such as "InProgress" or "Completed, Succeeded". */
  setTransferState(filename: string, state: string): void {
    for (const t of this.transfers) {
      if (t.filename !== filename) continue;
      t.state = state;
      if (state.includes('Succeeded')) {
        t.bytesTransferred = t.size;
        t.percentComplete = 100;
      }
    }
  }

  /** Completes every transfer (tests then place the files on disk themselves). */
  completeAll(): void {
    for (const t of this.transfers) this.setTransferState(t.filename, 'Completed, Succeeded');
  }

  private matches(searchText: string): FakeSlskdPeer[] {
    const words = searchText.toLowerCase().split(/\s+/).filter(Boolean);
    return this.peers
      .map((p) => ({ ...p, files: p.files.filter((f) => words.every((w) => f.filename.toLowerCase().includes(w))) }))
      .filter((p) => p.files.length > 0);
  }

  private transferList(): FakeHttpReply {
    const users = new Map<string, Map<string, FakeSlskdTransfer[]>>();
    for (const t of this.transfers) {
      const dir = t.filename.slice(0, Math.max(t.filename.lastIndexOf('\\'), 0));
      const byDir = users.get(t.username) ?? new Map<string, FakeSlskdTransfer[]>();
      byDir.set(dir, [...(byDir.get(dir) ?? []), t]);
      users.set(t.username, byDir);
    }
    return {
      body: [...users].map(([username, dirs]) => ({
        username,
        directories: [...dirs].map(([directory, files]) => ({ directory, fileCount: files.length, files })),
      })),
    };
  }

  private dynamicRoute(method: string, path: string, bodyText: string): (() => FakeHttpReply) | undefined {
    let m = /^\/api\/v0\/searches\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        return () => {
          const s = this.searches.get(id);
          if (!s) return { status: 404, body: '' };
          s.polls += 1;
          const done = s.polls >= this.pollsUntilComplete;
          return { body: { id, searchText: s.searchText, state: done ? 'Completed, TimedOut' : 'InProgress', isComplete: done } };
        };
      }
      if (method === 'DELETE') return () => (this.searches.delete(id) ? new Response(null, { status: 204 }) : { status: 404 });
    }
    m = /^\/api\/v0\/searches\/([^/]+)\/responses$/.exec(path);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]!);
      return () => {
        const s = this.searches.get(id);
        if (!s) return { status: 404, body: '' };
        return {
          body: this.matches(s.searchText).map((p) => ({
            username: p.username,
            fileCount: p.files.length,
            files: p.files.map((f) => ({ extension: f.filename.split('.').at(-1), ...f })),
            hasFreeUploadSlot: p.hasFreeUploadSlot ?? true,
            queueLength: p.queueLength ?? 0,
            uploadSpeed: p.uploadSpeed ?? 1_000_000,
            lockedFileCount: 0,
            lockedFiles: [],
          })),
        };
      };
    }
    m = /^\/api\/v0\/transfers\/downloads\/([^/]+)$/.exec(path);
    if (m && method === 'POST') {
      const username = decodeURIComponent(m[1]!);
      return () => {
        if (!this.peers.some((p) => p.username === username)) return { status: 500, body: 'user offline' };
        const files = JSON.parse(bodyText) as Array<{ filename: string; size: number }>;
        for (const f of files) {
          this.transfers.push({
            id: `t${this.nextTransfer++}`,
            username,
            filename: f.filename,
            size: f.size,
            state: 'Queued, Remotely',
            bytesTransferred: 0,
            percentComplete: 0,
          });
        }
        return { status: 201, body: { enqueued: files, failed: [] } };
      };
    }
    m = /^\/api\/v0\/transfers\/downloads\/([^/]+)\/([^/]+)$/.exec(path);
    if (m && method === 'DELETE') {
      const username = decodeURIComponent(m[1]!);
      const id = decodeURIComponent(m[2]!);
      return () => {
        const index = this.transfers.findIndex((t) => t.username === username && t.id === id);
        if (index < 0) return { status: 404, body: '' };
        this.transfers.splice(index, 1);
        return new Response(null, { status: 204 });
      };
    }
    return undefined;
  }
}
