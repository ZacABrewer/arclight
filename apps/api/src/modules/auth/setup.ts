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

export class SetupService {
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

  /** The first admin: a local account (username + password), only while no admin exists. */
  async createAdmin(input: SetupAdminRequest): Promise<User> {
    if (this.auth.hasAdmin()) throw new AuthError('USER_EXISTS', 'an admin account already exists');
    return this.auth.createUser({ ...input, role: 'admin' });
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
   * Finishes setup. Root folders and the TMDB key are applied before the admin is created,
   * so a failure can be retried with the same body. A second call after success is 409.
   */
  async complete(body: SetupRequest, caller: RequestAuth | null): Promise<SetupStatus> {
    const input = SetupRequest.parse(body);
    const creatingAdmin = !this.auth.hasAdmin();
    if (creatingAdmin) {
      if (!input.username || !input.password) {
        throw new AuthError('VALIDATION', 'username and password are required to create the admin');
      }
    } else {
      this.assertCanWrite(caller);
    }
    for (const folder of input.rootFolders ?? []) {
      await this.addRootFolder({ ...folder, createIfMissing: true });
    }
    if (input.tmdbApiKey) updateMetadataSettings(this.db, { tmdbApiKey: input.tmdbApiKey });
    if (creatingAdmin && input.username && input.password) {
      await this.auth.createUser({
        username: input.username,
        password: input.password,
        ...(input.email ? { email: input.email } : {}),
        role: 'admin',
      });
    }
    if (input.signIn) this.auth.updateSignInSettings(input.signIn);
    this.auth.updateAuthSettings({ ...this.auth.authSettings(), method: input.authMethod });
    this.auth.markSetupComplete();
    return this.status();
  }
}
