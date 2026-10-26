import { and, eq, sql } from 'drizzle-orm';
import { DiscoverSliderType, MediaServerLink, OverrideRuleInput, Permission, RequestsSettings, type MediaServerKind, type RequestStatus } from '@arclight/shared';
import * as t from '../../db/schema.js';
import { localUsernameFrom } from '../requests/accounts.js';
import { effectivePermissions } from '../requests/permissions.js';
import { allUserRows, mediaServerLinkOf, type UserRow } from '../requests/users.js';
import { getSection, setSection } from '../settings/service.js';
import { importedTarget, SkipItem, type AreaEnv, type Existing, type Handlers } from './areas.js';
import { importedFromArr } from './arr-refs.js';
import type { SourceItem } from './types.js';
import type { SeerrIssuePayload, SeerrMainSettings, SeerrOverrideRule, SeerrRequestPayload, SeerrSettingsPayload, SeerrSlider, SeerrUserPayload } from './types-requests.js';

// Seerr (Overseerr / Jellyseerr) areas applied to the auth and requests modules: users,
// requests, issues with comments, request settings (defaults, discover sliders, override rules).
//
// Users are matched to Arclight users by media-server identity (the Jellyfin/Emby user id or
// Plex account id that Arclight's media-server sign-in stores in users.settings.mediaServerLink),
// then email, then username. New users get that link, the Seerr permissions and quotas, and no
// usable password: they sign in with their media server (or an admin sets a password). Seerr
// admins are never turned into Arclight administrators; they get the request/issue management
// permissions instead (see SEERR_ADMIN_EQUIVALENT).

/** Never verifies (verifyPassword rejects anything that is not a scrypt hash). */
export const IMPORTED_PASSWORD_HASH = 'disabled$imported-from-seerr';

const KNOWN_PERMISSIONS = (Object.values(Permission) as number[]).reduce((a, b) => a | b, 0);

/** What a Seerr admin may do in Arclight: run requests and issues, not the server. */
export const SEERR_ADMIN_EQUIVALENT =
  Permission.MANAGE_REQUESTS |
  Permission.MANAGE_ISSUES |
  Permission.REQUEST |
  Permission.REQUEST_4K |
  Permission.REQUEST_ADVANCED |
  Permission.REQUEST_VIEW |
  Permission.AUTO_APPROVE |
  Permission.AUTO_APPROVE_4K |
  Permission.VIEW_ISSUES |
  Permission.CREATE_ISSUES |
  Permission.RECENT_VIEW |
  Permission.WATCHLIST_VIEW;

/** Seerr bits (same values as Arclight's) → Arclight bits without ADMIN. */
export function mapSeerrPermissions(bits: number): number {
  let p = bits & KNOWN_PERMISSIONS;
  if ((p & Permission.ADMIN) !== 0) p = (p & ~Permission.ADMIN) | SEERR_ADMIN_EQUIVALENT;
  return p;
}

// ---- users ------------------------------------------------------------------------------------------

function linkFor(p: SeerrUserPayload, now: string): MediaServerLink | null {
  let kind: MediaServerKind | null = null;
  let externalId: string | null = null;
  if (p.userType === 'plex' && p.plexId !== null) {
    kind = 'plex';
    externalId = String(p.plexId);
  } else if ((p.userType === 'jellyfin' || p.userType === 'emby') && p.jellyfinUserId) {
    kind = p.userType;
    externalId = p.jellyfinUserId;
  }
  if (!kind || !externalId) return null;
  return { kind, externalId, username: p.mediaServerUsername ?? p.username ?? p.email, linkedAt: now };
}

function userWithLink(env: AreaEnv, link: MediaServerLink): UserRow | undefined {
  return allUserRows(env.db).find((u) => {
    const l = mediaServerLinkOf(u);
    return l?.kind === link.kind && l.externalId === link.externalId;
  });
}

function quotaOf(p: SeerrUserPayload): Record<string, number | null> | null {
  if (p.movieQuotaLimit === null && p.movieQuotaDays === null && p.tvQuotaLimit === null && p.tvQuotaDays === null) return null;
  return { movieLimit: p.movieQuotaLimit, movieDays: p.movieQuotaDays, tvLimit: p.tvQuotaLimit, tvDays: p.tvQuotaDays };
}

function findUser(env: AreaEnv, p: SeerrUserPayload): Existing | null {
  const link = linkFor(p, env.now);
  if (link) {
    const row = userWithLink(env, link);
    if (row) return { id: row.id, reason: `${row.username} is linked to the same ${link.kind} account` };
  }
  const email = p.email.trim().toLowerCase();
  if (email) {
    const row = env.db.select({ id: t.users.id, username: t.users.username }).from(t.users).where(sql`lower(${t.users.email}) = ${email}`).get();
    if (row) return { id: row.id, reason: `${row.username} has the same email` };
  }
  const name = (p.username ?? '').trim().toLowerCase();
  if (name) {
    const row = env.db.select({ id: t.users.id, username: t.users.username }).from(t.users).where(eq(t.users.usernameKey, name)).get();
    if (row) return { id: row.id, reason: `user ${row.username} exists` };
  }
  return null;
}

function freeUsername(env: AreaEnv, base: string): string {
  const taken = new Set(env.db.select({ key: t.users.usernameKey }).from(t.users).all().map((r) => r.key));
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Fills what the existing user lacks: media-server link, email, display name, avatar, quotas. */
function fillUser(env: AreaEnv, id: number, p: SeerrUserPayload, opts: { permissions: boolean; quotas: 'replace' | 'fill' }): void {
  const row = env.db.select().from(t.users).where(eq(t.users.id, id)).get();
  if (!row) throw new SkipItem('user disappeared');
  const settings: Record<string, unknown> = { ...(row.settings ?? {}) };
  const link = linkFor(p, env.now);
  if (link && row.role === 'admin') {
    // Admins sign in with their Arclight password only; a media-server identity is never linked to one.
    env.warn('users', `${row.username} is an Arclight admin; the ${link.kind} account was not linked`);
  } else if (link && !mediaServerLinkOf(row)) {
    const other = userWithLink(env, link);
    if (!other) settings['mediaServerLink'] = link;
    else if (other.id !== id) env.warn('users', `${row.username}: the ${link.kind} account is already linked to ${other.username}; link not added`);
  }
  const quota = quotaOf(p);
  if (quota && (opts.quotas === 'replace' || settings['quota'] === undefined)) settings['quota'] = quota;
  if (p.locale && settings['locale'] === undefined) settings['locale'] = p.locale;
  const set: Partial<typeof t.users.$inferInsert> = { settings, updatedAt: env.now };
  if (!row.email && p.email) set.email = p.email.toLowerCase();
  if (!row.displayName && p.displayName && p.displayName !== row.username) set.displayName = p.displayName;
  if (!row.avatar && p.avatar) set.avatar = p.avatar;
  if (opts.permissions) set.permissions = effectivePermissions({ role: row.role, permissions: mapSeerrPermissions(p.permissions) | (row.role === 'admin' ? Permission.ADMIN : 0) });
  env.db.update(t.users).set(set).where(eq(t.users.id, id)).run();
}

function createUser(env: AreaEnv, p: SeerrUserPayload): number {
  const base = localUsernameFrom(p.username ?? p.mediaServerUsername ?? (p.email.split('@')[0] || 'user'));
  const username = freeUsername(env, base);
  const settings: Record<string, unknown> = {};
  const link = linkFor(p, env.now);
  if (link) {
    const other = userWithLink(env, link);
    if (!other) settings['mediaServerLink'] = link;
  }
  const quota = quotaOf(p);
  if (quota) settings['quota'] = quota;
  if (p.locale) settings['locale'] = p.locale;
  const email = p.email.trim().toLowerCase();
  return env.db
    .insert(t.users)
    .values({
      username,
      usernameKey: username.toLowerCase(),
      passwordHash: IMPORTED_PASSWORD_HASH,
      displayName: p.displayName && p.displayName !== username ? p.displayName : null,
      email: email || null,
      // Seerr users (Seerr admins included) become portal users: never admin, no app access.
      role: 'user',
      appAccess: [],
      localPassword: false,
      permissions: effectivePermissions({ role: 'user', permissions: mapSeerrPermissions(p.permissions) }),
      avatar: p.avatar,
      settings,
      createdAt: p.createdAt ?? env.now,
      updatedAt: env.now,
    })
    .returning({ id: t.users.id })
    .get().id;
}

/** Arclight user id of a Seerr user: this run, an earlier run, or the matching existing user. */
export function resolveUser(env: AreaEnv, sourceId: string | null): number | null {
  if (sourceId === null) return null;
  const mapped = env.idMap.get(`users:${sourceId}`);
  if (mapped !== undefined) return mapped;
  const prior = importedTarget(env.db, env.instance, 'users', sourceId);
  if (prior?.targetId) return prior.targetId;
  const item = env.bundle.areas.users?.items.find((i) => i.sourceId === sourceId);
  return item ? (findUser(env, item.payload)?.id ?? null) : null;
}

// ---- library facts ---------------------------------------------------------------------------------

interface TitleFacts {
  title: string;
  year: number | null;
  poster: string | null;
  libraryId: number | null;
  tvdbId: number | null;
}

function posterOf(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const p = images.find((i) => i && typeof i === 'object' && (i as { coverType?: string }).coverType === 'poster') as { url?: string; remoteUrl?: string | null } | undefined;
  return p?.remoteUrl ?? p?.url ?? null;
}

/** Title and poster from the Arclight library; a `TMDB <id>` placeholder when the title is not in it. */
function titleFacts(env: AreaEnv, mediaType: 'movie' | 'tv', tmdbId: number): TitleFacts {
  if (mediaType === 'tv') {
    const s = env.db.select({ id: t.series.id, title: t.series.title, year: t.series.year, images: t.series.images, tvdbId: t.series.tvdbId }).from(t.series).where(eq(t.series.tmdbId, tmdbId)).get();
    if (s) return { title: s.title, year: s.year || null, poster: posterOf(s.images), libraryId: s.id, tvdbId: s.tvdbId };
  } else {
    const m = env.db.select({ id: t.movies.id, title: t.movies.title, year: t.movies.year, images: t.movies.images }).from(t.movies).where(eq(t.movies.tmdbId, tmdbId)).get();
    if (m) return { title: m.title, year: m.year || null, poster: posterOf(m.images), libraryId: m.id, tvdbId: null };
  }
  return { title: `TMDB ${tmdbId}`, year: null, poster: null, libraryId: null, tvdbId: null };
}

function arrApp(mediaType: 'movie' | 'tv'): 'sonarr' | 'radarr' {
  return mediaType === 'tv' ? 'sonarr' : 'radarr';
}

function arrTags(env: AreaEnv, mediaType: 'movie' | 'tv', ids: number[]): number[] {
  return [...new Set(ids.map((id) => importedFromArr(env, arrApp(mediaType), 'tags', id)).filter((x): x is number => x !== null))].sort((a, b) => a - b);
}

// ---- requests -----------------------------------------------------------------------------------------

function requestKind(p: { mediaType: 'movie' | 'tv' }): 'series' | 'movie' {
  return p.mediaType === 'tv' ? 'series' : 'movie';
}

function findRequest(env: AreaEnv, p: SeerrRequestPayload): Existing | null {
  const requester = resolveUser(env, p.requestedBySourceId);
  if (requester === null || p.tmdbId === null) return null;
  const rows = env.db
    .select({ id: t.mediaRequests.id, is4k: t.mediaRequests.is4k, createdAt: t.mediaRequests.createdAt })
    .from(t.mediaRequests)
    .where(and(eq(t.mediaRequests.type, requestKind(p)), eq(t.mediaRequests.tmdbId, p.tmdbId), eq(t.mediaRequests.requestedById, requester)))
    .all()
    .filter((r) => r.is4k === p.is4k);
  const hit = rows.find((r) => p.createdAt === null || r.createdAt === p.createdAt) ?? (p.createdAt === null ? rows[0] : undefined);
  return hit ? { id: hit.id, reason: 'the same user already requested this title' } : null;
}

function writeSeasons(env: AreaEnv, requestId: number, p: SeerrRequestPayload, replace: boolean): void {
  const existing = new Map(env.db.select().from(t.seasonRequests).where(eq(t.seasonRequests.requestId, requestId)).all().map((s) => [s.seasonNumber, s]));
  for (const s of p.seasons) {
    const status: RequestStatus = s.status ?? p.status ?? 'pending';
    const row = existing.get(s.seasonNumber);
    if (!row) env.db.insert(t.seasonRequests).values({ requestId, seasonNumber: s.seasonNumber, status }).run();
    else if (replace) env.db.update(t.seasonRequests).set({ status }).where(eq(t.seasonRequests.id, row.id)).run();
  }
}

function createRequest(env: AreaEnv, item: SourceItem<SeerrRequestPayload>): number {
  const p = item.payload;
  if (p.tmdbId === null || p.status === null) throw new SkipItem('no TMDB id or status');
  const requester = resolveUser(env, p.requestedBySourceId);
  if (requester === null) throw new SkipItem(`requesting user ${p.requestedBySourceId ?? '?'} was not imported`);
  const facts = titleFacts(env, p.mediaType, p.tmdbId);
  if (facts.libraryId === null) env.warn('requests', `${item.name}: not in the Arclight library; the title shows as "${facts.title}" until it is added`, item.sourceId);
  const profile = importedFromArr(env, arrApp(p.mediaType), 'qualityProfiles', p.profileId);
  const created = p.createdAt ?? env.now;
  const id = env.db
    .insert(t.mediaRequests)
    .values({
      type: requestKind(p),
      status: p.status,
      is4k: p.is4k,
      tmdbId: p.tmdbId,
      tvdbId: p.tvdbId ?? facts.tvdbId,
      title: facts.title,
      year: facts.year,
      poster: facts.poster,
      backdrop: null,
      requestedById: requester,
      modifiedById: resolveUser(env, p.modifiedBySourceId),
      rootFolderPath: p.rootFolder,
      qualityProfileId: profile,
      tags: arrTags(env, p.mediaType, p.tags),
      isAutoRequest: p.isAutoRequest,
      libraryId: facts.libraryId,
      createdAt: created,
      updatedAt: p.updatedAt ?? created,
    })
    .returning({ id: t.mediaRequests.id })
    .get().id;
  writeSeasons(env, id, p, true);
  return id;
}

// ---- issues -------------------------------------------------------------------------------------------

function findIssue(env: AreaEnv, p: SeerrIssuePayload): Existing | null {
  const creator = resolveUser(env, p.createdBySourceId);
  if (creator === null || p.tmdbId === null) return null;
  const row = env.db
    .select({ id: t.issues.id, createdAt: t.issues.createdAt, type: t.issues.type, season: t.issues.problemSeason, episode: t.issues.problemEpisode })
    .from(t.issues)
    .where(and(eq(t.issues.tmdbId, p.tmdbId), eq(t.issues.createdById, creator)))
    .all()
    .find((r) => r.type === p.issueType && r.season === p.problemSeason && r.episode === p.problemEpisode && (p.createdAt === null || r.createdAt === p.createdAt));
  return row ? { id: row.id, reason: 'the same issue exists' } : null;
}

function addComments(env: AreaEnv, issueId: number, fallbackUser: number, p: SeerrIssuePayload): void {
  const existing = env.db.select({ message: t.issueComments.message, createdAt: t.issueComments.createdAt }).from(t.issueComments).where(eq(t.issueComments.issueId, issueId)).all();
  for (const c of p.comments) {
    if (!c.message.trim()) continue;
    if (existing.some((e) => e.message === c.message && (c.createdAt === null || e.createdAt === c.createdAt))) continue;
    const at = c.createdAt ?? p.createdAt ?? env.now;
    env.db.insert(t.issueComments).values({ issueId, userId: resolveUser(env, c.userSourceId) ?? fallbackUser, message: c.message, createdAt: at, updatedAt: at }).run();
  }
}

function createIssue(env: AreaEnv, item: SourceItem<SeerrIssuePayload>): number {
  const p = item.payload;
  if (p.tmdbId === null || p.mediaType === null) throw new SkipItem('issue has no media');
  const creator = resolveUser(env, p.createdBySourceId);
  if (creator === null) throw new SkipItem(`reporting user ${p.createdBySourceId ?? '?'} was not imported`);
  const facts = titleFacts(env, p.mediaType, p.tmdbId);
  const created = p.createdAt ?? env.now;
  const id = env.db
    .insert(t.issues)
    .values({
      type: p.issueType,
      status: p.status,
      mediaType: requestKind({ mediaType: p.mediaType }),
      tmdbId: p.tmdbId,
      title: facts.title,
      year: facts.year,
      poster: facts.poster,
      problemSeason: p.problemSeason,
      problemEpisode: p.problemEpisode,
      createdById: creator,
      modifiedById: resolveUser(env, p.modifiedBySourceId),
      createdAt: created,
      updatedAt: p.updatedAt ?? created,
    })
    .returning({ id: t.issues.id })
    .get().id;
  addComments(env, id, creator, p);
  return id;
}

// ---- request settings --------------------------------------------------------------------------------

function settingsStored(env: AreaEnv, key: string): boolean {
  return env.db.select({ key: t.settings.key }).from(t.settings).where(eq(t.settings.key, key)).get() !== undefined;
}

function applyMain(env: AreaEnv, m: SeerrMainSettings): void {
  const current = RequestsSettings.parse(getSection(env.db, 'requests') ?? {});
  const next = { ...current };
  if (m.defaultPermissions !== null) next.defaultPermissions = mapSeerrPermissions(m.defaultPermissions);
  if (m.movieQuotaLimit !== null || m.movieQuotaDays !== null || m.tvQuotaLimit !== null || m.tvQuotaDays !== null) {
    // Seerr's 0 means unlimited; Arclight's null does.
    const lim = (v: number | null) => (v === null || v <= 0 ? null : v);
    next.defaultQuotas = { movieLimit: lim(m.movieQuotaLimit), movieDays: lim(m.movieQuotaDays), tvLimit: lim(m.tvQuotaLimit), tvDays: lim(m.tvQuotaDays) };
  }
  if (m.partialRequestsEnabled !== null) next.partialRequestsEnabled = m.partialRequestsEnabled;
  if (m.enableSpecialEpisodes !== null) next.enableSpecialEpisodes = m.enableSpecialEpisodes;
  if (m.hideAvailable !== null) next.hideAvailable = m.hideAvailable;
  if (m.applicationUrl && !current.applicationUrl) next.applicationUrl = m.applicationUrl;
  setSection(env.db, 'requests', RequestsSettings.parse(next), env.now);
}

function sliderType(s: SeerrSlider): (typeof DiscoverSliderType.options)[number] {
  const type = DiscoverSliderType.options[s.type - 1];
  if (!type) throw new SkipItem(`discover slider type ${s.type} is not known`);
  return type;
}

function findSlider(env: AreaEnv, s: SeerrSlider): Existing | null {
  const type = sliderType(s);
  const rows = env.db.select().from(t.discoverSliders).where(eq(t.discoverSliders.type, type)).all();
  const hit = s.isBuiltIn ? rows.find((r) => r.isBuiltIn) : rows.find((r) => !r.isBuiltIn && (r.title ?? null) === s.title && (r.data ?? null) === s.data);
  return hit ? { id: hit.id, reason: s.isBuiltIn ? `the built-in ${type} slider exists` : `a ${type} slider with the same title exists` } : null;
}

function overrideName(item: SourceItem<SeerrSettingsPayload>): string {
  return `Seerr ${item.name.toLowerCase()}`;
}

function overrideValues(env: AreaEnv, item: SourceItem<SeerrSettingsPayload>, r: SeerrOverrideRule) {
  const users = r.users.map((u) => resolveUser(env, u)).filter((x): x is number => x !== null);
  if (users.length < r.users.length) env.warn('requestSettings', `${item.name}: ${r.users.length - users.length} user(s) of the rule were not imported`, item.sourceId);
  const profile = importedFromArr(env, arrApp(r.mediaType), 'qualityProfiles', r.profileId);
  if (r.profileId !== null && profile === null) env.warn('requestSettings', `${item.name}: quality profile ${r.profileId} could not be matched; the rule leaves the profile alone`, item.sourceId);
  const parsed = OverrideRuleInput.parse({
    name: overrideName(item),
    mediaType: requestKind(r),
    users,
    genres: r.genres,
    languages: r.languages.filter((l) => l.length >= 2 && l.length <= 3),
    keywords: r.keywords,
    qualityProfileId: profile,
    rootFolderPath: r.rootFolder,
    tags: arrTags(env, r.mediaType, r.tags),
    autoApprove: false,
  });
  return { ...parsed, updatedAt: env.now };
}

function settingsFind(env: AreaEnv, item: SourceItem<SeerrSettingsPayload>): Existing | null {
  const p = item.payload;
  if (p.kind === 'main') return settingsStored(env, 'requests') ? { id: null, reason: 'request settings are already configured' } : null;
  if (p.kind === 'slider') return findSlider(env, p);
  const row = env.db.select({ id: t.overrideRules.id }).from(t.overrideRules).where(eq(t.overrideRules.name, overrideName(item))).get();
  return row ? { id: row.id, reason: 'the rule was imported before' } : null;
}

function settingsCreate(env: AreaEnv, item: SourceItem<SeerrSettingsPayload>): number | null {
  const p = item.payload;
  if (p.kind === 'main') {
    applyMain(env, p);
    return null;
  }
  if (p.kind === 'slider') {
    return env.db
      .insert(t.discoverSliders)
      .values({ type: sliderType(p), sortOrder: p.order, isBuiltIn: p.isBuiltIn, enabled: p.enabled, title: p.title, data: p.data, createdAt: env.now, updatedAt: env.now })
      .returning({ id: t.discoverSliders.id })
      .get().id;
  }
  return env.db
    .insert(t.overrideRules)
    .values({ ...overrideValues(env, item, p), createdAt: env.now })
    .returning({ id: t.overrideRules.id })
    .get().id;
}

function settingsOverwrite(env: AreaEnv, item: SourceItem<SeerrSettingsPayload>, existing: Existing): number | null {
  const p = item.payload;
  if (p.kind === 'main') {
    applyMain(env, p);
    return null;
  }
  if (p.kind === 'slider') {
    env.db.update(t.discoverSliders).set({ enabled: p.enabled, sortOrder: p.order, updatedAt: env.now }).where(eq(t.discoverSliders.id, existing.id!)).run();
    return existing.id;
  }
  env.db.update(t.overrideRules).set(overrideValues(env, item, p)).where(eq(t.overrideRules.id, existing.id!)).run();
  return existing.id;
}

// ---- handlers -----------------------------------------------------------------------------------------

export const REQUEST_HANDLERS: Handlers = {
  users: {
    find: (env, item) => findUser(env, item.payload),
    create: (env, item) => createUser(env, item.payload),
    overwrite: (env, item, existing) => {
      fillUser(env, existing.id!, item.payload, { permissions: true, quotas: 'replace' });
      return existing.id;
    },
    merge: (env, item, existing) => {
      fillUser(env, existing.id!, item.payload, { permissions: false, quotas: 'fill' });
      return existing.id;
    },
  },

  requestSettings: {
    find: (env, item) => settingsFind(env, item),
    create: (env, item) => settingsCreate(env, item),
    overwrite: (env, item, existing) => settingsOverwrite(env, item, existing),
  },

  requests: {
    find: (env, item) => findRequest(env, item.payload),
    create: (env, item) => createRequest(env, item),
    overwrite: (env, item, existing) => {
      const p = item.payload;
      const set: Partial<typeof t.mediaRequests.$inferInsert> = { updatedAt: p.updatedAt ?? env.now };
      if (p.status) set.status = p.status;
      const modifier = resolveUser(env, p.modifiedBySourceId);
      if (modifier !== null) set.modifiedById = modifier;
      env.db.update(t.mediaRequests).set(set).where(eq(t.mediaRequests.id, existing.id!)).run();
      writeSeasons(env, existing.id!, p, true);
      return existing.id;
    },
    merge: (env, item, existing) => {
      writeSeasons(env, existing.id!, item.payload, false);
      return existing.id;
    },
  },

  issues: {
    find: (env, item) => findIssue(env, item.payload),
    create: (env, item) => createIssue(env, item),
    overwrite: (env, item, existing) => {
      const p = item.payload;
      env.db.update(t.issues).set({ status: p.status, updatedAt: p.updatedAt ?? env.now }).where(eq(t.issues.id, existing.id!)).run();
      addComments(env, existing.id!, resolveUser(env, p.createdBySourceId) ?? 0, p);
      return existing.id;
    },
    merge: (env, item, existing) => {
      addComments(env, existing.id!, resolveUser(env, item.payload.createdBySourceId) ?? 0, item.payload);
      return existing.id;
    },
  },
};
