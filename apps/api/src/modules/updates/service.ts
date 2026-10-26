import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { UpdateRelease, UpdateSettings, type UpdateInfo, type UpdateSettingsUpdate } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import { fetchGhcrTags, fetchGithubReleases, type UpdateSourceOptions } from './github.js';
import { compareVersions, isPrerelease, normalizeVersion } from './version.js';

// Update checks: settings section `updates`, the cached last result (settings key
// `updateCheck`, so it survives restarts) and the check itself. GET /system/update is served
// from the cache; the UpdateCheck job and POST /system/update/check refresh it.

export const UPDATES_SECTION = 'updates';
export const UPDATE_CACHE_KEY = 'updateCheck';
/** Image tag every push to main publishes (docs/RELEASING.md). */
export const DEVELOP_TAG = 'develop';
/** Changelog panes shown when the running version is already the latest. */
const RECENT_WHEN_CURRENT = 3;
const KEEP_RELEASES = 20;

export class UpdatesError extends Error {
  constructor(
    readonly code: 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'UpdatesError';
  }
}

const UpdateCache = z.object({
  checkedAt: z.string().nullable().default(null),
  /** Every published release on the configured channel, newest first. */
  releases: z.array(UpdateRelease).default([]),
  /** The `develop` image tag exists on GHCR. */
  developPublished: z.boolean().default(false),
  /** Repo/channel the cache was built for; a settings change invalidates it. */
  repo: z.string().optional(),
  channel: z.string().optional(),
  error: z.string().optional(),
  lastAttemptAt: z.string().optional(),
});
type UpdateCache = z.infer<typeof UpdateCache>;

export interface UpdatesServiceOptions {
  db: Db;
  currentVersion: string;
  isDocker: boolean;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  githubApi?: string;
  ghcr?: string;
}

function readKey(db: Db, key: string): unknown {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

function writeKey(db: Db, key: string, value: unknown, now: string): void {
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

export class UpdatesService {
  private inFlight: Promise<UpdateInfo> | null = null;

  constructor(private readonly opts: UpdatesServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  settings(): UpdateSettings {
    const parsed = UpdateSettings.safeParse(readKey(this.opts.db, UPDATES_SECTION) ?? {});
    return parsed.success ? parsed.data : UpdateSettings.parse({});
  }

  updateSettings(patch: UpdateSettingsUpdate): UpdateSettings {
    const parsed = UpdateSettings.safeParse({ ...this.settings(), ...patch });
    if (!parsed.success) throw new UpdatesError('VALIDATION', parsed.error.message);
    writeKey(this.opts.db, UPDATES_SECTION, parsed.data, this.now().toISOString());
    return parsed.data;
  }

  private cache(): UpdateCache {
    const parsed = UpdateCache.safeParse(readKey(this.opts.db, UPDATE_CACHE_KEY) ?? {});
    return parsed.success ? parsed.data : UpdateCache.parse({});
  }

  /** The cached result as the api serves it, recomputed against the running version. */
  info(): UpdateInfo {
    const s = this.settings();
    const raw = this.cache();
    // A cache built for another repo/channel says nothing about this one.
    const cache = raw.repo === undefined || (raw.repo === s.repo && raw.channel === s.channel) ? raw : UpdateCache.parse({});
    const current = this.opts.currentVersion;
    const latest = cache.releases[0];
    const updateAvailable = latest !== undefined && compareVersions(latest.version, current) > 0;
    const newer = cache.releases.filter((r) => compareVersions(r.version, current) > 0);
    const imageTag = latest ? (s.channel === 'develop' && cache.developPublished ? DEVELOP_TAG : latest.imageTag) : undefined;
    return {
      currentVersion: current,
      ...(latest ? { latestVersion: latest.version, releaseNotes: latest.notes } : {}),
      ...(imageTag ? { imageTag } : {}),
      image: `ghcr.io/${s.repo.toLowerCase()}`,
      checkedAt: cache.checkedAt,
      updateAvailable,
      channel: s.channel,
      repo: s.repo,
      enabled: s.enabled,
      isDocker: this.opts.isDocker,
      releases: newer.length > 0 ? newer : cache.releases.slice(0, RECENT_WHEN_CURRENT),
      ...(cache.error ? { error: cache.error } : {}),
    };
  }

  /** The job's gate: enabled and the last attempt is older than the interval. */
  isDue(): boolean {
    const s = this.settings();
    if (!s.enabled) return false;
    const cache = this.cache();
    const last = cache.lastAttemptAt ?? cache.checkedAt;
    if (!last || cache.repo !== s.repo || cache.channel !== s.channel) return true;
    return this.now().getTime() - new Date(last).getTime() >= s.checkIntervalHours * 3_600_000;
  }

  /** Query GitHub (and GHCR) now. Failures keep the previous result and record the error. */
  check(): Promise<UpdateInfo> {
    this.inFlight ??= this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private sourceOptions(): UpdateSourceOptions {
    return {
      userAgent: this.opts.userAgent ?? `Arclight/${this.opts.currentVersion}`,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.githubApi ? { githubApi: this.opts.githubApi } : {}),
      ...(this.opts.ghcr ? { ghcr: this.opts.ghcr } : {}),
    };
  }

  private async runCheck(): Promise<UpdateInfo> {
    const s = this.settings();
    const nowIso = this.now().toISOString();
    const previous = this.cache();
    const sameTarget = previous.repo === s.repo && previous.channel === s.channel;
    try {
      const source = this.sourceOptions();
      const githubReleases = await fetchGithubReleases(s.repo, source);
      // GHCR is a refinement (is the image out yet?); without it every release counts.
      const tags = await fetchGhcrTags(s.repo, source).catch(() => null);
      const tagSet = tags ? new Set(tags) : null;
      const releases: UpdateRelease[] = [];
      for (const r of githubReleases) {
        if (r.draft) continue;
        const version = normalizeVersion(r.tag);
        if (!version) continue;
        const pre = r.prerelease || isPrerelease(version);
        if (pre && s.channel === 'stable') continue;
        const imageTag = tagSet ? [r.tag, `v${version}`, version].find((t) => tagSet.has(t)) : `v${version}`;
        // Released on GitHub but the image is not pushed yet: not an update you can pull.
        if (!imageTag) continue;
        releases.push({
          version,
          tag: r.tag,
          notes: r.body,
          prerelease: pre,
          imageTag,
          ...(r.name ? { name: r.name } : {}),
          ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
          ...(r.url ? { url: r.url } : {}),
        });
      }
      releases.sort((a, b) => compareVersions(b.version, a.version));
      const cache: UpdateCache = {
        checkedAt: nowIso,
        lastAttemptAt: nowIso,
        releases: releases.slice(0, KEEP_RELEASES),
        developPublished: tagSet?.has(DEVELOP_TAG) ?? false,
        repo: s.repo,
        channel: s.channel,
      };
      writeKey(this.opts.db, UPDATE_CACHE_KEY, cache, nowIso);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kept: UpdateCache = sameTarget
        ? { ...previous, error: message, lastAttemptAt: nowIso }
        : { checkedAt: null, releases: [], developPublished: false, repo: s.repo, channel: s.channel, error: message, lastAttemptAt: nowIso };
      writeKey(this.opts.db, UPDATE_CACHE_KEY, kept, nowIso);
    }
    return this.info();
  }
}
