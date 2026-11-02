import { asc, eq } from 'drizzle-orm';
import { BooksLibraryAppInput, SECRET_MASK, type BooksLibraryApp, type BooksLibraryAppKind, type BooksLibraryAppTestResult } from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { parseBody } from './catalog.js';
import { BooksError } from './errors.js';
import { bookLibraryApps, type BookLibraryAppRow } from './schema.js';

// Reading servers told about new files (docs/books.md "Library apps"): after an import the
// apps that serve that kind rescan, so the book shows up without waiting for their own
// schedule. Behaviour follows each server's public API documentation:
//
//   Kavita          POST /api/Plugin/authenticate (API key) → JWT; POST /api/Library/scan-folder
//                   (the imported folder) or POST /api/Library/scan?libraryId=<id>
//   Komga           X-API-Key or basic auth; POST /api/v1/libraries/<id>/scan (every library
//                   from GET /api/v1/libraries when none is set)
//   Audiobookshelf  Bearer API key; POST /api/libraries/<id>/scan (every book library when none)
//   Calibre-Web     reads the Calibre library database itself; it has no rescan call, so only
//                   the connection test does anything
//
// Secrets (`apiKey`, `password`) are SECRET_MASK on reads; sending the mask back keeps them.
// A failing app never fails the import: notify errors are logged.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

export function toLibraryApp(row: BookLibraryAppRow): BooksLibraryApp {
  return {
    id: row.id,
    name: row.name,
    implementation: row.implementation,
    enabled: row.enabled,
    url: row.url,
    apiKey: row.apiKey ? SECRET_MASK : '',
    username: row.username,
    password: row.password ? SECRET_MASK : '',
    libraryId: row.libraryId,
    kinds: row.kinds,
  };
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

class AppRequestError extends Error {}

export class BooksLibraryAppsService {
  constructor(private readonly deps: { db: Db; log: Logger; fetchImpl?: FetchLike }) {}

  private fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const f = this.deps.fetchImpl ?? ((i: string, n?: RequestInit) => fetch(i, n));
    return f(input, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  }

  private row(id: number): BookLibraryAppRow {
    const row = this.deps.db.select().from(bookLibraryApps).where(eq(bookLibraryApps.id, id)).get();
    if (!row) throw BooksError.notFound('library app', id);
    return row;
  }

  list(): BooksLibraryApp[] {
    return this.deps.db.select().from(bookLibraryApps).orderBy(asc(bookLibraryApps.name)).all().map(toLibraryApp);
  }

  get(id: number): BooksLibraryApp {
    return toLibraryApp(this.row(id));
  }

  /** Stored values for an input; the mask (or an empty secret on update) keeps what is stored. */
  private values(raw: BooksLibraryAppInput, current?: BookLibraryAppRow) {
    const input = parseBody(BooksLibraryAppInput, raw);
    const keep = (sent: string, stored: string | undefined) => (sent === SECRET_MASK ? (stored ?? '') : sent.trim());
    return {
      name: input.name.trim(),
      implementation: input.implementation,
      enabled: input.enabled,
      url: base(input.url.trim()),
      apiKey: keep(input.apiKey, current?.apiKey),
      username: input.username.trim(),
      password: keep(input.password, current?.password),
      libraryId: input.libraryId.trim(),
      kinds: [...new Set(input.kinds)],
    };
  }

  create(raw: BooksLibraryAppInput): BooksLibraryApp {
    return toLibraryApp(this.deps.db.insert(bookLibraryApps).values(this.values(raw)).returning().get());
  }

  update(id: number, raw: BooksLibraryAppInput): BooksLibraryApp {
    const current = this.row(id);
    return toLibraryApp(this.deps.db.update(bookLibraryApps).set(this.values(raw, current)).where(eq(bookLibraryApps.id, id)).returning().get()!);
  }

  delete(id: number): void {
    this.row(id);
    this.deps.db.delete(bookLibraryApps).where(eq(bookLibraryApps.id, id)).run();
  }

  /** Connection test of a saved app (`id`) or of an unsaved form (masked secrets read from `id`). */
  async test(raw: BooksLibraryAppInput, id?: number): Promise<BooksLibraryAppTestResult> {
    const values = this.values(raw, id !== undefined ? this.row(id) : undefined);
    try {
      const message = await this.check(values);
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Asks every enabled app serving `kind` to rescan (`path`: the imported file's folder). */
  async notify(kind: BooksLibraryAppKind, path: string): Promise<void> {
    const rows = this.deps.db.select().from(bookLibraryApps).where(eq(bookLibraryApps.enabled, true)).all().filter((r) => r.kinds.includes(kind));
    for (const row of rows) {
      try {
        await this.rescan(row, path);
        this.deps.log.debug({ app: row.name, path }, 'library app asked to rescan');
      } catch (err) {
        this.deps.log.warn({ app: row.name, err: err instanceof Error ? err.message : String(err) }, 'library app rescan failed');
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Per-server calls
  // -------------------------------------------------------------------------------------

  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      throw new AppRequestError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new AppRequestError(`${what}: the server refused the credentials (HTTP ${res.status})`);
    if (!res.ok) throw new AppRequestError(`${what}: HTTP ${res.status}`);
    return res;
  }

  private async kavitaToken(app: Pick<BookLibraryAppRow, 'url' | 'apiKey'>): Promise<string> {
    if (!app.apiKey) throw new AppRequestError('Kavita needs an API key');
    const res = await this.send(`${app.url}/api/Plugin/authenticate?apiKey=${encodeURIComponent(app.apiKey)}&pluginName=Arclight`, { method: 'POST' }, 'Kavita sign-in');
    const body = (await res.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new AppRequestError('Kavita sign-in returned no token');
    return body.token;
  }

  private komgaHeaders(app: Pick<BookLibraryAppRow, 'apiKey' | 'username' | 'password'>): Record<string, string> {
    if (app.apiKey) return { 'X-API-Key': app.apiKey };
    if (app.username) return { Authorization: `Basic ${Buffer.from(`${app.username}:${app.password}`).toString('base64')}` };
    throw new AppRequestError('Komga needs an API key or a username and password');
  }

  private absHeaders(app: Pick<BookLibraryAppRow, 'apiKey'>): Record<string, string> {
    if (!app.apiKey) throw new AppRequestError('Audiobookshelf needs an API key');
    return { Authorization: `Bearer ${app.apiKey}` };
  }

  private async komgaLibraries(app: Pick<BookLibraryAppRow, 'url' | 'apiKey' | 'username' | 'password'>): Promise<string[]> {
    const res = await this.send(`${app.url}/api/v1/libraries`, { headers: this.komgaHeaders(app) }, 'Komga libraries');
    const body = (await res.json().catch(() => [])) as unknown;
    return Array.isArray(body) ? body.flatMap((l) => (typeof (l as { id?: unknown }).id === 'string' ? [(l as { id: string }).id] : [])) : [];
  }

  private async absLibraries(app: Pick<BookLibraryAppRow, 'url' | 'apiKey'>): Promise<string[]> {
    const res = await this.send(`${app.url}/api/libraries`, { headers: this.absHeaders(app) }, 'Audiobookshelf libraries');
    const body = (await res.json().catch(() => ({}))) as { libraries?: Array<{ id?: unknown; mediaType?: unknown }> };
    return (body.libraries ?? []).filter((l) => typeof l.id === 'string' && (l.mediaType === undefined || l.mediaType === 'book')).map((l) => l.id as string);
  }

  private async check(app: Omit<BookLibraryAppRow, 'id'>): Promise<string> {
    switch (app.implementation) {
      case 'kavita':
        await this.kavitaToken(app);
        return 'Connected to Kavita';
      case 'komga': {
        const libraries = await this.komgaLibraries(app);
        return `Connected to Komga (${libraries.length} libraries)`;
      }
      case 'audiobookshelf': {
        const libraries = await this.absLibraries(app);
        return `Connected to Audiobookshelf (${libraries.length} book libraries)`;
      }
      case 'calibreWeb':
        await this.send(`${app.url}/`, {}, 'Calibre-Web');
        return 'Calibre-Web is reachable (it picks up new books from the Calibre library itself)';
    }
  }

  private async rescan(app: BookLibraryAppRow, folder: string): Promise<void> {
    switch (app.implementation) {
      case 'kavita': {
        const token = await this.kavitaToken(app);
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        if (app.libraryId) await this.send(`${app.url}/api/Library/scan?libraryId=${encodeURIComponent(app.libraryId)}`, { method: 'POST', headers }, 'Kavita scan');
        else await this.send(`${app.url}/api/Library/scan-folder`, { method: 'POST', headers, body: JSON.stringify({ apiKey: app.apiKey, folderPath: folder }) }, 'Kavita scan');
        return;
      }
      case 'komga': {
        const ids = app.libraryId ? [app.libraryId] : await this.komgaLibraries(app);
        for (const id of ids) await this.send(`${app.url}/api/v1/libraries/${encodeURIComponent(id)}/scan`, { method: 'POST', headers: this.komgaHeaders(app) }, 'Komga scan');
        return;
      }
      case 'audiobookshelf': {
        const ids = app.libraryId ? [app.libraryId] : await this.absLibraries(app);
        for (const id of ids) await this.send(`${app.url}/api/libraries/${encodeURIComponent(id)}/scan`, { method: 'POST', headers: this.absHeaders(app) }, 'Audiobookshelf scan');
        return;
      }
      case 'calibreWeb':
        return;
    }
  }
}
