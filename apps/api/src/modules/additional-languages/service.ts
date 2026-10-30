import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  qualityById,
  type AdditionalAudioRequest,
  type AdditionalLanguageItemResult,
  type AdditionalLanguageOutcome,
  type AdditionalLanguageRecord,
  type AdditionalLanguageRequest,
  type AdditionalLanguageResult,
  type AdditionalLanguageTarget,
  type AdditionalSubtitleLanguage,
  type AdditionalSubtitleOutcome,
  type AdditionalSubtitleRequest,
  type Episode,
  type ItemLanguageChip,
  type ItemLanguages,
  type ItemLanguagesQuery,
  type Job,
  type MediaFile,
  type MediaFileSubtitles,
  type MediaVersion,
  type Movie,
  type QualityModel,
  type Series,
  type SubtitleFileQuery,
  type SubtitleProviderId,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { additionalLanguages, history } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import type { JobHandler } from '../../scheduler.js';
import { DEFAULT_VERSION_TAG, findVersion, libraryService, upsertVersion } from '../library/index.js';
import { desiredEntries, languageKey, languageMatches, normalizeTag, satisfies, toRef, type DesiredEntry } from '../subtitles/wanted.js';
import { baseLanguages, displayLanguage, fileAudioLanguages, missingLanguages, normalizeLanguage, scopeApplies, scopeKeyOf } from './audio.js';
import type { AdditionalLanguageRow } from './schema.js';

// "Add additional…": saves additional audio/subtitle languages on items and runs the searches
// that go with them through the scheduler (so they show in Activity), recording the request
// and its outcome in history. The heavy lifting stays in the owning modules: subtitles (wanted
// computation, providers, Whisper), releases (decision engine with the required-audio spec)
// and the library (version slots).

export class AdditionalLanguagesError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'AdditionalLanguagesError';
  }
}

export const ADDITIONAL_LANGUAGE_JOB = 'AdditionalLanguageSearch';
const MAX_VERSIONS = 8;
const DEFAULT_WAIT_MS = 20_000;
const WHISPER: SubtitleProviderId = 'whisperai';

/** What the service needs from the subtitles module. */
export interface SubtitlesPort {
  fileSubtitles(q: SubtitleFileQuery): MediaFileSubtitles[];
  searchFile(
    mediaFileId: number,
    opts: {
      ignoreBackoff?: boolean;
      only?: (entry: DesiredEntry) => boolean;
      providerIds?: readonly SubtitleProviderId[];
      onLanguage?: (key: string, found: boolean) => void;
    },
  ): Promise<{ allThrottled: boolean }>;
  whisperConfigured(): boolean;
}

/** What the service needs from the releases module. */
export interface ReleasesPort {
  searchFor(
    target: { seriesId: number; seasonNumber?: number; episodeIds?: number[] } | { movieId: number },
    opts: { userInvoked?: boolean; signal?: AbortSignal },
  ): Promise<{ releases: number; approved: number; grabbed: string[] }>;
}

export interface TaskRunner {
  runTask(name: string, trigger: 'manual', handler: JobHandler, opts?: { key?: string }): { job: Job; done: Promise<Job> };
}

export interface AdditionalLanguagesOptions {
  db: Db;
  bus: EventBus;
  log: Logger;
  scheduler: TaskRunner;
  subtitles: () => SubtitlesPort;
  releases: () => ReleasesPort;
  now?: () => Date;
  /** How long POST waits for the search task before answering with `searching`. */
  waitMs?: number;
}

/** One target resolved against the library. */
interface Resolved {
  key: string;
  mediaType: 'series' | 'movie';
  movie: Movie | null;
  series: Series | null;
  seasonNumber: number | null;
  /** Episodes the target covers (series), empty for movies. */
  episodes: Episode[];
  /** Explicit episode ids of the target ([] for whole series/season). */
  episodeIds: number[];
  title: string;
  files: MediaFile[];
  /** Record scopes to save: whole item, one season, or one row per episode. */
  scopes: Array<{ seasonNumber: number | null; episodeId: number | null }>;
}

interface ItemState {
  item: AdditionalLanguageItemResult;
  resolved: Resolved;
}

const pad = (n: number) => String(n).padStart(2, '0');

function unknownQuality(): QualityModel {
  const q = qualityById(0);
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

/** Version tags may not contain path characters; language names never do, but be safe. */
function safeTag(name: string): string {
  return name.replace(/[\\/<>:?*|"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Additional';
}

function flagEntries(lang: AdditionalSubtitleLanguage, tag: string): DesiredEntry[] {
  return desiredEntries({ languages: [{ code: tag, forced: lang.forced, hi: lang.hi }] });
}

function sameEntry(a: DesiredEntry, b: DesiredEntry): boolean {
  return languageMatches(a.tag, b.tag) && a.forced === b.forced;
}

/** Item outcome from per-language outcomes. */
function rollUp(outcomes: readonly AdditionalLanguageOutcome[]): AdditionalLanguageOutcome {
  if (outcomes.length === 0) return 'alreadyPresent';
  const order: AdditionalLanguageOutcome[] = ['failed', 'searching', 'notFound', 'willSearch', 'saved', 'found', 'alreadyPresent'];
  for (const o of order) if (outcomes.includes(o)) return o;
  return outcomes[0]!;
}

export class AdditionalLanguagesService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly opts: AdditionalLanguagesOptions;
  private readonly now: () => Date;

  constructor(opts: AdditionalLanguagesOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ---- reading ----------------------------------------------------------------------------------

  private toRecord(row: AdditionalLanguageRow): AdditionalLanguageRecord {
    return {
      id: row.id,
      kind: row.kind,
      mediaType: row.mediaType,
      movieId: row.movieId,
      seriesId: row.seriesId,
      seasonNumber: row.seasonNumber,
      episodeId: row.episodeId,
      language: row.language,
      forced: row.forced,
      hi: row.hi,
      mode: row.mode,
      versionTag: row.versionTag,
      status: row.status,
      message: row.message,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowsOfItem(r: Pick<Resolved, 'movie' | 'series'>): AdditionalLanguageRow[] {
    if (r.movie) return this.db.select().from(additionalLanguages).where(eq(additionalLanguages.movieId, r.movie.id)).all();
    if (r.series) return this.db.select().from(additionalLanguages).where(eq(additionalLanguages.seriesId, r.series.id)).all();
    return [];
  }

  /** Records that apply to (part of) a resolved target. */
  private recordsFor(r: Resolved): AdditionalLanguageRow[] {
    const covered = r.movie
      ? { movieId: r.movie.id }
      : { seriesId: r.series!.id, episodes: r.seasonNumber === null && r.episodeIds.length === 0 ? [] : r.episodes.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber })) };
    return this.rowsOfItem(r).filter((row) => scopeApplies(row, covered));
  }

  /** GET /additional-language: language chips and saved records of one item. */
  itemLanguages(q: ItemLanguagesQuery): ItemLanguages {
    const target: AdditionalLanguageTarget =
      q.movieId !== undefined
        ? { movieId: q.movieId }
        : { seriesId: q.seriesId!, ...(q.seasonNumber !== undefined ? { seasonNumber: q.seasonNumber } : {}), ...(q.episodeId !== undefined ? { episodeIds: [q.episodeId] } : {}) };
    const r = this.resolve(target);
    const records = this.recordsFor(r);

    const audioPresent = new Set<string>();
    for (const f of r.files) for (const l of fileAudioLanguages(f) ?? []) audioPresent.add(l);
    const audio: ItemLanguageChip[] = [...audioPresent].map((language) => ({ language, present: true, added: false }));
    for (const row of records) {
      if (row.kind !== 'audio') continue;
      const base = baseLanguages([row.language])[0] ?? row.language;
      const chip = audio.find((c) => c.language === base);
      if (chip) chip.added = true;
      else audio.push({ language: base, present: false, added: true });
    }

    const states = this.subtitleStates(r).flatMap((f) => f.subtitles);
    const subtitles: ItemLanguageChip[] = [];
    for (const s of states) {
      const key = languageKey({ language: normalizeTag(s.language), forced: s.forced, hi: s.hi });
      if (!subtitles.some((c) => c.language === key)) subtitles.push({ language: key, present: true, added: false });
    }
    for (const row of records) {
      if (row.kind !== 'subtitle') continue;
      for (const entry of desiredEntries({ languages: [{ code: row.language, forced: row.forced, hi: row.hi }] })) {
        const hit = states.find((s) => satisfies(entry, s));
        const key = hit ? languageKey({ language: normalizeTag(hit.language), forced: hit.forced, hi: hit.hi }) : languageKey(toRef(entry));
        const chip = subtitles.find((c) => c.language === key);
        if (chip) chip.added = true;
        else subtitles.push({ language: key, present: false, added: true });
      }
    }
    const byName = (a: ItemLanguageChip, b: ItemLanguageChip) => a.language.localeCompare(b.language);
    return { audio: audio.sort(byName), subtitles: subtitles.sort(byName), records: records.map((row) => this.toRecord(row)) };
  }

  private subtitleStates(r: Resolved): MediaFileSubtitles[] {
    if (r.files.length === 0) return [];
    const all = this.opts.subtitles().fileSubtitles(r.movie ? { movieId: r.movie.id } : { seriesId: r.series!.id });
    const ids = new Set(r.files.map((f) => f.id));
    return all.filter((f) => ids.has(f.mediaFileId));
  }

  // ---- resolving targets ------------------------------------------------------------------------

  private resolve(t: AdditionalLanguageTarget): Resolved {
    if (t.movieId !== undefined) {
      const movie = libraryService.getMovie(this.db, t.movieId);
      return {
        key: `movie:${movie.id}`,
        mediaType: 'movie',
        movie,
        series: null,
        seasonNumber: null,
        episodes: [],
        episodeIds: [],
        title: movie.title,
        files: libraryService.listMediaFiles(this.db, { movieId: movie.id }),
        scopes: [{ seasonNumber: null, episodeId: null }],
      };
    }
    const series = libraryService.getSeries(this.db, t.seriesId!, { includeStatistics: false });
    const all = libraryService.listEpisodes(this.db, { seriesId: series.id });
    const ids = t.episodeIds?.length ? [...new Set(t.episodeIds)] : [];
    let episodes: Episode[];
    let title: string;
    let key: string;
    let scopes: Resolved['scopes'];
    if (ids.length > 0) {
      episodes = all.filter((e) => ids.includes(e.id));
      if (episodes.length !== ids.length) throw new AdditionalLanguagesError('NOT_FOUND', `some episodes do not belong to series ${series.id}`);
      episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
      const first = episodes[0]!;
      title = episodes.length === 1 ? `${series.title} - S${pad(first.seasonNumber)}E${pad(first.episodeNumber)}` : `${series.title} - ${episodes.length} episodes`;
      key = `series:${series.id}:e${episodes.map((e) => e.id).join(',')}`;
      scopes = episodes.map((e) => ({ seasonNumber: null, episodeId: e.id }));
    } else if (t.seasonNumber !== undefined) {
      episodes = all.filter((e) => e.seasonNumber === t.seasonNumber);
      title = t.seasonNumber === 0 ? `${series.title} - Specials` : `${series.title} - Season ${t.seasonNumber}`;
      key = `series:${series.id}:s${t.seasonNumber}`;
      scopes = [{ seasonNumber: t.seasonNumber, episodeId: null }];
    } else {
      episodes = all;
      title = series.title;
      key = `series:${series.id}`;
      scopes = [{ seasonNumber: null, episodeId: null }];
    }
    const epIds = new Set(episodes.map((e) => e.id));
    const files = libraryService
      .listMediaFiles(this.db, { seriesId: series.id })
      .filter((f) => (ids.length === 0 && t.seasonNumber === undefined ? true : f.episodeIds.some((id) => epIds.has(id))));
    return {
      key,
      mediaType: 'series',
      movie: null,
      series,
      seasonNumber: ids.length === 0 ? (t.seasonNumber ?? null) : null,
      episodes,
      episodeIds: ids.length > 0 ? episodes.map((e) => e.id) : [],
      title,
      files,
      scopes,
    };
  }

  private baseResult(r: Resolved): AdditionalLanguageItemResult {
    const audio = new Set<string>();
    let unanalysed = 0;
    for (const f of r.files) {
      const langs = fileAudioLanguages(f);
      if (langs === null) unanalysed++;
      else for (const l of langs) audio.add(l);
    }
    const subs = new Set<string>();
    for (const f of this.subtitleStates(r)) {
      for (const s of f.subtitles) subs.add(languageKey({ language: normalizeTag(s.language), forced: s.forced, hi: s.hi }));
    }
    return {
      key: r.key,
      mediaType: r.mediaType,
      movieId: r.movie?.id ?? null,
      seriesId: r.series?.id ?? null,
      seasonNumber: r.seasonNumber,
      episodeIds: r.episodeIds,
      title: r.title,
      outcome: 'saved',
      message: '',
      files: r.files.length,
      currentAudio: [...audio].sort(),
      unanalysedFiles: unanalysed,
      currentSubtitles: [...subs].sort(),
      requiredAudio: [],
      versionTag: null,
      subtitles: [],
    };
  }

  // ---- preview / apply --------------------------------------------------------------------------

  async preview(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult> {
    return this.run(req, false);
  }

  async apply(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult> {
    return this.run(req, true);
  }

  private async run(req: AdditionalLanguageRequest, apply: boolean): Promise<AdditionalLanguageResult> {
    const resolved = this.resolveAll(req.targets);
    const whisperAvailable = this.opts.subtitles().whisperConfigured();
    if (req.kind === 'subtitle') return this.runSubtitles(req, resolved, apply, whisperAvailable);
    return this.runAudio(req, resolved, apply, whisperAvailable);
  }

  private resolveAll(targets: readonly AdditionalLanguageTarget[]): Resolved[] {
    const out: Resolved[] = [];
    for (const t of targets) {
      const r = this.resolve(t);
      if (!out.some((x) => x.key === r.key)) out.push(r);
    }
    return out;
  }

  // ---- subtitles ----------------------------------------------------------------------------------

  private subtitleLanguages(req: AdditionalSubtitleRequest): Array<AdditionalSubtitleLanguage & { tag: string }> {
    const out: Array<AdditionalSubtitleLanguage & { tag: string }> = [];
    for (const l of req.languages) {
      const tag = normalizeLanguage(l.code);
      if (!tag) throw new AdditionalLanguagesError('VALIDATION', `unknown language: ${l.code}`);
      if (!out.some((x) => x.tag === tag && x.forced === l.forced && x.hi === l.hi)) out.push({ ...l, tag });
    }
    return out;
  }

  private async runSubtitles(req: AdditionalSubtitleRequest, resolved: Resolved[], apply: boolean, whisperAvailable: boolean): Promise<AdditionalLanguageResult> {
    const langs = this.subtitleLanguages(req);
    const requested = langs.flatMap((l) => flagEntries(l, l.tag));
    const wanted = (e: DesiredEntry) => requested.some((r) => sameEntry(r, e));
    const states: ItemState[] = [];
    const work: Array<{ state: ItemState; fileIds: number[] }> = [];

    for (const r of resolved) {
      const item = this.baseResult(r);
      const fileStates = this.subtitleStates(r);
      // Per requested entry: which files still lack it (embedded tracks count, as in the default embedded mode).
      const fileLacks = (f: MediaFileSubtitles, entry: DesiredEntry) => !f.subtitles.some((s) => satisfies(entry, s));
      const lacking = (entry: DesiredEntry) => fileStates.some((f) => fileLacks(f, entry));
      const filesNeeding = fileStates.filter((f) => requested.some((entry) => fileLacks(f, entry)));
      item.subtitles = requested.map((entry) => {
        const ref = toRef(entry);
        let outcome: AdditionalLanguageOutcome;
        if (r.files.length === 0) outcome = 'noFile';
        else if (!lacking(entry)) outcome = 'alreadyPresent';
        else outcome = req.searchNow ? (apply ? 'searching' : 'willSearch') : 'saved';
        return { ...ref, outcome } satisfies AdditionalSubtitleOutcome;
      });
      item.outcome = r.files.length === 0 ? 'noFile' : rollUp(item.subtitles.map((s) => s.outcome));
      item.message = this.subtitleMessage(item, langs.map((l) => l.tag), apply, req.useWhisper && whisperAvailable);
      const state = { item, resolved: r };
      states.push(state);
      if (req.searchNow && filesNeeding.length > 0) work.push({ state, fileIds: filesNeeding.map((f) => f.mediaFileId) });
    }

    if (!apply) return this.result('subtitle', false, states, whisperAvailable, null, this.summary(states, false));

    for (const { item, resolved: r } of states) {
      for (const l of langs) {
        for (const scope of r.scopes) this.upsertRow(r, scope, { kind: 'subtitle', language: l.tag, forced: l.forced, hi: l.hi, mode: null, versionTag: null }, item.outcome, item.message);
      }
      this.writeHistory(r, 'subtitle', langs.map((l) => l.tag).join(','), 'requested', item.message, { useWhisper: req.useWhisper, searchNow: req.searchNow });
      this.publishUpdated(r);
    }

    let jobId: number | null = null;
    if (work.length > 0) {
      const useWhisper = req.useWhisper && whisperAvailable;
      const handler: JobHandler = async ({ signal }) => {
        let found = 0;
        let missing = 0;
        for (const { state, fileIds } of work) {
          if (signal.aborted) break;
          const foundKeys = new Set<string>();
          const notFoundKeys = new Set<string>();
          for (const id of fileIds) {
            const found: string[] = [];
            const missing: string[] = [];
            const track = (into: { found: string[]; missing: string[] }) => (key: string, ok: boolean) => (ok ? into.found : into.missing).push(key);
            await this.opts.subtitles().searchFile(id, { ignoreBackoff: true, only: wanted, onLanguage: track({ found, missing }) });
            for (const k of found) foundKeys.add(k);
            const stillMissing = missing.filter((k) => !found.includes(k));
            if (useWhisper && stillMissing.length > 0) {
              const again = { found: [] as string[], missing: [] as string[] };
              await this.opts.subtitles().searchFile(id, {
                ignoreBackoff: true,
                only: (e) => wanted(e) && stillMissing.includes(languageKey(toRef(e))),
                providerIds: [WHISPER],
                onLanguage: track(again),
              });
              for (const k of again.found) foundKeys.add(k);
              for (const k of stillMissing) if (!again.found.includes(k)) notFoundKeys.add(k);
            } else {
              for (const k of stillMissing) notFoundKeys.add(k);
            }
          }
          this.finishSubtitleItem(state, foundKeys, notFoundKeys);
          if (state.item.outcome === 'found') found++;
          else if (state.item.outcome === 'notFound') missing++;
        }
        return `Additional subtitles: ${found} item(s) found, ${missing} not found yet (searched again on the normal schedule)`;
      };
      jobId = await this.runAndWait(handler, states);
    }
    return this.result('subtitle', true, states, whisperAvailable, jobId, this.summary(states, true));
  }

  private finishSubtitleItem(state: ItemState, found: ReadonlySet<string>, notFound: ReadonlySet<string>): void {
    const item = state.item;
    item.subtitles = item.subtitles.map((s) => {
      if (s.outcome !== 'searching') return s;
      const key = languageKey(s);
      // A language searched in several files counts as found only when no file came up empty.
      // No answer at all (no provider took it) is not found: the file lacked it before the search.
      const outcome: AdditionalLanguageOutcome = notFound.has(key) ? 'notFound' : found.has(key) ? 'found' : 'notFound';
      return { ...s, outcome };
    });
    item.outcome = rollUp(item.subtitles.map((s) => s.outcome));
    item.message =
      item.outcome === 'found'
        ? 'Subtitles found for every new language.'
        : item.outcome === 'notFound'
          ? `Not found yet: ${item.subtitles.filter((s) => s.outcome === 'notFound').map((s) => displayLanguage(s.language)).join(', ')}. Searched again on the normal schedule.`
          : item.message;
    this.updateRows(state.resolved, 'subtitle', item.outcome, item.message);
    this.writeHistory(state.resolved, 'subtitle', item.subtitles.map((s) => languageKey(s)).join(','), item.outcome, item.message, {});
    this.publishUpdated(state.resolved);
  }

  private subtitleMessage(item: AdditionalLanguageItemResult, tags: readonly string[], applied: boolean, whisper: boolean): string {
    const names = tags.map(displayLanguage).join(', ');
    switch (item.outcome) {
      case 'noFile':
        return `No file yet; ${names} subtitles will be searched once one is imported.`;
      case 'alreadyPresent':
        return `Already has ${names} subtitles; kept as wanted for future files.`;
      case 'willSearch':
        return `Will search providers for ${names}${whisper ? ', then generate with Whisper if none has them' : ''}. Existing subtitles stay.`;
      case 'searching':
        return `Searching providers for ${names}${whisper ? ' (Whisper as a fallback)' : ''}.`;
      case 'saved':
        return `${names} added; searched on the normal schedule.`;
      default:
        return applied ? `${names} added.` : `${names} will be added.`;
    }
  }

  // ---- audio ----------------------------------------------------------------------------------------

  private async runAudio(req: AdditionalAudioRequest, resolved: Resolved[], apply: boolean, whisperAvailable: boolean): Promise<AdditionalLanguageResult> {
    const tag = normalizeLanguage(req.language);
    if (!tag) throw new AdditionalLanguagesError('VALIDATION', `unknown language: ${req.language}`);
    const lang = baseLanguages([tag])[0]!;
    const name = displayLanguage(tag);
    const states: ItemState[] = [];
    const searches: Array<{ state: ItemState; target: { seriesId: number; seasonNumber?: number; episodeIds?: number[] } | { movieId: number } }> = [];

    for (const r of resolved) {
      const item = this.baseResult(r);
      const lackingFiles = r.files.filter((f) => {
        const have = fileAudioLanguages(f);
        return have === null || missingLanguages([lang], have).length > 0;
      });
      const hasIt = r.files.length > 0 && lackingFiles.length === 0;

      if (req.mode === 'replace') {
        const required = new Set<string>([lang]);
        for (const f of lackingFiles) for (const l of fileAudioLanguages(f) ?? []) required.add(l);
        item.requiredAudio = [...required];
        if (r.files.length === 0) {
          item.outcome = 'noFile';
          item.message = `No file yet; the first release grabbed must have ${name} audio.`;
        } else if (hasIt) {
          item.outcome = 'alreadyPresent';
          item.message = `Already has ${name} audio; future upgrades keep it.`;
        } else {
          item.outcome = req.searchNow ? (apply ? 'searching' : 'willSearch') : 'saved';
          item.message = req.searchNow
            ? `Will look for a release with ${item.requiredAudio.map(displayLanguage).join(' + ')} audio at the current quality or better; the current file is replaced only after the new one imports.`
            : `${name} audio is now required; cutoff-unmet searches look for a release that has it.`;
          if (req.searchNow) searches.push({ state: { item, resolved: r }, target: this.searchTarget(r, lackingFiles) });
        }
      } else {
        const parent = r.movie ?? r.series!;
        const versionTag = this.versionTagFor(parent, req, tag);
        item.versionTag = versionTag;
        if (hasIt) {
          item.outcome = 'alreadyPresent';
          item.message = `Already has ${name} audio; no separate version needed.`;
        } else {
          const existing = findVersion(parent.versions, versionTag);
          if (!existing && (parent.versions?.length ?? 0) + ((parent.versions?.length ?? 0) === 0 ? 2 : 1) > MAX_VERSIONS) {
            item.outcome = 'failed';
            item.message = `Cannot add a version: the item already has ${MAX_VERSIONS} versions.`;
          } else {
            item.outcome = apply ? 'versionAdded' : 'willAddVersion';
            item.message =
              (parent.versions?.length ?? 0) === 0
                ? `Adds a "${versionTag}" version next to the current file (kept as "${DEFAULT_VERSION_TAG}") that needs ${name} audio${req.searchNow ? ', then searches for it' : ''}.`
                : `Adds a "${versionTag}" version that needs ${name} audio${req.searchNow ? ', then searches for it' : ''}.`;
            if (r.series && (r.seasonNumber !== null || r.episodeIds.length > 0)) {
              item.message += ' Versions apply to the whole series.';
            }
            if (req.searchNow) searches.push({ state: { item, resolved: r }, target: this.searchTarget(r, []) });
          }
        }
      }
      const existing = searches.find((s) => s.state.item === item);
      states.push(existing ? existing.state : { item, resolved: r });
    }

    if (!apply) return this.result('audio', false, states, whisperAvailable, null, this.summary(states, false));

    for (const { item, resolved: r } of states) {
      if (item.outcome === 'failed') continue;
      if (req.mode === 'version' && item.outcome === 'versionAdded') this.addVersion(r, item.versionTag!, req, tag);
      for (const scope of r.scopes) {
        this.upsertRow(r, scope, { kind: 'audio', language: lang, forced: 'never', hi: 'also', mode: req.mode, versionTag: item.versionTag }, item.outcome, item.message);
      }
      this.writeHistory(r, 'audio', lang, 'requested', item.message, { mode: req.mode, ...(item.versionTag ? { versionTag: item.versionTag } : {}) });
      this.publishUpdated(r);
    }

    let jobId: number | null = null;
    if (searches.length > 0) {
      const handler: JobHandler = async ({ signal }) => {
        let grabbed = 0;
        for (const { state, target } of searches) {
          if (signal.aborted) break;
          try {
            const summary = await this.opts.releases().searchFor(target, { userInvoked: true, signal });
            this.finishAudioItem(state, summary.grabbed, name, req.mode);
            if (summary.grabbed.length > 0) grabbed++;
          } catch (err) {
            this.log.warn({ err, item: state.item.key }, 'additional audio search failed');
            state.item.outcome = 'failed';
            state.item.message = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
            this.updateRows(state.resolved, 'audio', state.item.outcome, state.item.message);
          }
        }
        return `Additional ${name} audio: grabbed for ${grabbed} of ${searches.length} item(s)`;
      };
      jobId = await this.runAndWait(handler, states);
    }
    return this.result('audio', true, states, whisperAvailable, jobId, this.summary(states, true));
  }

  private finishAudioItem(state: ItemState, grabbed: readonly string[], name: string, mode: AdditionalAudioRequest['mode']): void {
    const item = state.item;
    if (grabbed.length > 0) {
      item.outcome = 'grabbed';
      item.message =
        mode === 'replace'
          ? `Grabbed ${grabbed[0]}; it replaces the current file once it imports.`
          : `Grabbed ${grabbed[0]} for the "${item.versionTag}" version.`;
    } else {
      item.outcome = mode === 'version' ? 'versionAdded' : 'notFound';
      item.message =
        mode === 'version'
          ? `"${item.versionTag}" version added; no release with ${name} audio yet. Searched again on the normal schedule.`
          : `No release with ${item.requiredAudio.map(displayLanguage).join(' + ')} audio yet. Searched again on the normal schedule.`;
    }
    this.updateRows(state.resolved, 'audio', item.outcome, item.message);
    this.writeHistory(state.resolved, 'audio', item.requiredAudio.join(',') || (item.versionTag ?? ''), item.outcome, item.message, { mode, ...(grabbed[0] ? { release: grabbed[0] } : {}) });
    this.publishUpdated(state.resolved);
  }

  /** Search the lacking part of the item: the whole movie/series/season, or the episodes whose files lack it. */
  private searchTarget(r: Resolved, lacking: readonly MediaFile[]): { seriesId: number; seasonNumber?: number; episodeIds?: number[] } | { movieId: number } {
    if (r.movie) return { movieId: r.movie.id };
    const seriesId = r.series!.id;
    const scopeIds = r.episodeIds.length > 0 ? r.episodeIds : r.episodes.map((e) => e.id);
    const lackingIds = lacking.length > 0 ? [...new Set(lacking.flatMap((f) => f.episodeIds))].filter((id) => scopeIds.includes(id)) : [];
    const everything = lacking.length === 0 || lackingIds.length >= scopeIds.length;
    if (r.episodeIds.length > 0) return { seriesId, episodeIds: lackingIds.length > 0 ? lackingIds : r.episodeIds };
    if (everything) return r.seasonNumber !== null ? { seriesId, seasonNumber: r.seasonNumber } : { seriesId };
    return { seriesId, episodeIds: lackingIds };
  }

  private versionTagFor(parent: Movie | Series, req: AdditionalAudioRequest, tag: string): string {
    if (req.versionTag) return req.versionTag;
    // Reuse a slot that already asks for this language.
    const base = baseLanguages([tag])[0];
    const slot = (parent.versions ?? []).find((v) => baseLanguages(v.audioLanguages ?? []).includes(base ?? ''));
    return slot ? slot.tag : safeTag(displayLanguage(tag));
  }

  private addVersion(r: Resolved, versionTag: string, req: AdditionalAudioRequest, tag: string): void {
    const parent = r.movie ?? r.series!;
    const slot: MediaVersion = {
      tag: versionTag,
      qualityProfileId: req.qualityProfileId ?? findVersion(parent.versions, versionTag)?.qualityProfileId ?? parent.qualityProfileId,
      enabled: true,
      audioLanguages: [baseLanguages([tag])[0] ?? tag],
    };
    const versions = upsertVersion(parent, slot, DEFAULT_VERSION_TAG);
    if (r.movie) {
      r.movie = libraryService.updateMovie(this.db, r.movie.id, { versions });
      this.bus.publish({ type: 'library', action: 'updated', mediaType: 'movie', id: r.movie.id });
    } else {
      r.series = libraryService.updateSeries(this.db, r.series!.id, { versions });
      this.bus.publish({ type: 'library', action: 'updated', mediaType: 'series', id: r.series.id });
    }
  }

  // ---- task -----------------------------------------------------------------------------------------

  /** Run the searches as an Activity task; wait a little so quick searches answer inline. */
  private async runAndWait(handler: JobHandler, states: readonly ItemState[]): Promise<number> {
    const { job, done } = this.opts.scheduler.runTask(ADDITIONAL_LANGUAGE_JOB, 'manual', handler, { key: `${ADDITIONAL_LANGUAGE_JOB}:${jobKey(states)}` });
    const waitMs = this.opts.waitMs ?? DEFAULT_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done.catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    if (timer) clearTimeout(timer);
    return job.id;
  }

  // ---- persistence ----------------------------------------------------------------------------------

  private upsertRow(
    r: Resolved,
    scope: { seasonNumber: number | null; episodeId: number | null },
    v: { kind: 'audio' | 'subtitle'; language: string; forced: AdditionalSubtitleLanguage['forced']; hi: AdditionalSubtitleLanguage['hi']; mode: AdditionalAudioRequest['mode'] | null; versionTag: string | null },
    status: AdditionalLanguageOutcome,
    message: string,
  ): void {
    const now = this.iso();
    const ids = { movieId: r.movie?.id ?? null, seriesId: r.series?.id ?? null, seasonNumber: scope.seasonNumber, episodeId: scope.episodeId };
    const scopeKey = scopeKeyOf(ids);
    const existing = this.db
      .select()
      .from(additionalLanguages)
      .where(and(eq(additionalLanguages.kind, v.kind), eq(additionalLanguages.scopeKey, scopeKey), eq(additionalLanguages.language, v.language)))
      .get();
    if (existing) {
      this.db
        .update(additionalLanguages)
        .set({ forced: v.forced, hi: v.hi, mode: v.mode, versionTag: v.versionTag, status, message, updatedAt: now })
        .where(eq(additionalLanguages.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(additionalLanguages)
      .values({ kind: v.kind, mediaType: r.mediaType, ...ids, scopeKey, language: v.language, forced: v.forced, hi: v.hi, mode: v.mode, versionTag: v.versionTag, status, message, createdAt: now, updatedAt: now })
      .run();
  }

  /** Update the status of the records this request saved for an item. */
  private updateRows(r: Resolved, kind: 'audio' | 'subtitle', status: AdditionalLanguageOutcome, message: string): void {
    const keys = new Set(r.scopes.map((s) => scopeKeyOf({ movieId: r.movie?.id ?? null, seriesId: r.series?.id ?? null, ...s })));
    const now = this.iso();
    for (const row of this.rowsOfItem(r)) {
      if (row.kind !== kind || !keys.has(row.scopeKey)) continue;
      this.db.update(additionalLanguages).set({ status, message, updatedAt: now }).where(eq(additionalLanguages.id, row.id)).run();
    }
  }

  private writeHistory(r: Resolved, kind: 'audio' | 'subtitle', language: string, outcome: string, message: string, extra: Record<string, string | boolean>): void {
    const file = r.files[0];
    const data: Record<string, string> = { kind, language, outcome, message };
    for (const [k, v] of Object.entries(extra)) data[k] = String(v);
    const label = kind === 'audio' ? 'audio' : 'subtitles';
    const names = language
      .split(',')
      .filter(Boolean)
      .map((l) => displayLanguage(l.split(':')[0]!))
      .filter((n, i, a) => a.indexOf(n) === i)
      .join(', ');
    const base = {
      eventType: 'additionalLanguage' as const,
      sourceTitle: outcome === 'requested' ? `Additional ${label} requested: ${names}` : `Additional ${label} (${names}): ${outcome}`,
      quality: file?.quality ?? unknownQuality(),
      languages: language.split(',').filter(Boolean),
      date: this.iso(),
      downloadId: null,
      data,
    };
    try {
      if (r.movie) {
        this.db.insert(history).values({ ...base, mediaType: 'movie', seriesId: null, episodeId: null, movieId: r.movie.id }).run();
      } else {
        const episodeId = r.episodeIds.length === 1 ? r.episodeIds[0]! : null;
        this.db.insert(history).values({ ...base, mediaType: 'series', seriesId: r.series!.id, episodeId, movieId: null }).run();
      }
      this.bus.publish({ type: 'history', action: 'added' });
    } catch (err) {
      this.log.warn({ err }, 'could not record additional-language history');
    }
  }

  private publishUpdated(r: Resolved): void {
    if (r.movie) this.bus.publish({ type: 'library', action: 'updated', mediaType: 'movie', id: r.movie.id });
    else if (r.series) this.bus.publish({ type: 'library', action: 'updated', mediaType: 'series', id: r.series.id });
  }

  remove(id: number): void {
    const row = this.db.select().from(additionalLanguages).where(eq(additionalLanguages.id, id)).get();
    if (!row) throw new AdditionalLanguagesError('NOT_FOUND', `additional language ${id} not found`);
    this.db.delete(additionalLanguages).where(eq(additionalLanguages.id, id)).run();
    const mediaId = row.movieId ?? row.seriesId;
    if (mediaId !== null) this.bus.publish({ type: 'library', action: 'updated', mediaType: row.mediaType, id: mediaId });
  }

  /** Library deletes take their records with them. */
  pruneItem(mediaType: 'series' | 'movie', id: number): void {
    const col = mediaType === 'movie' ? additionalLanguages.movieId : additionalLanguages.seriesId;
    this.db.delete(additionalLanguages).where(and(eq(additionalLanguages.mediaType, mediaType), eq(col, id))).run();
  }

  // ---- result -----------------------------------------------------------------------------------------

  private summary(states: readonly ItemState[], applied: boolean): string {
    const count = (o: AdditionalLanguageOutcome) => states.filter((s) => s.item.outcome === o).length;
    const parts: string[] = [];
    const add = (o: AdditionalLanguageOutcome, label: string) => {
      const n = count(o);
      if (n > 0) parts.push(`${n} ${label}`);
    };
    if (applied) {
      add('found', 'found');
      add('grabbed', 'grabbed');
      add('versionAdded', 'version added');
      add('searching', 'still searching');
      add('notFound', 'not found yet');
    } else {
      add('willSearch', 'to search');
      add('willAddVersion', 'to get a version');
    }
    add('saved', 'saved');
    add('alreadyPresent', 'already have it');
    add('noFile', 'without a file yet');
    add('failed', 'failed');
    return parts.length ? `${states.length} item(s): ${parts.join(', ')}` : `${states.length} item(s)`;
  }

  private result(kind: 'audio' | 'subtitle', applied: boolean, states: readonly ItemState[], whisperAvailable: boolean, jobId: number | null, message: string): AdditionalLanguageResult {
    // Snapshot: a task still running keeps mutating its own copies.
    return { kind, applied, items: states.map((s) => structuredClone(s.item)), whisperAvailable, jobId, message };
  }
}

function jobKey(states: readonly ItemState[]): string {
  return states
    .map((s) => s.item.key)
    .join('|')
    .slice(0, 200);
}
