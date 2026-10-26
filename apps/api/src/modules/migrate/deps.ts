import type { Session } from '@arclight/torrent-engine';
import type { AppContext } from '../../app.js';
import type { MigrateBackupRef } from '@arclight/shared';
import type { FetchLike } from './http.js';

// What the importer needs from the rest of Arclight beyond the database. Everything is
// optional: plans and most areas only need the database; the service degrades with a warning
// when something is missing (no engine: torrents cannot be adopted; no backup service: the
// run says it took no backup). `index.ts` wires the real modules lazily through the
// AppContext; tests pass fakes.

/** One indexer definition of Arclight's catalogue (built-in, feed, custom or community). */
export interface DefinitionRef {
  id: string;
  name: string;
  privacy: 'public' | 'semi-private' | 'private' | null;
  /** Setting names the definition declares (e.g. `username`, `password`, `cookie`). */
  settings: string[];
  /** Site links the definition knows. */
  links: string[];
}

export interface MigrateDeps {
  /** HTTP for API-mode sources (tests use fake servers). */
  fetch?: FetchLike;
  /** The application context, when running inside the app (lazy module access). */
  ctx?: AppContext;
  /** Takes an Arclight backup before a real run writes anything. */
  createBackup?: () => Promise<MigrateBackupRef>;
  /** The built-in torrent engine's running session (null while disabled). */
  torrentSession?: () => Session | null;
  /** Looks up an indexer definition by id (case-insensitive); null when Arclight has none. */
  findDefinition?: (id: string) => DefinitionRef | null;
  /** Hostname resolution for Docker discovery (tests inject a fake). */
  resolveHost?: (host: string) => Promise<boolean>;
  /** TCP reachability for Docker discovery (tests inject a fake). */
  probePort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}
