import { eq } from 'drizzle-orm';
import type { NotificationEvent } from '@arclight/notifications';
import {
  AddMovieRequest,
  AddSeriesRequest,
  Permission as P,
  type AdditionalLanguageOutcome,
  type AdditionalLanguageRequest,
  type AdditionalLanguageResult,
  type ItemLanguages,
  type ItemLanguagesQuery,
  type SubtitleLanguageOption,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { additionalLanguages } from '../../db/schema.js';
import { scopeKeyOf } from '../additional-languages/audio.js';
import { libraryService } from '../library/index.js';
import type { LanguagesPort } from './language-requests.js';
import { addUser, buildApp, giveMovieFile, giveSeasonFiles, setup, type Harness } from './test-support.js';

// Test-only helpers for subtitle/language requests: a fake "Add additional…" port that records
// what it was asked and saves additional-language rows the way the real module does, and a
// library with one movie and one series that have files.

export const MOVIE = { tmdbId: 603, title: 'The Matrix', year: 1999 };
export const SHOW = { tmdbId: 1399, tvdbId: 121361, title: 'Thrones', year: 2011, seasons: [0, 2, 2] };

const LANGUAGES: SubtitleLanguageOption[] = [
  { code: 'de', name: 'German' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
];

export class FakeLanguages implements LanguagesPort {
  db!: Db;
  applied: AdditionalLanguageRequest[] = [];
  previewed: AdditionalLanguageRequest[] = [];
  /** Outcome apply reports (and saves on the rows). */
  outcome: AdditionalLanguageOutcome = 'searching';
  /** Outcome preview reports. */
  planned: AdditionalLanguageOutcome = 'willSearch';
  /** apply throws this when set. */
  error: Error | null = null;
  chips: Pick<ItemLanguages, 'audio' | 'subtitles'> = { audio: [], subtitles: [] };

  async preview(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult> {
    this.previewed.push(req);
    return this.result(req, this.planned, false);
  }

  async apply(req: AdditionalLanguageRequest): Promise<AdditionalLanguageResult> {
    this.applied.push(req);
    if (this.error) throw this.error;
    const t = req.targets[0]!;
    const ids = { movieId: t.movieId ?? null, seriesId: t.seriesId ?? null, seasonNumber: t.seasonNumber ?? null, episodeId: null };
    const now = new Date().toISOString();
    const language = req.kind === 'subtitle' ? req.languages[0]!.code : req.language;
    this.db
      .insert(additionalLanguages)
      .values({
        kind: req.kind,
        mediaType: ids.movieId !== null ? 'movie' : 'series',
        ...ids,
        scopeKey: scopeKeyOf(ids),
        language,
        forced: req.kind === 'subtitle' ? req.languages[0]!.forced : 'never',
        hi: req.kind === 'subtitle' ? req.languages[0]!.hi : 'also',
        mode: req.kind === 'audio' ? req.mode : null,
        versionTag: null,
        status: this.outcome,
        message: `fake ${this.outcome}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: [additionalLanguages.kind, additionalLanguages.scopeKey, additionalLanguages.language], set: { status: this.outcome, message: `fake ${this.outcome}` } })
      .run();
    return this.result(req, this.outcome, true);
  }

  itemLanguages(q: ItemLanguagesQuery): ItemLanguages {
    const rows = this.db.select().from(additionalLanguages).all();
    const records = rows
      .filter((r) => (q.movieId !== undefined ? r.movieId === q.movieId : r.seriesId === q.seriesId))
      .map((r) => ({ ...r, mode: r.mode ?? null }));
    return { ...this.chips, records: records.map(({ scopeKey: _key, ...r }) => r) };
  }

  languages(): SubtitleLanguageOption[] {
    return LANGUAGES;
  }

  /** Sets the status of every saved row (a later search finished). */
  finish(status: AdditionalLanguageOutcome): void {
    this.db.update(additionalLanguages).set({ status, message: `fake ${status}` }).run();
  }

  private result(req: AdditionalLanguageRequest, outcome: AdditionalLanguageOutcome, applied: boolean): AdditionalLanguageResult {
    const t = req.targets[0]!;
    return {
      kind: req.kind,
      applied,
      items: [
        {
          key: t.movieId ? `movie:${t.movieId}` : `series:${t.seriesId}`,
          mediaType: t.movieId ? 'movie' : 'series',
          movieId: t.movieId ?? null,
          seriesId: t.seriesId ?? null,
          seasonNumber: t.seasonNumber ?? null,
          episodeIds: [],
          title: 'item',
          outcome,
          message: `fake ${outcome}`,
          files: 1,
          currentAudio: [],
          unanalysedFiles: 0,
          currentSubtitles: [],
          requiredAudio: [],
          versionTag: null,
          subtitles: [],
        },
      ],
      whisperAvailable: false,
      jobId: null,
      message: '',
    };
  }
}

/** The movie (with a file) and the series (season 1 with files, season 2 without) in the library. */
export function seedLanguageLibrary(h: Harness): { movieId: number; seriesId: number } {
  const movie = libraryService.addMovie(h.db, h.tmdb.lookupMovie(MOVIE.tmdbId)!, AddMovieRequest.parse({ tmdbId: MOVIE.tmdbId, rootFolderPath: '/media/movies', qualityProfileId: h.profileId }));
  giveMovieFile(h.db, MOVIE.tmdbId);
  const show = libraryService.addSeries(h.db, h.tmdb.lookupSeries(SHOW.tmdbId)!, AddSeriesRequest.parse({ tmdbId: SHOW.tmdbId, rootFolderPath: '/media/tv', qualityProfileId: h.profileId }));
  giveSeasonFiles(h.db, SHOW.tmdbId, 1);
  return { movieId: movie.id, seriesId: show.id };
}

/** Requests services with the fake port, library, an admin and a plain user. */
export async function languageHarness() {
  const languages = new FakeLanguages();
  const events: NotificationEvent[] = [];
  const h = await setup({
    extra: {
      languages,
      systemDispatch: async (event) => {
        events.push(event);
        return [];
      },
    },
  });
  languages.db = h.db;
  h.tmdb.addMovie(MOVIE).addSeries(SHOW);
  const ids = seedLanguageLibrary(h);
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'viewer', permissions: P.REQUEST_LANGUAGE });
  return { ...h, ...ids, fake: languages, events, admin, user, service: h.services.languages };
}

/** The full HTTP stack with the fake port. */
export async function languageApp() {
  const languages = new FakeLanguages();
  const h = await buildApp({ extra: { languages } });
  languages.db = h.db;
  h.tmdb.addMovie(MOVIE).addSeries(SHOW);
  const ids = seedLanguageLibrary(h);
  const admin = addUser(h.db, { role: 'admin', username: 'boss' });
  const user = addUser(h.db, { username: 'viewer', permissions: P.REQUEST_LANGUAGE });
  const other = addUser(h.db, { username: 'nobody', permissions: P.CREATE_ISSUES });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({ method, url: `/api/v1${url}`, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as object }) });
  return { ...h, ...ids, fake: languages, admin, user, other, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id), otherCookie: h.cookieFor(other.id), call };
}

export function additionalRows(db: Db) {
  return db.select().from(additionalLanguages).orderBy(additionalLanguages.id).all();
}

export function additionalRow(db: Db, id: number) {
  return db.select().from(additionalLanguages).where(eq(additionalLanguages.id, id)).get();
}
