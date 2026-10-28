import { asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  ALL_QUALITIES,
  defaultAlbumTypeProfiles,
  qualitiesForDomain,
  qualityById,
  qualityDomain,
  type CustomFormat,
  type CustomFormatInput,
  type CustomFormatTestRequest,
  type CustomFormatTestResponse,
  type DelayProfile,
  type DelayProfileInput,
  type MediaDomain,
  type QualityDefinitionItem,
  type QualityDefinitionLimits,
  type QualityProfile,
  type QualityProfileInput,
  type ReleaseEvaluation,
  type ReleaseProfile,
  type ReleaseProfileInput,
} from '@arclight/shared';
import {
  buildItems,
  calculateFormatScore,
  defaultCustomFormats,
  defaultDelayProfile,
  defaultQualityProfiles,
  isValidTerm,
  matchCustomFormats,
  reorderDelayProfiles,
  validateCustomFormat,
  validateQualityProfile,
} from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import { albumTypeProfiles, artists, movies, series } from '../../db/schema.js';
import { customFormats, delayProfiles, qualityDefinitions, qualityProfiles, releaseProfiles } from './schema.js';

export type ProfileErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'IN_USE' | 'CONFLICT';

export class ProfileError extends Error {
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ProfilesServiceOptions {
  db: Db;
  log?: Logger;
  /**
   * Hooks into the library module: is a quality profile referenced by any series/movie?
   * Defaults to "never", so a fresh install can delete freely. Wire the real check when
   * the library module registers.
   */
  isQualityProfileInUse?: (id: number) => boolean | Promise<boolean>;
  /** Same for delay/release profile tags, if a module wants to protect them. */
  isCustomFormatInUse?: (id: number) => boolean | Promise<boolean>;
}

function assertValid(issues: ReadonlyArray<{ path: string; message: string }>): void {
  if (issues.length > 0) {
    throw new ProfileError('VALIDATION', issues.map((i) => `${i.path}: ${i.message}`).join('; '), issues);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class ProfilesService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly isQualityProfileInUse: (id: number) => boolean | Promise<boolean>;
  private readonly isCustomFormatInUse: (id: number) => boolean | Promise<boolean>;

  constructor(opts: ProfilesServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.isQualityProfileInUse = opts.isQualityProfileInUse ?? (() => false);
    this.isCustomFormatInUse = opts.isCustomFormatInUse ?? (() => false);
  }

  // -------------------------------------------------------------------------------------
  // seeding

  /** Insert defaults into any empty table. Safe to call on every start. */
  seedDefaults(): {
    qualityProfiles: number;
    customFormats: number;
    delayProfiles: number;
    qualityDefinitions: number;
    albumTypeProfiles: number;
  } {
    const seeded = { qualityProfiles: 0, customFormats: 0, delayProfiles: 0, qualityDefinitions: 0, albumTypeProfiles: 0 };

    if (this.db.select({ id: qualityProfiles.id }).from(qualityProfiles).limit(1).all().length === 0) {
      for (const p of defaultQualityProfiles()) {
        this.db.insert(qualityProfiles).values(p).run();
        seeded.qualityProfiles++;
      }
    }
    if (this.db.select({ id: customFormats.id }).from(customFormats).limit(1).all().length === 0) {
      for (const f of defaultCustomFormats()) {
        this.db.insert(customFormats).values(f).run();
        seeded.customFormats++;
      }
    }
    if (this.db.select({ id: delayProfiles.id }).from(delayProfiles).limit(1).all().length === 0) {
      this.db.insert(delayProfiles).values(defaultDelayProfile()).run();
      seeded.delayProfiles++;
    }
    const existingDefs = new Set(this.db.select({ qualityId: qualityDefinitions.qualityId }).from(qualityDefinitions).all().map((r) => r.qualityId));
    for (const q of ALL_QUALITIES) {
      if (existingDefs.has(q.id)) continue;
      this.db.insert(qualityDefinitions).values({ qualityId: q.id, minSize: null, maxSize: null, preferredSize: null }).run();
      seeded.qualityDefinitions++;
    }

    // Album-type profiles (music): which release groups become albums. Seeded on every install
    // (cheap, and an artist always needs one) whether or not music is enabled.
    if (this.db.select({ id: albumTypeProfiles.id }).from(albumTypeProfiles).limit(1).all().length === 0) {
      for (const p of defaultAlbumTypeProfiles()) {
        this.db.insert(albumTypeProfiles).values(p).run();
        seeded.albumTypeProfiles++;
      }
    }

    if (Object.values(seeded).some((n) => n > 0)) this.log?.info(seeded, 'seeded profile defaults');
    return seeded;
  }

  // -------------------------------------------------------------------------------------
  // quality profiles

  /** Every profile, or only those of one domain. */
  listQualityProfiles(domain?: MediaDomain): QualityProfile[] {
    const rows = this.db.select().from(qualityProfiles).orderBy(asc(qualityProfiles.id)).all();
    return domain === undefined ? rows : rows.filter((p) => p.mediaDomain === domain);
  }

  /**
   * Null when profile `id` may be assigned to an item of `domain`; otherwise why not. A profile
   * that does not exist is not this check's business (callers keep their existing handling).
   */
  domainMismatch(id: number, domain: MediaDomain): string | null {
    return qualityProfileDomainMismatch(this.db, id, domain);
  }

  getQualityProfile(id: number): QualityProfile {
    const row = this.db.select().from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
    if (!row) throw new ProfileError('NOT_FOUND', `quality profile ${id} not found`);
    return row;
  }

  /** An empty profile with every quality of the domain listed (worst → best) and nothing allowed. */
  qualityProfileTemplate(domain: MediaDomain = 'video'): QualityProfileInput {
    return {
      name: '',
      upgradeAllowed: true,
      cutoff: 0,
      items: buildItems([], domain),
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 1,
      formatItems: [],
      languages: [],
      // Video templates stay exactly as they were before domains existed.
      ...(domain !== 'video' && { mediaDomain: domain }),
    };
  }

  /** How many series, movies and artists use the profile (video version slots are not counted). */
  private qualityProfileUsers(id: number): number {
    const count = (n: { c: number } | undefined) => n?.c ?? 0;
    return (
      count(this.db.select({ c: sql<number>`count(*)` }).from(series).where(eq(series.qualityProfileId, id)).get()) +
      count(this.db.select({ c: sql<number>`count(*)` }).from(movies).where(eq(movies.qualityProfileId, id)).get()) +
      count(this.db.select({ c: sql<number>`count(*)` }).from(artists).where(eq(artists.qualityProfileId, id)).get())
    );
  }

  private validateQualityProfileInput(input: QualityProfileInput): void {
    const issues = validateQualityProfile(input);
    const knownFormats = new Set(this.db.select({ id: customFormats.id }).from(customFormats).all().map((r) => r.id));
    input.formatItems.forEach((f, i) => {
      if (!knownFormats.has(f.formatId)) issues.push({ path: `formatItems[${i}]`, message: `unknown custom format ${f.formatId}` });
    });
    assertValid(issues);
  }

  createQualityProfile(input: QualityProfileInput): QualityProfile {
    this.validateQualityProfileInput(input);
    try {
      return this.db
        .insert(qualityProfiles)
        .values({ ...input, mediaDomain: input.mediaDomain ?? 'video' })
        .returning()
        .get();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProfileError('CONFLICT', `quality profile "${input.name}" already exists`);
      throw err;
    }
  }

  /** An omitted `mediaDomain` keeps the stored one; a profile in use cannot change domain. */
  updateQualityProfile(id: number, input: QualityProfileInput): QualityProfile {
    const existing = this.getQualityProfile(id);
    const current = existing.mediaDomain ?? 'video';
    const mediaDomain = input.mediaDomain ?? current;
    if (mediaDomain !== current && this.qualityProfileUsers(id) > 0) {
      throw new ProfileError('IN_USE', `quality profile ${id} is in use; its media domain (${current}) cannot change`);
    }
    const next = { ...input, mediaDomain };
    this.validateQualityProfileInput(next);
    try {
      return this.db.update(qualityProfiles).set(next).where(eq(qualityProfiles.id, id)).returning().get()!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProfileError('CONFLICT', `quality profile "${input.name}" already exists`);
      throw err;
    }
  }

  async deleteQualityProfile(id: number): Promise<void> {
    this.getQualityProfile(id);
    if (await this.isQualityProfileInUse(id)) throw new ProfileError('IN_USE', `quality profile ${id} is in use`);
    this.db.delete(qualityProfiles).where(eq(qualityProfiles.id, id)).run();
  }

  // -------------------------------------------------------------------------------------
  // custom formats

  listCustomFormats(): CustomFormat[] {
    return this.db.select().from(customFormats).orderBy(asc(customFormats.id)).all();
  }

  getCustomFormat(id: number): CustomFormat {
    const row = this.db.select().from(customFormats).where(eq(customFormats.id, id)).get();
    if (!row) throw new ProfileError('NOT_FOUND', `custom format ${id} not found`);
    return row;
  }

  createCustomFormat(input: CustomFormatInput): CustomFormat {
    assertValid(validateCustomFormat(input));
    try {
      return this.db.insert(customFormats).values(input).returning().get();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProfileError('CONFLICT', `custom format "${input.name}" already exists`);
      throw err;
    }
  }

  updateCustomFormat(id: number, input: CustomFormatInput): CustomFormat {
    this.getCustomFormat(id);
    assertValid(validateCustomFormat(input));
    try {
      return this.db.update(customFormats).set(input).where(eq(customFormats.id, id)).returning().get()!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProfileError('CONFLICT', `custom format "${input.name}" already exists`);
      throw err;
    }
  }

  /** Deleting a format also drops its score entries from every quality profile. */
  async deleteCustomFormat(id: number): Promise<void> {
    this.getCustomFormat(id);
    if (await this.isCustomFormatInUse(id)) throw new ProfileError('IN_USE', `custom format ${id} is in use`);
    this.db.transaction((tx) => {
      for (const profile of tx.select().from(qualityProfiles).all()) {
        if (!profile.formatItems.some((f) => f.formatId === id)) continue;
        tx.update(qualityProfiles)
          .set({ formatItems: profile.formatItems.filter((f) => f.formatId !== id) })
          .where(eq(qualityProfiles.id, profile.id))
          .run();
      }
      tx.delete(customFormats).where(eq(customFormats.id, id)).run();
    });
  }

  /** Which formats match a release, and what it would score under each profile. */
  testCustomFormats(req: CustomFormatTestRequest): CustomFormatTestResponse {
    const quality = qualityById(req.qualityId);
    const evaluation: ReleaseEvaluation = {
      title: req.title,
      languages: req.languages,
      quality: { quality: { ...quality, mediaTypes: [...quality.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
      mediaType: req.mediaType,
      ...(req.releaseGroup !== undefined && { releaseGroup: req.releaseGroup }),
      ...(req.sizeBytes !== undefined && { sizeBytes: req.sizeBytes }),
      ...(req.indexerFlags !== undefined && { indexerFlags: req.indexerFlags }),
      ...(req.edition !== undefined && { edition: req.edition }),
      ...(req.year !== undefined && { year: req.year }),
      ...(req.releaseKind !== undefined && { releaseKind: req.releaseKind }),
    };
    const matchedFormats = matchCustomFormats(this.listCustomFormats(), evaluation);
    const ids = matchedFormats.map((f) => f.id);
    // The request scores a series or movie release, so only video profiles apply.
    const scores = this.listQualityProfiles('video').map((p) => ({
      profileId: p.id,
      profileName: p.name,
      score: calculateFormatScore(p, ids),
    }));
    return { matchedFormats, scores };
  }

  // -------------------------------------------------------------------------------------
  // delay profiles

  listDelayProfiles(): DelayProfile[] {
    return this.db.select().from(delayProfiles).orderBy(asc(delayProfiles.order)).all();
  }

  getDelayProfile(id: number): DelayProfile {
    const row = this.db.select().from(delayProfiles).where(eq(delayProfiles.id, id)).get();
    if (!row) throw new ProfileError('NOT_FOUND', `delay profile ${id} not found`);
    return row;
  }

  private findUntaggedDelayProfile(): DelayProfile | undefined {
    return this.listDelayProfiles().find((p) => p.tags.length === 0);
  }

  createDelayProfile(input: DelayProfileInput): DelayProfile {
    if (input.tags.length === 0 && this.findUntaggedDelayProfile()) {
      throw new ProfileError('VALIDATION', 'only one untagged (default) delay profile is allowed');
    }
    const order = this.listDelayProfiles().length + 1;
    const created = this.db.insert(delayProfiles).values({ ...input, order }).returning().get();
    this.normalizeDelayOrder();
    return this.getDelayProfile(created.id);
  }

  updateDelayProfile(id: number, input: DelayProfileInput): DelayProfile {
    const existing = this.getDelayProfile(id);
    const untagged = this.findUntaggedDelayProfile();
    if (input.tags.length === 0 && untagged && untagged.id !== id) {
      throw new ProfileError('VALIDATION', 'only one untagged (default) delay profile is allowed');
    }
    if (existing.tags.length === 0 && input.tags.length > 0) {
      throw new ProfileError('VALIDATION', 'the default delay profile must stay untagged');
    }
    this.db.update(delayProfiles).set(input).where(eq(delayProfiles.id, id)).run();
    this.normalizeDelayOrder();
    return this.getDelayProfile(id);
  }

  deleteDelayProfile(id: number): void {
    const existing = this.getDelayProfile(id);
    if (existing.tags.length === 0) throw new ProfileError('VALIDATION', 'the default delay profile cannot be deleted');
    this.db.delete(delayProfiles).where(eq(delayProfiles.id, id)).run();
    this.normalizeDelayOrder();
  }

  reorderDelayProfile(id: number, afterId?: number): DelayProfile[] {
    this.getDelayProfile(id);
    if (afterId !== undefined) this.getDelayProfile(afterId);
    const reordered = reorderDelayProfiles(this.listDelayProfiles(), id, afterId);
    this.writeDelayOrder(reordered);
    return this.listDelayProfiles();
  }

  /** Keep `order` dense (1..n) with the default last after any insert/delete. */
  private normalizeDelayOrder(): void {
    const all = this.listDelayProfiles();
    const first = all[0];
    if (!first) return;
    this.writeDelayOrder(reorderDelayProfiles(all, first.id));
  }

  private writeDelayOrder(profiles: ReadonlyArray<DelayProfile>): void {
    this.db.transaction((tx) => {
      for (const p of profiles) tx.update(delayProfiles).set({ order: p.order }).where(eq(delayProfiles.id, p.id)).run();
    });
  }

  // -------------------------------------------------------------------------------------
  // release profiles

  listReleaseProfiles(): ReleaseProfile[] {
    return this.db.select().from(releaseProfiles).orderBy(asc(releaseProfiles.id)).all().map(rowToReleaseProfile);
  }

  getReleaseProfile(id: number): ReleaseProfile {
    const row = this.db.select().from(releaseProfiles).where(eq(releaseProfiles.id, id)).get();
    if (!row) throw new ProfileError('NOT_FOUND', `release profile ${id} not found`);
    return rowToReleaseProfile(row);
  }

  private validateReleaseProfileInput(input: ReleaseProfileInput): void {
    const issues: { path: string; message: string }[] = [];
    if (input.required.length === 0 && input.ignored.length === 0) {
      issues.push({ path: 'required', message: 'a release profile needs at least one required or ignored term' });
    }
    input.required.forEach((t, i) => {
      if (!isValidTerm(t)) issues.push({ path: `required[${i}]`, message: `invalid term: ${t}` });
    });
    input.ignored.forEach((t, i) => {
      if (!isValidTerm(t)) issues.push({ path: `ignored[${i}]`, message: `invalid term: ${t}` });
    });
    assertValid(issues);
  }

  createReleaseProfile(input: ReleaseProfileInput): ReleaseProfile {
    this.validateReleaseProfileInput(input);
    const row = this.db
      .insert(releaseProfiles)
      .values({ ...input, indexerId: input.indexerId ?? null })
      .returning()
      .get();
    return rowToReleaseProfile(row);
  }

  updateReleaseProfile(id: number, input: ReleaseProfileInput): ReleaseProfile {
    this.getReleaseProfile(id);
    this.validateReleaseProfileInput(input);
    const row = this.db
      .update(releaseProfiles)
      .set({ ...input, indexerId: input.indexerId ?? null })
      .where(eq(releaseProfiles.id, id))
      .returning()
      .get()!;
    return rowToReleaseProfile(row);
  }

  deleteReleaseProfile(id: number): void {
    this.getReleaseProfile(id);
    this.db.delete(releaseProfiles).where(eq(releaseProfiles.id, id)).run();
  }

  // -------------------------------------------------------------------------------------
  // quality definitions

  /**
   * The quality definitions of one domain (video by default: the list this route has always
   * served, and the one the Sonarr/Radarr compat layer exposes).
   */
  listQualityDefinitions(domain: MediaDomain = 'video'): QualityDefinitionItem[] {
    const limits = new Map(this.db.select().from(qualityDefinitions).all().map((r) => [r.qualityId, r]));
    // Audio profiles list `Unknown` too, but its size limits belong to the video list.
    const qualities = domain === 'video' ? qualitiesForDomain('video') : qualitiesForDomain(domain).filter((q) => q.id !== 0);
    return qualities.map((q) => {
      const l = limits.get(q.id);
      return {
        qualityId: q.id,
        title: q.name,
        source: q.source,
        resolution: q.resolution,
        modifier: q.modifier,
        weight: q.weight,
        mediaTypes: [...q.mediaTypes],
        ...(q.audio !== undefined && { audio: q.audio }),
        minSize: l?.minSize ?? null,
        maxSize: l?.maxSize ?? null,
        preferredSize: l?.preferredSize ?? null,
      };
    });
  }

  updateQualityDefinition(qualityId: number, limits: QualityDefinitionLimits): QualityDefinitionItem {
    if (qualityById(qualityId).id !== qualityId) throw new ProfileError('NOT_FOUND', `quality ${qualityId} not found`);
    if (limits.minSize !== null && limits.maxSize !== null && limits.maxSize < limits.minSize) {
      throw new ProfileError('VALIDATION', 'maxSize must be >= minSize');
    }
    if (limits.preferredSize !== null) {
      if (limits.minSize !== null && limits.preferredSize < limits.minSize) throw new ProfileError('VALIDATION', 'preferredSize must be >= minSize');
      if (limits.maxSize !== null && limits.preferredSize > limits.maxSize) throw new ProfileError('VALIDATION', 'preferredSize must be <= maxSize');
    }
    this.db
      .insert(qualityDefinitions)
      .values({ qualityId, ...limits })
      .onConflictDoUpdate({ target: qualityDefinitions.qualityId, set: limits })
      .run();
    const item = this.listQualityDefinitions(qualityDomain(qualityById(qualityId))).find((d) => d.qualityId === qualityId);
    if (!item) throw new ProfileError('NOT_FOUND', `quality ${qualityId} not found`);
    return item;
  }
}

/** See `ProfilesService.domainMismatch`. Usable without a service instance (library module). */
export function qualityProfileDomainMismatch(db: Db, id: number, domain: MediaDomain): string | null {
  const row = db.select({ mediaDomain: qualityProfiles.mediaDomain }).from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
  if (!row || row.mediaDomain === domain) return null;
  const who = domain === 'video' ? 'series and movies' : domain === 'music' ? 'artists' : 'authors';
  return `quality profile ${id} is a ${row.mediaDomain} profile; ${who} need a ${domain} profile`;
}

function rowToReleaseProfile(row: typeof releaseProfiles.$inferSelect): ReleaseProfile {
  const { indexerId, ...rest } = row;
  return indexerId === null ? rest : { ...rest, indexerId };
}
