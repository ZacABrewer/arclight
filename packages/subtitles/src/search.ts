import { ArchiveError, extractSubtitle, type PickHints } from './archive.js';
import { decodeSubtitle } from './encoding.js';
import { convertToSrt, detectFormat, isValidSrt, looksHearingImpaired, normalizeLineEndings } from './formats.js';
import {
  DEFAULT_MIN_SCORE_PERCENT,
  minimumScore,
  passesReleaseFilters,
  scoreCandidate,
  scorePercent,
  selectCandidates,
  sortCandidates,
  type ScoredCandidate,
} from './scoring.js';
import { ThrottleTracker, type ThrottleEntry, type ThrottleOptions } from './throttle.js';
import {
  ProviderError,
  type MediaType,
  type ProviderKind,
  type SubtitleCandidate,
  type SubtitleFile,
  type SubtitleFormat,
  type SubtitleProvider,
  type SubtitleQuery,
  type WantedLanguage,
} from './types.js';

// The provider pool (spec sections 5, 6, 13): concurrent search with per-provider throttle,
// merging, scoring, selection, download with retries, unpacking and normalisation.

export class SubtitleContentError extends Error {
  readonly code = 'invalid-subtitle';
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleContentError';
  }
}

export interface PrepareOptions {
  hints?: PickHints | undefined;
  language?: string | undefined;
  declaredEncoding?: string | undefined;
  /** Convert ASS/VTT/MicroDVD to SubRip (original_format off). Default true. */
  convertToSrt?: boolean | undefined;
  /** Re-encode as UTF-8 with LF line endings. Default true. */
  utf8?: boolean | undefined;
  /** Frame rate for MicroDVD conversion. */
  fps?: number | undefined;
}

export interface PreparedSubtitle {
  file: SubtitleFile;
  text: string;
  /** Result of the HI content heuristic (R9.5 step 2). */
  looksHi: boolean;
  sourceEncoding: string;
}

/**
 * Downloaded payload -> validated subtitle: unpack archives, detect encoding, validate or
 * convert the format, and normalise to UTF-8 + LF (R6.6, R6.7).
 */
export function prepareSubtitle(raw: SubtitleFile, opts: PrepareOptions = {}): PreparedSubtitle {
  if (raw.bytes.byteLength === 0) throw new SubtitleContentError('empty subtitle content');
  const extracted = extractSubtitle(raw, opts.hints);
  const declared = opts.declaredEncoding ?? (raw.encoding !== 'unknown' ? raw.encoding : undefined);
  const decoded = decodeSubtitle(extracted.bytes, { declared, language: opts.language });
  let text = normalizeLineEndings(decoded.text);
  if (/^\s*<(?:!doctype|html)/i.test(text)) throw new SubtitleContentError('received an HTML page instead of a subtitle');
  let format: SubtitleFormat = detectFormat(text, extracted.fileName);
  if (format === 'unknown') throw new SubtitleContentError('unrecognised subtitle format');
  if (format === 'srt' && !isValidSrt(text)) {
    const converted = convertToSrt(text, 'srt');
    if (!converted) throw new SubtitleContentError('invalid SubRip content');
    text = converted;
  }
  if ((opts.convertToSrt ?? true) && format !== 'srt') {
    const converted = convertToSrt(text, format, opts.fps);
    if (!converted) throw new SubtitleContentError(`could not convert ${format} to srt`);
    text = converted;
    format = 'srt';
  }
  const utf8 = opts.utf8 ?? true;
  const keepOriginalBytes = !utf8 && text === normalizeLineEndings(decoded.text);
  const file: SubtitleFile = {
    bytes: keepOriginalBytes ? extracted.bytes : new TextEncoder().encode(text),
    format,
    encoding: keepOriginalBytes ? decoded.encoding : 'utf-8',
    ...(extracted.fileName ? { fileName: extracted.fileName } : {}),
  };
  return { file, text, looksHi: looksHearingImpaired(text, opts.language), sourceEncoding: decoded.encoding };
}

export interface SearcherOptions {
  /** Enabled providers in priority order (R5.3). */
  providers: readonly SubtitleProvider[];
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Minimum score percent per media type (defaults 90 / 70). */
  minScorePercent?: Partial<Record<MediaType, number>> | undefined;
  /** Query providers in parallel (multithreading, default true). */
  concurrent?: boolean | undefined;
  isBlacklisted?: ((provider: ProviderKind, id: string) => boolean) | undefined;
  /** Called when a provider says a subtitle must be blacklisted (R13.6). */
  onBlacklist?: ((candidate: SubtitleCandidate, reason: string) => void) | undefined;
  onThrottle?: ((entry: ThrottleEntry) => void) | undefined;
  mustContain?: readonly string[] | undefined;
  mustNotContain?: readonly string[] | undefined;
  /** Download tries and spacing (R6.5: 3 tries, 6 s). */
  downloadTries?: number | undefined;
  downloadRetryDelayMs?: number | undefined;
  /** Sleep after a counted strike before retrying (R13.4: 5 s). */
  strikeSleepMs?: number | undefined;
  /** Whole-search timeout per provider (Q3 default 30 s). */
  providerTimeoutMs?: number | undefined;
  /** Keep the provider's format (original_format 1). */
  originalFormat?: boolean | undefined;
  utf8?: boolean | undefined;
  throttle?: ThrottleTracker | ThrottleOptions | undefined;
  /**
   * Providers flagged `onlyWhenNoOtherResult` (e.g. Whisper): searched after the others, and
   * only for wanted languages where no other provider produced a candidate reaching the
   * automatic minimum score.
   */
  fallbackProviders?: readonly ProviderKind[] | undefined;
}

export interface SearchOutcome {
  candidates: ScoredCandidate[];
  errors: Array<{ provider: ProviderKind; error: Error }>;
  skipped: Array<{ provider: ProviderKind; reason: string }>;
  throttled: ProviderKind[];
  /** No provider was available: the caller must not record an attempt (R3.25, R5.2). */
  allThrottled: boolean;
}

export interface LanguageResult {
  wanted: WantedLanguage;
  candidate?: ScoredCandidate | undefined;
  subtitle?: PreparedSubtitle | undefined;
  /** Final HI flag after the content heuristic. */
  hi?: boolean | undefined;
  percent?: number | undefined;
  failures: Array<{ provider: ProviderKind; id: string; error: string }>;
}

export interface ManualRow {
  candidate: ScoredCandidate;
  percent: number;
  matched: string[];
}

export class SubtitleSearcher {
  readonly throttle: ThrottleTracker;
  private readonly providers: readonly SubtitleProvider[];
  private readonly opts: SearcherOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: SearcherOptions) {
    this.opts = opts;
    this.providers = opts.providers;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.throttle = opts.throttle instanceof ThrottleTracker ? opts.throttle : new ThrottleTracker({ now: this.now, ...opts.throttle });
    for (const p of this.providers) this.throttle.setOverrides(p.kind, p.rateLimit.throttle);
  }

  /** Enabled providers minus throttled ones (R13.10). */
  available(): SubtitleProvider[] {
    return this.providers.filter((p) => !this.throttle.isThrottled(p.kind));
  }

  minScore(mediaType: MediaType): number {
    return minimumScore(mediaType, this.opts.minScorePercent?.[mediaType] ?? DEFAULT_MIN_SCORE_PERCENT[mediaType]);
  }

  private handleError(provider: SubtitleProvider, err: unknown): 'retry' | 'stop' {
    const outcome = this.throttle.recordError(provider.kind, err);
    if (outcome.action === 'strike') return 'retry';
    if (outcome.action === 'throttled') this.opts.onThrottle?.(outcome.entry);
    return 'stop';
  }

  private withTimeout<T>(p: Promise<T>, provider: SubtitleProvider): Promise<T> {
    const ms = this.opts.providerTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('unreachable', `${provider.kind}: search timed out`, { provider: provider.kind })), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private async searchProvider(provider: SubtitleProvider, query: SubtitleQuery, outcome: SearchOutcome): Promise<SubtitleCandidate[]> {
    for (;;) {
      try {
        const list = await this.withTimeout(provider.search(query), provider);
        this.throttle.recordSuccess(provider.kind);
        return list;
      } catch (err) {
        if (err instanceof ProviderError && (err.code === 'not-found' || err.code === 'unsupported')) return [];
        const next = this.handleError(provider, err);
        if (next === 'retry') {
          await this.sleep(this.opts.strikeSleepMs ?? 5000);
          continue;
        }
        outcome.errors.push({ provider: provider.kind, error: err instanceof Error ? err : new Error(String(err)) });
        if (this.throttle.isThrottled(provider.kind)) outcome.throttled.push(provider.kind);
        return [];
      }
    }
  }

  /** Query every eligible provider, filter, de-duplicate and score (R5.2-R5.14). */
  async search(query: SubtitleQuery): Promise<SearchOutcome> {
    const outcome: SearchOutcome = { candidates: [], errors: [], skipped: [], throttled: [], allThrottled: false };
    const available = this.available();
    for (const p of this.providers) if (!available.includes(p)) outcome.throttled.push(p.kind);
    if (available.length === 0) {
      outcome.allThrottled = true;
      return outcome;
    }
    const eligible: SubtitleProvider[] = [];
    for (const p of available) {
      const s = p.supports(query);
      if (s.ok) eligible.push(p);
      else outcome.skipped.push({ provider: p.kind, reason: s.reason });
    }
    const fallbackKinds = new Set(this.opts.fallbackProviders ?? []);
    const primary = eligible.filter((p) => !fallbackKinds.has(p.kind));
    const fallback = eligible.filter((p) => fallbackKinds.has(p.kind));
    const seen = new Set<string>();
    const scored: ScoredCandidate[] = [];
    this.collect(query, await this.searchAll(primary, query, outcome), seen, scored);
    if (fallback.length > 0) {
      const min = this.minScore(query.mediaType);
      const uncovered = query.languages.filter((w) => selectCandidates(query, scored, w, { minScore: min }).length === 0);
      if (uncovered.length > 0) {
        const narrowed: SubtitleQuery = { ...query, languages: uncovered };
        this.collect(narrowed, await this.searchAll(fallback, narrowed, outcome), seen, scored);
      } else {
        for (const p of fallback) outcome.skipped.push({ provider: p.kind, reason: 'other providers have results' });
      }
    }
    outcome.candidates = sortCandidates(scored);
    return outcome;
  }

  private async searchAll(providers: readonly SubtitleProvider[], query: SubtitleQuery, outcome: SearchOutcome): Promise<SubtitleCandidate[][]> {
    if (this.opts.concurrent ?? true) return Promise.all(providers.map((p) => this.searchProvider(p, query, outcome)));
    const lists: SubtitleCandidate[][] = [];
    for (const p of providers) lists.push(await this.searchProvider(p, query, outcome));
    return lists;
  }

  private collect(query: SubtitleQuery, lists: SubtitleCandidate[][], seen: Set<string>, scored: ScoredCandidate[]): void {
    for (const list of lists) {
      for (const c of list) {
        const key = `${c.provider}\u0000${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const wanted = query.languages.find((w) => w.tag === c.language && w.forced === c.forced);
        if (!wanted) continue;
        if (this.opts.isBlacklisted?.(c.provider, c.id)) continue;
        if (!passesReleaseFilters(c.releaseInfo, this.opts.mustContain, this.opts.mustNotContain)) continue;
        scored.push(scoreCandidate(query, c, wanted));
      }
    }
  }

  /** Manual search rows (R12): no minimum, HI hidden for excluded languages. */
  async manualSearch(query: SubtitleQuery): Promise<{ rows: ManualRow[]; outcome: SearchOutcome }> {
    const outcome = await this.search(query);
    const accepted = new Set<ScoredCandidate>();
    for (const wanted of query.languages) {
      for (const c of selectCandidates(query, outcome.candidates, wanted, { ignoreMinimum: true })) accepted.add(c);
    }
    const rows = sortCandidates([...accepted]).map((c) => ({ candidate: c, percent: scorePercent(c.score, query.mediaType), matched: [...c.matches] }));
    return { rows, outcome };
  }

  /**
   * Download one candidate: up to N tries for connection errors with a pause between, other
   * typed errors throttle and fail at once (R6.5).
   */
  async download(candidate: SubtitleCandidate, query?: SubtitleQuery): Promise<SubtitleFile> {
    const provider = this.providers.find((p) => p.kind === candidate.provider);
    if (!provider) throw new Error(`provider ${candidate.provider} is not configured`);
    const tries = this.opts.downloadTries ?? 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const file = await provider.download(candidate, query);
        this.throttle.recordSuccess(provider.kind);
        return file;
      } catch (err) {
        lastErr = err;
        if (err instanceof ProviderError && err.code === 'must-blacklist') {
          this.opts.onBlacklist?.(candidate, err.message);
          throw err;
        }
        const transient = err instanceof ProviderError && err.code === 'unreachable';
        const outcome = this.throttle.recordError(provider.kind, err);
        if (outcome.action === 'throttled') this.opts.onThrottle?.(outcome.entry);
        if (!transient || outcome.action === 'throttled' || attempt === tries) throw err;
        await this.sleep(this.opts.downloadRetryDelayMs ?? 6000);
      }
    }
    throw lastErr;
  }

  /**
   * Full automatic flow for every wanted language: search once, then for each language walk
   * the acceptable candidates until one downloads and validates (R6.2).
   */
  async searchAndDownload(query: SubtitleQuery): Promise<{ results: LanguageResult[]; outcome: SearchOutcome }> {
    const outcome = await this.search(query);
    const results: LanguageResult[] = [];
    const discarded = new Set<ProviderKind>();
    for (const wanted of query.languages) {
      const result: LanguageResult = { wanted, failures: [] };
      results.push(result);
      if (outcome.allThrottled) continue;
      const accepted = selectCandidates(query, outcome.candidates, wanted, { minScore: this.minScore(query.mediaType) });
      for (const c of accepted) {
        if (discarded.has(c.provider) || this.throttle.isThrottled(c.provider)) continue;
        try {
          const raw = await this.download(c, query);
          const subtitle = prepareSubtitle(raw, {
            hints: {
              season: query.season,
              episode: c.episode ?? query.episode,
              absoluteEpisode: query.absoluteEpisode,
              forced: wanted.forced,
              releaseName: query.sceneName ?? query.fileName,
              episodeTitle: query.episodeTitle,
            },
            language: c.language,
            declaredEncoding: c.encoding,
            convertToSrt: !this.opts.originalFormat,
            utf8: this.opts.utf8,
            fps: c.fps ?? query.fps,
          });
          result.candidate = c;
          result.subtitle = subtitle;
          result.hi = !wanted.forced && (c.hi || (subtitle.looksHi && wanted.hi !== 'excluded'));
          result.percent = scorePercent(c.score, query.mediaType);
          break;
        } catch (err) {
          result.failures.push({ provider: c.provider, id: c.id, error: err instanceof Error ? err.message : String(err) });
          const contentProblem = err instanceof ArchiveError || err instanceof SubtitleContentError;
          const blacklist = err instanceof ProviderError && (err.code === 'must-blacklist' || err.code === 'bad-response');
          if (!contentProblem && !blacklist && !(err instanceof ProviderError && err.code === 'unreachable')) discarded.add(c.provider);
        }
      }
    }
    return { results, outcome };
  }
}
