import type { ParsedSeriesInfo } from '@arclight/parser';
import type { Episode, SceneMappingKind, SceneMappingSource, Series } from '@arclight/shared';

// Pure scene-numbering resolution (decision-engine spec §3.2.1, §3.2.3): translate the season /
// episode / absolute numbers a release name carries into library episodes, using a series's
// scene mapping rules. No database; the releases matcher and "apply to existing files" share it.
//
// Precedence: manual rules, then feed rules, then (in the matcher) the built-in absolute
// fallback for anime. A tier "applies" as soon as one of its rules matches a parsed number; the
// numbers it does not cover pass through unchanged.

/** The fields of a stored mapping the resolver reads. */
export interface SceneRule {
  id?: number;
  seriesId: number;
  kind: SceneMappingKind;
  sceneSeason: number | null;
  sceneEpisode: number | null;
  sceneAbsolute: number | null;
  tvdbSeason: number | null;
  tvdbEpisode: number | null;
  tvdbAbsolute: number | null;
  sceneTitle: string | null;
  source: SceneMappingSource;
}

export interface SceneResolution {
  episodes: Episode[];
  seasonNumber: number | undefined;
  fullSeason: boolean;
  special: boolean;
  source: SceneMappingSource;
}

export const SOURCE_ORDER: readonly SceneMappingSource[] = ['manual', 'feed'];

/**
 * The season a release names, or undefined when it names none: the parser reports season 0 for
 * absolute-only titles ("Show - 15"), which is not a season.
 */
export function parsedSeason(info: ParsedSeriesInfo): number | undefined {
  const season = info.seasons[0];
  if (season === 0 && info.episodes.length === 0 && info.absoluteEpisodes.length > 0 && !info.special) return undefined;
  return season;
}

// ---- absolute numbers ---------------------------------------------------------------------

/**
 * Absolute number → episode for the regular seasons. The library's own absolute numbers win;
 * when the series has none at all and `derive` is set (anime), they are derived by counting
 * episodes in season/episode order (S01E01 = 1, the first episode of season 2 follows the last
 * of season 1, ...).
 */
export function absoluteIndex(episodes: readonly Episode[], derive: boolean): Map<number, Episode> {
  const regular = episodes
    .filter((e) => e.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const index = new Map<number, Episode>();
  const fromLibrary = regular.some((e) => e.absoluteEpisodeNumber != null);
  if (fromLibrary) {
    for (const e of regular) if (e.absoluteEpisodeNumber != null && !index.has(e.absoluteEpisodeNumber)) index.set(e.absoluteEpisodeNumber, e);
    return index;
  }
  if (!derive) return index;
  regular.forEach((e, i) => index.set(i + 1, e));
  return index;
}

// ---- resolution ---------------------------------------------------------------------------

type Target = { season: number; episode: number } | { absolute: number };

interface Ctx {
  episodes: readonly Episode[];
  index: Map<number, Episode>;
}

function find(ctx: Ctx, t: Target): Episode | undefined {
  if ('absolute' in t) return ctx.index.get(t.absolute);
  return ctx.episodes.find((e) => e.seasonNumber === t.season && e.episodeNumber === t.episode);
}

/** Anchor with the largest key not above `n` (a null key counts as 1). */
function pickAnchor(rules: readonly SceneRule[], n: number, key: (r: SceneRule) => number | null): SceneRule | undefined {
  let best: SceneRule | undefined;
  for (const r of rules) {
    const k = key(r) ?? 1;
    if (k > n) continue;
    if (!best || k > (key(best) ?? 1)) best = r;
  }
  return best;
}

/** Library target of a rule for a parsed number `delta` past its scene anchor. */
function targetOf(rule: SceneRule, delta: number, parsedEpisode?: number): Target | null {
  if (rule.tvdbAbsolute !== null) return { absolute: rule.tvdbAbsolute + delta };
  if (rule.tvdbSeason === null) return null;
  // Season-only remap (no episode anchors): the episode number is kept.
  if (rule.tvdbEpisode === null && rule.sceneEpisode === null && parsedEpisode !== undefined) {
    return { season: rule.tvdbSeason, episode: parsedEpisode };
  }
  return { season: rule.tvdbSeason, episode: (rule.tvdbEpisode ?? rule.sceneEpisode ?? 1) + delta };
}

function sortEpisodes(list: Episode[]): Episode[] {
  const seen = new Set<number>();
  return list
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

function result(hits: Episode[], fallbackSeason: number | undefined, fullSeason: boolean, source: SceneMappingSource): SceneResolution {
  const episodes = sortEpisodes(hits);
  return {
    episodes,
    seasonNumber: episodes[0]?.seasonNumber ?? fallbackSeason,
    fullSeason,
    special: episodes.length > 0 && episodes.every((e) => e.seasonNumber === 0),
    source,
  };
}

/**
 * Episodes a season-pack anchor covers: from its target up to (excluding) the next target any
 * rule of the tier points at in the same library season / absolute range.
 */
function packRange(ctx: Ctx, anchor: SceneRule, sameSeason: readonly SceneRule[], tier: readonly SceneRule[]): Episode[] {
  const start = targetOf(anchor, 0);
  if (!start) return [];
  const anchorKey = anchor.sceneEpisode ?? 1;
  const next = sameSeason
    .filter((r) => r !== anchor && (r.sceneEpisode ?? 1) > anchorKey)
    .sort((a, b) => (a.sceneEpisode ?? 1) - (b.sceneEpisode ?? 1))[0];
  if ('absolute' in start) {
    let end = Number.POSITIVE_INFINITY;
    if (next) end = start.absolute + ((next.sceneEpisode ?? 1) - anchorKey) - 1;
    for (const r of tier) if (r.tvdbAbsolute !== null && r.tvdbAbsolute > start.absolute) end = Math.min(end, r.tvdbAbsolute - 1);
    return [...ctx.index.entries()].filter(([abs]) => abs >= start.absolute && abs <= end).map(([, e]) => e);
  }
  let end = Number.POSITIVE_INFINITY;
  if (next) end = start.episode + ((next.sceneEpisode ?? 1) - anchorKey) - 1;
  for (const r of tier) {
    if (r === anchor || r.tvdbSeason !== start.season || r.tvdbAbsolute !== null) continue;
    const ep = r.tvdbEpisode ?? r.sceneEpisode ?? 1;
    if (ep > start.episode) end = Math.min(end, ep - 1);
  }
  return ctx.episodes.filter((e) => e.seasonNumber === start.season && e.episodeNumber >= start.episode && e.episodeNumber <= end);
}

function resolveTier(info: ParsedSeriesInfo, series: Series, ctx: Ctx, tier: readonly SceneRule[], alias: SceneRule | undefined, source: SceneMappingSource): SceneResolution | null {
  const season = parsedSeason(info);
  const anime = series.seriesType === 'anime';

  // 1. Matched through a title alias that pins a library season.
  if (alias && alias.tvdbSeason !== null && (alias.sceneSeason === null || season === undefined || season === alias.sceneSeason)) {
    const tvdbSeason = alias.tvdbSeason;
    const start = alias.tvdbEpisode ?? 1;
    if (info.fullSeason) {
      return result(ctx.episodes.filter((e) => e.seasonNumber === tvdbSeason && e.episodeNumber >= start), tvdbSeason, true, source);
    }
    const nums = info.episodes.length > 0 && !(anime && info.absoluteEpisodes.length > 0) ? info.episodes : info.absoluteEpisodes;
    if (nums.length > 0) {
      const offset = start - (alias.sceneEpisode ?? 1);
      const hits = nums.map((n) => find(ctx, { season: tvdbSeason, episode: n + offset })).filter((e): e is Episode => !!e);
      return result(hits, tvdbSeason, false, source);
    }
  }

  const seasonRules = (s: number) => tier.filter((r) => r.kind === 'season' && r.sceneSeason === s);

  // 2. Season packs (and multi-season packs).
  if (info.fullSeason) {
    const seasons = info.isMultiSeason ? info.seasons : season !== undefined ? [season] : [];
    let applied = false;
    const hits: Episode[] = [];
    for (const s of seasons) {
      const anchors = seasonRules(s);
      if (anchors.length === 0) {
        hits.push(...ctx.episodes.filter((e) => e.seasonNumber === s));
        continue;
      }
      applied = true;
      for (const a of anchors) hits.push(...packRange(ctx, a, anchors, tier));
    }
    return applied ? result(hits, season, true, source) : null;
  }

  // 3. Absolute numbers (anime numbering, or a title with only an absolute number).
  const absoluteFirst = info.absoluteEpisodes.length > 0 && (info.episodes.length === 0 || anime);
  const absolute = (): SceneResolution | null => {
    if (!absoluteFirst) return null;
    const anchors = tier.filter(
      (r) => r.kind === 'absolute' && r.sceneAbsolute !== null && (r.sceneSeason === null || season === undefined || r.sceneSeason === season),
    );
    if (anchors.length === 0) return null;
    let applied = false;
    const hits: Episode[] = [];
    for (const n of info.absoluteEpisodes) {
      const rule = pickAnchor(anchors, n, (r) => r.sceneAbsolute);
      if (!rule) {
        const plain = ctx.index.get(n);
        if (plain) hits.push(plain);
        continue;
      }
      applied = true;
      const t = targetOf(rule, n - (rule.sceneAbsolute ?? 1));
      const hit = t ? find(ctx, t) : undefined;
      if (hit) hits.push(hit);
    }
    return applied ? result(hits, undefined, false, source) : null;
  };
  const viaAbsolute = absolute();
  if (viaAbsolute) return viaAbsolute;

  // 4. Season + episode numbers.
  if (season !== undefined && info.episodes.length > 0) {
    const anchors = seasonRules(season);
    if (anchors.length === 0) return null;
    let applied = false;
    const hits: Episode[] = [];
    for (const n of info.episodes) {
      const rule = pickAnchor(anchors, n, (r) => r.sceneEpisode);
      if (!rule) {
        const plain = find(ctx, { season, episode: n });
        if (plain) hits.push(plain);
        continue;
      }
      applied = true;
      const t = targetOf(rule, n - (rule.sceneEpisode ?? 1), n);
      const hit = t ? find(ctx, t) : undefined;
      if (hit) hits.push(hit);
    }
    return applied ? result(hits, season, false, source) : null;
  }
  return null;
}

/**
 * Map a parsed release onto library episodes through the series's scene rules. Returns null
 * when no rule applies (the caller falls back to plain numbering / the anime absolute fallback).
 * `alias` is the title rule the series was matched through, if any.
 */
export function resolveSceneNumbering(
  info: ParsedSeriesInfo,
  series: Series,
  episodes: readonly Episode[],
  rules: readonly SceneRule[],
  alias?: SceneRule,
): SceneResolution | null {
  if (info.airDate) return null;
  if (rules.length === 0 && !alias) return null;
  const ctx: Ctx = { episodes, index: absoluteIndex(episodes, series.seriesType === 'anime') };
  for (const source of SOURCE_ORDER) {
    const tier = rules.filter((r) => r.source === source && r.seriesId === series.id);
    const tierAlias = alias && alias.source === source ? alias : undefined;
    if (tier.length === 0 && !tierAlias) continue;
    const resolved = resolveTier(info, series, ctx, tier, tierAlias, source);
    if (resolved) return resolved;
  }
  return null;
}

/** Title rules whose alias may be used for this parsed season (no `sceneSeason` = any season). */
export function aliasAppliesToSeason(rule: SceneRule, parsedSeason: number | undefined): boolean {
  return rule.kind === 'title' && !!rule.sceneTitle && (rule.sceneSeason === null || parsedSeason === undefined || rule.sceneSeason === parsedSeason);
}

/** Best alias rule among several of one series: manual first, then season-specific ones. */
export function preferAlias(rules: readonly SceneRule[], parsedSeason: number | undefined): SceneRule | undefined {
  const rank = (r: SceneRule) =>
    (r.source === 'manual' ? 0 : 2) + (r.sceneSeason !== null && r.sceneSeason === parsedSeason ? 0 : 1);
  return [...rules].sort((a, b) => rank(a) - rank(b))[0];
}
