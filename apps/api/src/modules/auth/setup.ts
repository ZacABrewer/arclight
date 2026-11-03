import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  SetupRequest,
  type RootFolder,
  type SetupAdminRequest,
  type SetupRootFolderRequest,
  type SetupStatus,
  type User,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { downloadClients, indexers, rootFolders } from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { getSection, updateMetadataSettings } from '../settings/service.js';
import { AuthError, type AuthService, type RequestAuth } from './service.js';

// First-run setup. The wizard creates the admin first (and is signed in by it), then saves
// each later step through the normal endpoints, then calls complete. POST /setup/complete
// also accepts everything in one body for headless installs.

type ParsedSetup = ReturnType<typeof SetupRequest.parse>;

export class SetupService {
  private creatingAdmin = false;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  status(): SetupStatus {
    const has = (table: typeof rootFolders | typeof downloadClients | typeof indexers) =>
      this.db.select().from(table).limit(1).get() !== undefined;
    return {
      needsSetup: this.auth.needsSetup(),
      steps: [
        { id: 'admin', complete: this.auth.hasAdmin(), optional: false },
        {
          id: 'tmdb',
          complete: getSection(this.db, 'metadata').tmdbApiKey !== undefined || Boolean(process.env['ARCLIGHT_TMDB_API_KEY']),
          optional: false,
        },
        { id: 'rootFolders', complete: has(rootFolders), optional: false },
        { id: 'downloadClient', complete: has(downloadClients), optional: true },
        { id: 'indexer', complete: has(indexers), optional: true },
      ],
    };
  }

  /**
   * Setup writes (after the admin step) are allowed only before completion and only by the
   * signed-in admin: the admin account always comes first, so nothing is written anonymously.
   */
  assertCanWrite(caller: RequestAuth | null): void {
    if (!this.auth.needsSetup()) throw new AuthError('SETUP_COMPLETE', 'setup is already complete');
    if (!this.auth.hasAdmin()) throw new AuthError('SETUP_REQUIRED', 'create the admin account first');
    if (!caller) throw new AuthError('UNAUTHORIZED', 'sign in as the admin to continue setup');
    if (!caller.isAdmin) throw new AuthError('FORBIDDEN', 'admin only');
  }

  /**
   * The first admin: a local account (username + password), only while no admin exists. Shares
   * the setup lock with complete(): hashing the password yields, so two first-launch requests
   * could otherwise both pass the "no admin yet" check (AUTH-08).
   */
  async createAdmin(input: SetupAdminRequest): Promise<User> {
    return this.exclusive(async () => {
      if (this.auth.hasAdmin()) throw new AuthError('USER_EXISTS', 'an admin account already exists');
      return this.auth.createUser({ ...input, role: 'admin' });
    });
  }

  /** Runs `fn` while no other admin-creating setup call runs; a concurrent one gets USER_EXISTS. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.creatingAdmin) throw new AuthError('USER_EXISTS', 'an admin account already exists');
    this.creatingAdmin = true;
    try {
      return await fn();
    } finally {
      this.creatingAdmin = false;
    }
  }

  async addRootFolder(input: SetupRootFolderRequest): Promise<RootFolder> {
    const path = input.path.trim();
    if (!isAbsolute(path)) throw new AuthError('VALIDATION', `root folder path must be absolute: ${path}`);
    const existing = this.db
      .select()
      .from(rootFolders)
      .all()
      .find((r) => resolve(r.path) === resolve(path));
    if (existing) return libraryService.getRootFolder(this.db, existing.id);
    if (input.createIfMissing ?? true) {
      const found = await stat(path).catch(() => null);
      if (!found) await mkdir(path, { recursive: true });
    }
    try {
      return await libraryService.addRootFolder(this.db, { path, mediaType: input.mediaType });
    } catch (err) {
      if (err instanceof Error && 'code' in err) throw new AuthError('VALIDATION', err.message);
      throw err;
    }
  }

  /**
   * Finishes setup. Without an admin yet, the body's username and password create it first and
   * only then is anything written (root folders are created on disk), all under the setup lock, so
   * an anonymous caller cannot create folders and two racing calls cannot both create an admin
   * (AUTH-08). A failed step can be retried with the same body: the admin it created signs the
   * retry in (rate-limited like a sign-in). A second call after success is 409.
   */
  async complete(body: SetupRequest, caller: RequestAuth | null, address = 'unknown'): Promise<SetupStatus> {
    const input = SetupRequest.parse(body);
    if (!this.auth.hasAdmin()) {
      if (!input.username || !input.password) {
        throw new AuthError('VALIDATION', 'username and password are required to create the admin');
      }
      for (const folder of input.rootFolders ?? []) {
        const path = folder.path.trim();
        if (!isAbsolute(path)) throw new AuthError('VALIDATION', `root folder path must be absolute: ${path}`);
      }
      const { username, password } = input;
      return this.exclusive(async () => {
        if (this.auth.hasAdmin()) throw new AuthError('USER_EXISTS', 'an admin account already exists');
        await this.auth.createUser({ username, password, ...(input.email ? { email: input.email } : {}), role: 'admin' });
        return this.finish(input);
      });
    }
    await this.assertCompleteCaller(input, caller, address);
    return this.finish(input);
  }

  /** After the admin exists: the signed-in admin, or (a headless retry) the body's admin credentials. */
  private async assertCompleteCaller(input: ParsedSetup, caller: RequestAuth | null, address: string): Promise<void> {
    if (caller || !input.username || !input.password || !this.auth.needsSetup()) {
      this.assertCanWrite(caller);
      return;
    }
    this.auth.checkRateLimit(address, input.username);
    const row = await this.auth.verifyCredentials(input.username, input.password);
    if (!row || row.role !== 'admin') {
      this.auth.recordFailure(address, input.username);
      throw new AuthError('UNAUTHORIZED', 'sign in as the admin to continue setup');
    }
    this.auth.recordSuccess(address, input.username);
  }

  private async finish(input: ParsedSetup): Promise<SetupStatus> {
    for (const folder of input.rootFolders ?? []) {
      await this.addRootFolder({ ...folder, createIfMissing: true });
    }
    if (input.tmdbApiKey) updateMetadataSettings(this.db, { tmdbApiKey: input.tmdbApiKey });
    if (input.signIn) this.auth.updateSignInSettings(input.signIn);
    this.auth.updateAuthSettings({ ...this.auth.authSettings(), method: input.authMethod });
    this.auth.markSetupComplete();
    return this.status();
  }
}
