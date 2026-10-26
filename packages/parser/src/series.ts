import { spaced } from './normalize.js';
import type { ParsedSeriesInfo, SeriesTitleInfo } from './types.js';

// Series parsing.
//
// The release name is first normalised (full-width / Arabic-Indic digits, CJK brackets,
// fansub "[Group][Title][Episode]" layouts) and the anime sub-group prefix is split off.
// Then numbering markers are located:
//
//   1. Strong markers — SxxEyy (and its multi-episode forms), NxNN, worded
//      "Season N Episode M", "Cap.NNN" and air dates. Every strong marker in the string is
//      found and the one that starts earliest wins; the title is whatever precedes it.
//   2. Otherwise a cascade of weaker forms, most specific first: anime absolute numbering
//      for sub-group releases, season packs, explicit absolute markers (EP, Episode, #),
//      combined "103" numbers, plain absolute numbers and mini-series "Part N".

// ---------------------------------------------------------------------------------------
// Small helpers

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const CJK_G = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const LATIN = /[A-Za-z]/;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
/** Common video widths: "1280x720" is a resolution, not season 1280 episode 720. */
const RESOLUTION_WIDTHS = new Set([320, 352, 480, 640, 704, 720, 768, 848, 852, 853, 854, 960, 1024, 1152, 1280, 1366, 1440, 1600, 1920, 2048, 2560, 3840, 4096]);
/** Tokens that only appear in the technical tail of a release name. */
const TAG = String.raw`(?:\d{3,4}[pi]\b|hdtv|pdtv|sdtv|dsr|web(?:-?dl|-?rip)?\b|bluray|blu-ray|bdrip|brrip|bd\b|dvd(?:rip)?|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|aac|ac3|dts|flac|dd[p+]?\d|proper|repack|internal|vostfr|vf\b|multi|french|german|english|dubbed|subbed|hd\b|sd\b|uncut|complete)`;
const TAG_AHEAD = new RegExp(String.raw`^[-_. \[(]*${TAG}`, 'i');

function range(a: number, b: number): number[] {
  if (b < a) return [a];
  if (b - a > 2000) return [a, b];
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
}

/** Two numbers mean an inclusive range; more are an explicit list. */
function episodeList(nums: number[]): number[] {
  if (nums.length === 2) return range(nums[0]!, nums[1]!);
  return [...new Set(nums)];
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  // Nothing before regular television and nothing far in the future.
  const limit = new Date();
  limit.setUTCDate(limit.getUTCDate() + 3);
  return y > 1950 && date <= limit;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function emptyInfo(): ParsedSeriesInfo {
  return {
    title: '',
    titleInfo: { title: '', titleWithoutYear: '', year: 0, country: null },
    seasons: [],
    episodes: [],
    absoluteEpisodes: [],
    airDate: null,
    fullSeason: false,
    isPartialSeason: false,
    isMultiSeason: false,
    isSeasonExtra: false,
    isSplitEpisode: false,
    isMiniSeries: false,
    seasonPart: 0,
    special: false,
    releaseVersion: 1,
    subGroup: null,
  };
}

// ---------------------------------------------------------------------------------------
// Title info

const YEAR_SUFFIX = /^(?<t>.+?)[ (\[]+(?<year>19\d{2}|20\d{2})[)\]]?$/;
const COUNTRY_SUFFIX = /^(?<t>.+?)[ (]+(?<country>US|UK|AU|CA|NZ)\)?$/;

/** Split a parsed series title into title / title-without-year / year / country. */
export function parseSeriesTitleInfo(rawTitle: string): SeriesTitleInfo {
  const title = spaced(rawTitle).replace(/\s*[-–]\s*$/, '').trim();
  let year = 0;
  let country: string | null = null;
  let without = title;

  const y = YEAR_SUFFIX.exec(without);
  if (y?.groups) {
    year = Number(y.groups['year']);
    without = y.groups['t']!.trim();
  }
  const c = COUNTRY_SUFFIX.exec(without);
  if (c?.groups) {
    country = c.groups['country']!.toUpperCase();
  }
  return { title, titleWithoutYear: without, year, country };
}

// ---------------------------------------------------------------------------------------
// Pre-processing

interface Ctx {
  /** Text after the sub-group prefix, digits normalised. */
  text: string;
  /** Same length as `text`, with `.`/`_` separators turned into spaces (decimals kept). */
  loose: string;
  subGroup: string | null;
  /** "221208 Show ep11" style Japanese/Korean broadcast names: ep/# are season-1 episodes. */
  broadcastPrefix: boolean;
}

function normaliseDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48))
    .replace(/[٠-٩]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48))
    .replace(/[۰-۹]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x06f0 + 48));
}

function looseOf(text: string): string {
  // Dots stay only in short decimals ("12.5", "26.5.1"); everything else is a separator.
  return text.replace(/_/g, ' ').replace(/(?<!\d)\.|\.(?!\d(?!\d))/g, ' ');
}

function makeCtx(text: string, subGroup: string | null, broadcastPrefix = false): Ctx {
  return { text, loose: looseOf(text), subGroup, broadcastPrefix };
}

function prepareSeries(input: string): Ctx {
  let t = normaliseDigits(input.trim()).replace(/【/g, '[').replace(/】/g, ']');
  // Leading request info: "[scnzbefnet][509103] Title"
  t = t.replace(/^\[[^\]]*\]\[\d+\]\s*/, '');
  // Leading website banner: "[高清剧集网发布 www.DDHDTV.com]当我飞奔向你[全24集][...].Title.S01"
  const banner = /^\[[^\]]*www\.[^\]]*\]/i.exec(t);
  if (banner) {
    t = t.slice(banner[0].length);
    // ...followed by the CJK title and its tags, then the Latin name: "当我飞奔向你[全24集].Series.Towards.You"
    t = t.replace(/^[^\x00-\x7f\[]+(?:\[[^\]]*\])*[-_. ]+(?=[A-Za-z])/, '');
  }

  let subGroup: string | null = null;
  const sg = /^\[(?<g>[^\]]+)\][-_. ]*/.exec(t);
  if (sg?.groups && !/^\d{3,4}p$/i.test(sg.groups['g']!) && !/^(?:19|20)\d{2}$/.test(sg.groups['g']!)) {
    subGroup = sg.groups['g']!.trim();
    // "[OPFans楓雪動漫]": Latin group name followed by its Chinese site name. Names that end in
    // a team word (字幕组, 百合組, …社) are the group's own name and stay whole.
    const mixed = /^([A-Za-z0-9][A-Za-z0-9-]*)([㐀-鿿]+)$/.exec(subGroup);
    if (mixed && !/[组組社]$/.test(mixed[2]!)) subGroup = mixed[1]!;
    t = t.slice(sg[0].length);
    // A second tag before the title: "[Jumonji-Giri]_[F-B]_Series_Title_Ep04"
    t = t.replace(/^\[[^\]]*\][-_ ]+(?=[^\[\s])/, '');
  }
  t = t.replace(/[_.\s]+$/, '');
  // "★10月新番★" / "★04月新番" season banners
  t = t.replace(/★[^★\[]*★?/g, ' ').replace(/^\s+/, '');

  // "221208 Show Title ep11.mp4": a yymmdd broadcast-date prefix is not part of the title.
  let broadcastPrefix = false;
  const bp = /^(\d{2})(\d{2})(\d{2})\s+(?=\S)/.exec(t);
  if (bp && isValidDate(2000 + Number(bp[1]), Number(bp[2]), Number(bp[3])) && !subGroup) {
    t = t.slice(bp[0].length);
    broadcastPrefix = true;
  }
  return makeCtx(t, subGroup, broadcastPrefix);
}

// ---------------------------------------------------------------------------------------
// Title clean-up

/** Reduce a mixed CJK/Latin title to its Latin alias, when it has one. */
const HAN_KANA = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

function cjkTitle(title: string): string {
  if (!HAN_KANA.test(title) || !LATIN.test(title.replace(CJK_G, ''))) return title;
  const parts = title.split(/\s*[\/|·]\s*|\s+_\s+|(?<=[^\x00-\x7f])_/).map((p) => p.trim()).filter(Boolean);
  let pick = [...parts].reverse().find((p) => LATIN.test(p)) ?? title;
  // Drop whole words that are CJK only ("SERIES 靦腆英雄" → "SERIES").
  const words = pick.split(/[\s.]+/);
  const pure = (w: string) => HAN_KANA.test(w) && !/[A-Za-z0-9]/.test(w);
  while (words.length > 1 && pure(words[0]!)) words.shift();
  while (words.length > 1 && pure(words[words.length - 1]!)) words.pop();
  pick = words.join(' ');
  return pick;
}

function finishTitle(raw: string, ctx: Ctx): string {
  let t = raw;
  // "Title (Miniserie) (2024/S01E07/..." → "Title (2024)"
  t = t.replace(/\s*\((?:mini-?series?|miniserie)\)/gi, '');
  const yearSlash = /^(.*?)[\s.]*\((\d{4})\/$/.exec(t);
  if (yearSlash) t = `${yearSlash[1]} (${yearSlash[2]})`;
  t = t.replace(/[\s\-_.(\[{\/|~]+$/, '');
  // Unbalanced leading bracket: "(Series of Title s03e10"
  if (/^[(\[]/.test(t) && !/[)\]]/.test(t)) t = t.slice(1);
  t = cjkTitle(t.trim());
  t = spaced(t.replace(/[<>?]/g, ''));
  // Words that belong to the numbering, and codec tags glued before it.
  t = t.replace(/[-_. ]+(?:Episode|Episodio|Ep)$/i, '').replace(/[-_. ]+(?:x26[45]|h\.?26[45])$/i, '');
  t = t.replace(/\s*[-–]+\s*$/, '').replace(/^\s*[-–]+\s*/, '').trim();
  return t;
}

function build(rawTitle: string, ctx: Ctx, fill: (info: ParsedSeriesInfo) => void): ParsedSeriesInfo {
  const info = emptyInfo();
  info.subGroup = ctx.subGroup;
  info.title = finishTitle(rawTitle, ctx);
  fill(info);
  info.titleInfo = parseSeriesTitleInfo(info.title);
  return info;
}

/** Fansub convention: a sub-group "Title S02 - 11" names the season "S2" in the title. */
function shortSeasonTag(info: ParsedSeriesInfo): ParsedSeriesInfo {
  info.title = info.title.replace(/\bS0(\d)\b/, 'S$1');
  info.titleInfo = parseSeriesTitleInfo(info.title);
  return info;
}

/** Parse a "v2" release version directly after a number. */
function versionAt(s: string): number | null {
  const m = /^\s?v(\d)(?![a-z\d])/i.exec(s);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------------------
// Strong markers

interface Hit {
  start: number;
  end: number;
  apply: (info: ParsedSeriesInfo) => void;
  /** Title override (some markers take the title from elsewhere). */
  title?: string;
  kind: 'se' | 'x' | 'words' | 'daily' | 'cap';
}

const SE_RE = /(?<=^|[-_. \[(\/a-z])S(\d{1,4})(?:(?:-|[-_. ]?)(?:E|Ep|x)[-_. ]?|\s-\sE)(\d{1,5})/gi;

/** Continuation tokens after the first episode number of an SxxEyy marker. */
function seContinuation(s: string): { nums: number[]; consumed: number; split: boolean; special: boolean } {
  const nums: number[] = [];
  let pos = 0;
  let split = false;
  let special = false;
  const sm = /^[a-d](?![a-z])/i.exec(s);
  if (sm) {
    split = true;
    pos += sm[0].length;
  }
  const dec = /^\.5(?!\d)/.exec(s.slice(pos));
  if (dec) {
    special = true;
    pos += dec[0].length;
  }
  for (;;) {
    const rest = s.slice(pos);
    const m =
      /^(?:[-_. ]*(?:-|to|&|and|\+)[-_. ]*|[-_. ]?)(?:S\d{1,4}[-_. ]?)?(?:E|Ep)[-_. ]?(\d{1,5})(?![a-z\d])/i.exec(rest) ??
      /^[-_. ]*(?:-|to)[-_. ]*S\d{1,4}(?:E|Ep)(\d{1,5})(?![a-z\d])/i.exec(rest) ??
      /^(?:x|-x?|_|\+)(\d{1,5})(?![\da-z])/i.exec(rest) ??
      /^-E?(\d{1,5})(?=[-_. )\]]|$)/i.exec(rest);
    if (!m) break;
    nums.push(Number(m[1]));
    pos += m[0].length;
  }
  return { nums, consumed: pos, split, special };
}

function findSE(text: string, subGroup: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(SE_RE)) {
    const start = m.index!;
    // Preceded by a letter only for glued forms like "grp-zoos01e11"; reject words ending in s+digits otherwise.
    const season = Number(m[1]);
    const first = Number(m[2]);
    const afterFirst = start + m[0].length;
    const cont = seContinuation(text.slice(afterFirst));
    let end = afterFirst + cont.consumed;
    // Boundary: the marker must not run into letters/digits.
    const tail = text.slice(end);
    if (/^[a-z\d]/i.test(tail) && !cont.split && !/^v\d(?![a-z\d])/i.test(tail)) continue;
    const eps = episodeList([first, ...cont.nums]);
    let fullSeason = false;
    const of = /^[-_. ]*\(?of[-_. ]*(\d{1,3})/i.exec(tail);
    if (of && eps[0] === 1 && eps.length > 1 && eps[eps.length - 1] === Number(of[1])) fullSeason = true;
    let version = versionAt(tail);
    // Absolute numbers after the marker: only for anime-style releases or in parentheses.
    let absolute: number[] = [];
    const abs = /^(?:[-_. ]+|[-_. ]*-[-_. ]*)(\()?(\d{2,4})((?:-\d{2,4})*)(\))?(?=$|[-_. \[(])/.exec(tail);
    if (abs && !/^[-_. ]*\d{3,4}[pi]/i.test(tail)) {
      const nums = [abs[2]!, ...(abs[3] ?? '').split('-').filter(Boolean)].map(Number);
      const after = tail.slice(abs[0].length);
      const okBoundary = !/^-[a-z]/i.test(after) && Boolean(abs[1]) === Boolean(abs[4]);
      const year = nums.length === 1 && /^(?:19|20)\d{2}$/.test(abs[2]!);
      if (okBoundary && !year && (subGroup || abs[1] || /^0\d{2}/.test(abs[2]!))) {
        absolute = episodeList(nums);
        end += abs[0].length;
        version ??= versionAt(after);
      }
    }
    const isSpecial = cont.special;
    hits.push({
      start,
      end,
      kind: 'se',
      apply: (info) => {
        info.seasons = [season];
        if (fullSeason) {
          info.fullSeason = true;
        } else {
          info.episodes = eps;
        }
        info.absoluteEpisodes = absolute;
        if (cont.split) info.isSplitEpisode = true;
        if (isSpecial || season === 0 || (eps.length === 1 && eps[0] === 0)) info.special = true;
        if (version) info.releaseVersion = version;
      },
    });
  }
  return hits;
}

/** "Titles.s06.01.1999.BDRip": season and episode separated by a dot, no E. */
function findDottedSE(text: string): Hit[] {
  const m = /(?<=[-_. ])S(\d{1,2})\.(\d{1,2})\.(?=(?:19|20)\d{2}[-_. ]|\d{3,4}p)/i.exec(text);
  if (!m) return [];
  const season = Number(m[1]);
  const ep = Number(m[2]);
  return [{ start: m.index, end: m.index + m[0].length - 1, kind: 'se', apply: (info) => { info.seasons = [season]; info.episodes = [ep]; } }];
}

const X_RE =/(?<=^|[-_. \[(\/])(\d{1,4})x(\d{1,3})(?![\dp])/gi;

function findX(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(X_RE)) {
    const season = Number(m[1]);
    const first = Number(m[2]);
    if (RESOLUTION_WIDTHS.has(season) || (season >= 100 && season < 1900)) continue;
    const start = m.index!;
    let pos = start + m[0].length;
    const nums = [first];
    for (;;) {
      const rest = text.slice(pos);
      const c =
        /^(?:x|-x?|_)(\d{1,3})(?![\dpx])/i.exec(rest) ??
        /^(?:[-_. ]*(?:-|to)[-_. ]*|\.)\d{1,4}x(\d{1,3})(?![\dp])/i.exec(rest);
      if (!c) break;
      nums.push(Number(c[1]));
      pos += c[0].length;
    }
    if (/^[a-z\d]/i.test(text.slice(pos))) continue;
    const eps = episodeList(nums);
    hits.push({ start, end: pos, kind: 'x', apply: (info) => { info.seasons = [season]; info.episodes = eps; } });
  }
  return hits;
}

function findWords(text: string): Hit[] {
  const hits: Hit[] = [];
  const re = /(?<=^|[-_. \[(])(?:Season|Series|Saison|Se)[-_. ]?(\d{1,2})[-_. ]+(?:-[-_. ]*)?(?:Episode|Ep|Afl|Aflevering|E)[-_. ]?(\d{1,4})((?:[-_. ]*(?:-|to|and|&|en)[-_. ]*(?:Episode|Ep|E)?[-_. ]?\d{1,4})*)(?![\da-z])/gi;
  for (const m of text.matchAll(re)) {
    const season = Number(m[1]);
    const nums = [Number(m[2]), ...[...(m[3] ?? '').matchAll(/\d{1,4}/g)].map((x) => Number(x[0]))];
    const eps = episodeList(nums);
    hits.push({ start: m.index!, end: m.index! + m[0].length, kind: 'words', apply: (info) => { info.seasons = [season]; info.episodes = eps; } });
  }
  return hits;
}

function findCap(text: string): Hit[] {
  const m = /\[Cap\.\s?(\d{3,4})(?:_(\d{3,4}))?\]/i.exec(text);
  if (!m) return [];
  const a = Number(m[1]);
  const season = Math.floor(a / 100);
  const first = a % 100;
  const last = m[2] ? Number(m[2]) % 100 : first;
  // Title: before " - Temporada" or before the first bracket.
  const temporada = /[-_. ]*-?[-_. ]*Temporada[-_. ]*\d+/i.exec(text);
  const bracket = text.indexOf('[');
  const end = temporada && temporada.index < bracket ? temporada.index : bracket;
  return [{
    start: end,
    end: m.index + m[0].length,
    kind: 'cap',
    apply: (info) => { info.seasons = [season]; info.episodes = range(first, last); },
  }];
}

interface DateHit { start: number; end: number; date: string }

function findDates(text: string): DateHit[] {
  const out: DateHit[] = [];
  const B = String.raw`(?<![\d])`;
  const A = String.raw`(?![\d])`;
  // y m d (and y d m when the middle number cannot be a month)
  for (const m of text.matchAll(new RegExp(String.raw`${B}((?:19|20)\d{2})([-_. ])(\d{1,2})\2(\d{1,2})${A}`, 'g'))) {
    const y = Number(m[1]);
    const a = Number(m[3]);
    const b = Number(m[4]);
    if (isValidDate(y, a, b)) out.push({ start: m.index!, end: m.index! + m[0].length, date: isoDate(y, a, b) });
    else if (a > 12 && isValidDate(y, b, a)) out.push({ start: m.index!, end: m.index! + m[0].length, date: isoDate(y, b, a) });
  }
  // d m y / m d y: rejected when both orders are plausible
  for (const m of text.matchAll(new RegExp(String.raw`${B}(\d{1,2})([-_. ])(\d{1,2})\2((?:19|20)\d{2})${A}`, 'g'))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = Number(m[4]);
    let date: string | null = null;
    if (a > 12 && isValidDate(y, b, a)) date = isoDate(y, b, a);
    else if (b > 12 && isValidDate(y, a, b)) date = isoDate(y, a, b);
    else if (a === b && isValidDate(y, a, b)) date = isoDate(y, a, b);
    if (date) out.push({ start: m.index!, end: m.index! + m[0].length, date });
  }
  // yyyymmdd
  for (const m of text.matchAll(new RegExp(String.raw`${B}((?:19|20)\d{2})(\d{2})(\d{2})${A}`, 'g'))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidDate(y, mo, d)) out.push({ start: m.index!, end: m.index! + m[0].length, date: isoDate(y, mo, d) });
  }
  // yymmdd after a title: "Show.140722.720p" / "ror-240618_1007"
  for (const m of text.matchAll(/(?<=[-_. ])(\d{2})(\d{2})(\d{2})(?=[-_. ]|$)/g)) {
    const y = 2000 + Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y >= 2005 && isValidDate(y, mo, d)) out.push({ start: m.index!, end: m.index! + m[0].length, date: isoDate(y, mo, d) });
  }
  // 5th Mar 2025
  for (const m of text.matchAll(/(?<![\d])(\d{1,2})(?:st|nd|rd|th)?[-_. ]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_. ]+((?:19|20)\d{2})(?!\d)/gi)) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2]!.toLowerCase()]!;
    const y = Number(m[3]);
    if (isValidDate(y, mo, d)) out.push({ start: m.index!, end: m.index! + m[0].length, date: isoDate(y, mo, d) });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Dates whose surroundings make them an episode air date rather than a stray number. */
function findDaily(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const d of findDates(text)) {
    // A date at the very start needs separators after it ("2011.01.10 - Show").
    hits.push({ start: d.start, end: d.end, kind: 'daily', apply: (info) => { info.airDate = d.date; info.seasons = [0]; } });
  }
  return hits;
}

/** "Босх: Спадок (S2E1) / Series: Legacy (S2E1)" — prefer the Latin alias for the title. */
function aliasTitle(title: string, text: string, hit: Hit): string | null {
  if (LATIN.test(title)) return null;
  if (!/[^\x00-\x7f]/.test(title)) return null;
  const after = text.slice(hit.end);
  const m = /^\)?\s*\/\s*([^\/(\[]+?)\s*(?:[(\[\/]|$)/.exec(after);
  if (m && LATIN.test(m[1]!)) return m[1]!;
  return null;
}

function parseStrong(ctx: Ctx): ParsedSeriesInfo | null {
  const text = ctx.text;
  const hits = [...findSE(text, Boolean(ctx.subGroup)), ...findDottedSE(text),...findX(text), ...findWords(text), ...findCap(text), ...findDaily(text)];
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.start - b.start || order(a.kind) - order(b.kind));
  let hit = hits[0]!;
  let rawTitle = text.slice(0, hit.start);

  // "Title / Alias / S2E1": use the last alias before the marker.
  const slash = rawTitle.split(/\s+[\/|]\s+/);
  if (slash.length > 1) {
    const latin = slash.filter((p) => LATIN.test(p) && p.trim() && !/^[\s\/|]*$/.test(p));
    const pick = latin.length > 0 ? latin[latin.length - 1]! : slash[slash.length - 1]!;
    rawTitle = pick.replace(/\s*\/\s*$/, '');
    if (rawTitle.trim() === '' && slash.length > 1) rawTitle = slash[slash.length - 2]!;
  }
  const alias = aliasTitle(finishTitle(rawTitle, ctx), text, hit);
  if (alias) rawTitle = alias;

  // A daily date immediately followed by SxxEyy: keep both.
  let extra: Hit | null = null;
  if (hit.kind === 'daily') {
    rawTitle = rawTitle.replace(/[-_. ]+E\d{1,4}[-_. ]*$/i, ' ');
    const next = hits.find((h) => h !== hit && (h.kind === 'se' || h.kind === 'x' || h.kind === 'words') && h.start >= hit.end && /^[-_. ]*$/.test(text.slice(hit.end, h.start)));
    if (next) extra = next;
    // A date that only precedes a strong episode marker further on in a filename ("20161024- Show.21x41") still wins.
    // A date at the very start with nothing but tags after it is a daily with no title.
  } else {
    // Title ending with a date: "Judge Show 2016 02 25 S20E142"
    const d = findDates(rawTitle).find((x) => /^[-_. ]*$/.test(rawTitle.slice(x.end)));
    if (d) {
      const date = d.date;
      rawTitle = rawTitle.slice(0, d.start);
      const base = hit;
      hit = { ...base, apply: (info) => { base.apply(info); info.airDate = date; } };
    }
  }

  // Anime: "[Group] Title - 05 - S01E05", "[Group] Title 214 10x14"
  let absolute: number[] = [];
  if (ctx.subGroup && (hit.kind === 'se' || hit.kind === 'x')) {
    const a = /[-_. ]+-[-_. ]*(\d{2,4})(?:\.(\d))?[-_. ]*[-(\[]*[-_. ]*$/.exec(rawTitle) ?? /[-_. ](\d{3,4})[-_. ]*$/.exec(rawTitle);
    if (a && !/^(?:19|20)\d{2}$/.test(a[1]!)) {
      if (a[2] === undefined) absolute = [Number(a[1])];
      rawTitle = rawTitle.slice(0, a.index);
    }
    if (absolute.length === 0 && hit.kind === 'x') {
      const after = /^[-_. ]+(\d{3,4})(?=$|[-_. \[(])/.exec(text.slice(hit.end));
      if (after) absolute = [Number(after[1])];
    }
  }

  const chosen = hit;
  return build(rawTitle, ctx, (info) => {
    chosen.apply(info);
    if (extra) {
      extra.apply(info);
    }
    if (absolute.length > 0 && info.absoluteEpisodes.length === 0) info.absoluteEpisodes = absolute;
  });
}

function order(kind: Hit['kind']): number {
  return { se: 0, x: 1, words: 2, cap: 3, daily: 4 }[kind];
}

// ---------------------------------------------------------------------------------------
// Fansub bracket layouts: "[Group][中文/English Title][05][1080p]"

const BRACKET_TAG = /^(?:\d{3,4}[pi]\d*|(?:19|20)\d{2}|big5|gb|chs|cht|jap|jpn|mp4|mkv|avc|hevc|x26[45]|aac|flac|web[-_ ]?(?:dl|rip)|bdrip|end|fin|完|.*月新番.*|国漫|简体|繁体|繁體|简日双语|典藏版)$/i;
const BRACKET_EPISODE = /^(?:第)?(\d{1,4})(?:-(\d{1,4}))?(?:\s*(?:END|Fin|完|集|话|話|v\d))?$/i;

function parseBracketLayout(ctx: Ctx): ParsedSeriesInfo | null {
  if (!ctx.subGroup) return null;
  const text = ctx.text.trim();
  // "[Title][05]" — every segment bracketed
  if (text.startsWith('[')) {
    const segs = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!.trim());
    const epIdx = segs.findIndex((s, i) => i > 0 && BRACKET_EPISODE.test(s) && !/^(?:19|20)\d{2}$/.test(s) && !/^\d{3,4}p$/i.test(s));
    if (epIdx < 1) return null;
    const candidates = segs.slice(0, epIdx).filter((s) => s && !BRACKET_TAG.test(s));
    if (candidates.length === 0) return null;
    const title = candidates.find((s) => LATIN.test(s) && !CJK.test(s)) ?? candidates.find((s) => LATIN.test(s)) ?? candidates[candidates.length - 1]!;
    const m = BRACKET_EPISODE.exec(segs[epIdx]!)!;
    const a = Number(m[1]);
    const abs = m[2] ? range(a, Number(m[2])) : [a];
    return shortSeasonTag(build(title, ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = abs; }));
  }
  // "Title[05][1080p]" / "Title S2 [05]" / "中文 / Title [05]"
  const m = /^([^\[]+?)[-_. ]?\[(?:第)?(\d{1,4})(?:-(\d{1,4}))?(?:\s*(?:END|Fin|完|集|话|話))?\]/i.exec(text);
  if (m && !/^(?:19|20)\d{2}$/.test(m[2]!)) {
    const a = Number(m[2]);
    const abs = m[3] ? range(a, Number(m[3])) : [a];
    return shortSeasonTag(build(m[1]!, ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = abs; }));
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Anime absolute numbering for sub-group releases

const ABS_BOUNDARY = String.raw`(?=\s*$|\s*[\[(]|\s+-|\s+v\d|\s+(?:END|Batch|Complete|Fin)\b|\s+\d{3,4}x\d{3,4}|\s+${TAG})`;

function animeDashParts(ctx: Ctx): ParsedSeriesInfo | null {
  const s = ctx.loose;
  // Specials/extras: "[Group] Title - 01 - Special"
  const sp = /^(.+?)\s+-\s+(\d{2,3})\s+-\s+(?:Special|OVA|OVD)\b/i.exec(s);
  if (sp) return build(ctx.text.slice(0, sp[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(sp[2])]; info.special = true; });

  // Ranges: "Title (01-25)", "Title 01 - 119 [Batch]", "Title 1017-1088 (WEB)", "Title - 01~10", "Title_26-27"
  const rg = new RegExp(String.raw`^(.+?)\s+(?:-\s+)?\(?(\d{2,4})(\s?[-~]\s?|[-~])(\d{2,4})((?:-\d{2,4})*)\)?(?:v(\d))?${ABS_BOUNDARY}`, 'i').exec(s);
  if (rg && Number(rg[4]) > Number(rg[2]) && !/^(?:19|20)\d{2}$/.test(rg[2]!)) {
    // A spaced dash only joins a range when the first number is zero-padded: "Title 21 - 101" is episode 101.
    const spaced = /\s/.test(rg[3]!) && rg[3]!.includes('-');
    if (!spaced || rg[2]!.startsWith('0') || rg[2]!.length === rg[4]!.length) {
      const nums = [rg[2]!, rg[4]!, ...(rg[5] ?? '').split('-').filter(Boolean)].map(Number);
      const ver = rg[6] ? Number(rg[6]) : null;
      return build(ctx.text.slice(0, rg[1]!.length), ctx, (info) => {
        info.seasons = [0];
        info.absoluteEpisodes = episodeList(nums);
        if (ver) info.releaseVersion = ver;
      });
    }
  }

  // "Title - 01", "Title - 01v2", "Title - 12.5", "Title - 26.5.1", "Title-01[1280x720]"
  for (const m of s.matchAll(/(?:\s-\s+|(?<=[A-Za-z!])-)(\d{1,4})(\.\d(?:\.\d)?)?(?:\s?v(\d))?(?=\s*$|\s*[\[(]|\s+-|\s+(?:END|Fin)\b|\s+[A-Z]?[a-z]|\s+\d{3,4}p|\s+\d{3,4}x\d{3,4})/g)) {
    const before = s.slice(0, m.index!);
    if (!before.trim()) continue;
    // "Title - 100 Years Quest - 01": a number followed by a capitalised word is part of the title.
    const after = s.slice(m.index! + m[0].length);
    if (/^\s+[A-Z][a-z]/.test(after) && !/^\s+-/.test(after) && /\s-\s+\d/.test(after)) continue;
    if (!m[0].startsWith(' ') && !/^\s*\[/.test(after)) continue;
    const n = Number(m[1]);
    const decimal = m[2];
    const ver = m[3] ? Number(m[3]) : null;
    return shortSeasonTag(build(ctx.text.slice(0, before.length), ctx, (info) => {
      info.seasons = [0];
      if (decimal) {
        info.special = true;
      } else {
        info.absoluteEpisodes = [n];
      }
      if (ver) info.releaseVersion = ver;
      const seasonInTitle = /\s*\(Season\s+(\d{1,2})\)\s*$/i.exec(info.title);
      if (seasonInTitle) {
        info.seasons = [Number(seasonInTitle[1])];
        info.title = info.title.slice(0, seasonInTitle.index).trim();
      }
    }));
  }

  // Extras with no number: "Title - NCOP", "Another OVA - The Other"
  const extra = /^(.+?)\s+(?:-\s+)?(?:NCOP|NCED|OVA|OVD|Special)\b/i.exec(s);
  if (extra) return build(ctx.text.slice(0, extra[1]!.length), ctx, (info) => { info.seasons = [0]; info.special = true; });
  return null;
}

function animeSpaceNumber(ctx: Ctx): ParsedSeriesInfo | null {
  const s = ctx.loose;
  for (const m of s.matchAll(/(?<=\S)\s+(\d{2,4})(?:\s?v(\d))?(?=\s*$|\s*[\[(]|\s+-|\s+(?:END|Fin)\b|\s+\d{3,4}p|\s+\d{3,4}x\d{3,4})/g)) {
    const before = s.slice(0, m.index!);
    if (/(?:^|\s)S\d{1,2}(?:\s+\d{1,3})*$/i.test(before)) continue; // "Title S01 12 13 [..]": season pack
    if (/(?:^|\s)(?:Vol|Volume|Part|Pt)$/i.test(before)) continue; // "Title S03 Vol.02": partial season
    if (/^(?:19|20)\d{2}$/.test(m[1]!)) continue;
    const n = Number(m[1]);
    const ver = m[2] ? Number(m[2]) : null;
    return build(ctx.text.slice(0, before.length), ctx, (info) => {
      info.seasons = [0];
      info.absoluteEpisodes = [n];
      if (ver) info.releaseVersion = ver;
    });
  }
  // "[ACX]Series Title 01 Episode Name": a zero-padded number followed by words
  const zp = /(?<=\S)\s+(0[1-9]\d{0,2})\s+(?=[A-Za-z])(?!S\d)/.exec(s);
  if (zp) return build(ctx.text.slice(0, zp.index), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(zp[1])]; });
  return null;
}

// ---------------------------------------------------------------------------------------
// Season packs

const SEASON_WORD = String.raw`(?:S|Season|Seasons|Saison|Stagione|Temporada|Sezon)`;

/** "S01 04 (1080p": a second bare season number before the tags. */
const PAREN_SEASON = String.raw`[ ](?=\d{1,2}[ ][(\[])`;

function stripPackWords(raw: string): string {
  return raw.replace(/[-_. ]+(?:the[-_. ]+)?Complete(?:[-_. ]+Series)?[-_. ]*$/i, '');
}

function parseSeasonPack(ctx: Ctx): ParsedSeriesInfo | null {
  const t = ctx.text;
  const PRE = String.raw`(?<=^|[-_. \[(\/])`;

  // "Title S02 01" (no sub-group): season + bare episode at the end or before tags
  if (!ctx.subGroup) {
    const se = new RegExp(String.raw`^(.*?)${PRE}S(\d{1,2})[ ](\d{1,2})(?=$|[ ]\d{3,4}p)`, 'i').exec(t);
    if (se) return build(se[1]!, ctx, (info) => { info.seasons = [Number(se[2])]; info.episodes = [Number(se[3])]; });
    const abs = new RegExp(String.raw`^(.*?${PRE}S\d{1,2})[ ](\d{3,4})$`, 'i').exec(t);
    if (abs) return build(abs[1]!, ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(abs[2])]; });
  }

  // Multi-season: "S01-S05", "S01-04", "Season 1-5", "S01 S04", "S01 04 (1080p"
  const multi = new RegExp(String.raw`^(.*?)${PRE}${SEASON_WORD}[-_. ]?(\d{1,2})(?:-(?=\d)|[-_. ]*(?:-|to|thru|through)[-_. ]*(?=S)|[-_. ]+(?=S\d)|${ctx.subGroup ? '(?!)' : PAREN_SEASON})${SEASON_WORD}?[-_. ]?(\d{1,2})((?:[-_. ]+S\d{1,2})*)(?![\dEex])`, 'i').exec(t);
  if (multi) {
    const a = Number(multi[2]);
    const b = Number(multi[3]);
    const more = [...(multi[4] ?? '').matchAll(/\d{1,2}/g)].map((x) => Number(x[0]));
    if (b > a) {
      const seasons = more.length > 0 ? [a, b, ...more] : range(a, b);
      return build(stripPackWords(multi[1]!), ctx, (info) => { info.seasons = seasons; info.fullSeason = true; info.isMultiSeason = true; });
    }
  }

  // Partial: "S03 Part 2", "S06.P1", "S03 - Vol.02", "Season 1 Part 2"
  const part = new RegExp(String.raw`^(.*?)${PRE}${SEASON_WORD}[-_. ]?(\d{1,2})[-_. ]+(?:-[-_. ]*)?(?:Part|Pt|P|Vol(?:ume)?)[-_. ]?(\d{1,2})(?![\da-z])`, 'i').exec(t);
  if (part) return build(part[1]!, ctx, (info) => { info.seasons = [Number(part[2])]; info.isPartialSeason = true; info.seasonPart = Number(part[3]); });

  // Extras / sub packs
  const extras = new RegExp(String.raw`^(.*?)${PRE}${SEASON_WORD}[-_. ]?(\d{1,2})[-_. ]+(?:Extras|Bonus|SUBPACK|Featurettes|Behind[-_. ]the[-_. ]Scenes|Deleted[-_. ]Scenes)(?![a-z])`, 'i').exec(t);
  if (extras) return build(extras[1]!, ctx, (info) => { info.seasons = [Number(extras[2])]; info.fullSeason = true; info.isSeasonExtra = true; });

  // Season special: "Title.S02.Special-Inside..."
  const special = new RegExp(String.raw`^(.*?)${PRE}S(\d{1,2})[-_. ]+Special(?![a-z])`, 'i').exec(t);
  if (special) return build(special[1]!, ctx, (info) => { info.seasons = [Number(special[2])]; info.special = true; });

  // British "Title - Series 1 (1970)"
  const series = /^(.*?)[-_. ]+-[-_. ]+Series[-_. ]?(\d{1,2})(?![\dEex])(?=$|[-_. )\]\[(])/i.exec(t);
  if (series) return build(series[1]!, ctx, (info) => { info.seasons = [Number(series[2])]; info.fullSeason = true; });

  // Full season: "S01", "Season 1", "Saison3", "S2014", "(Season 04)", "[Sezon 3]", "(2016/S01/"
  const full = new RegExp(String.raw`^(.*?)${PRE}(?:${SEASON_WORD}[-_. ]?(\d{1,4})|(?:Season|Saison|Stagione|Temporada|Sezon)[-_. ]?(\d{1,2}))(?:(?:[ ]\d{1,3})+(?=[ ]?\[))?(?![\dEex])(?=$|[-_. )\]\/+\[(])`, 'i').exec(t);
  if (full) {
    const season = Number(full[2] ?? full[3]);
    return build(stripPackWords(full[1]!), ctx, (info) => { info.seasons = [season]; info.fullSeason = true; });
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Explicit absolute markers without a sub-group, combined numbers, plain absolute, mini

function parseExplicitAbsolute(ctx: Ctx): ParsedSeriesInfo | null {
  const s = ctx.loose;
  const t = ctx.text;
  const bp = ctx.broadcastPrefix;

  // "Title Season 39 ep11" handled by words; "Title ep34" / "Title #17" for broadcast names: season 1
  if (bp) {
    const m = /^(.*?)\s*(?:ep|#)\s?(\d{1,4})(?!\d)/i.exec(s);
    if (m) return build(t.slice(0, m[1]!.length), ctx, (info) => { info.seasons = [1]; info.episodes = [Number(m[2])]; });
  }

  // "Title EP06", "Title Episode 56", "Title Episodio 13", "Title S03 - EP14"
  const ep = /^(.+?)[\s-]+(?:EP|Episode|Episodio|Ep)\s?(\d{1,4})(?:-(\d{1,4}))?(?:\s?v(\d))?(?![\d])/.exec(s);
  if (ep) {
    const ver = ep[4] ? Number(ep[4]) : null;
    const a = Number(ep[2]);
    const abs = ep[3] ? range(a, Number(ep[3])) : [a];
    return build(t.slice(0, ep[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = abs; if (ver) info.releaseVersion = ver; });
  }
  // "Title e66" (lower-case e), "Title E1135" (3+ digits)
  const e = /^(.+?)\s(?:e(\d{1,4})|E(\d{3,4}))(?=\s|$)/.exec(s);
  if (e) return build(t.slice(0, e[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(e[2] ?? e[3])]; });
  // "Title #957", "Title (2010) {01}"
  const hash = /^(.+?)\s(?:#(\d{1,4})|\{(\d{1,4})\})(?=\s|$)/.exec(s);
  if (hash) return build(t.slice(0, hash[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(hash[2] ?? hash[3])]; });
  // French fansubs: "Title 484 VOSTFR"
  const vf = /^(.+?)\s(\d{2,4})\s+(?:VOSTFR|VF)\b/i.exec(s);
  if (vf) return build(t.slice(0, vf[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(vf[2])]; });
  return null;
}

function parseEpisodeOnly(ctx: Ctx): ParsedSeriesInfo | null {
  // "Title E04", "Title? E11-E12", "E05-06 - Episode Title" (season 1 implied)
  const m =
    /^(.*?)(?<=^|[-_. ])E(\d{1,2})((?:[-_. ]?-?[-_. ]?E?\d{1,2})*)(?![\da-z])/.exec(ctx.text) ??
    new RegExp(String.raw`^(.*?)(?<=[-_. ])e(0\d)()(?=$|[-_. ]+(?:${TAG}|$))`).exec(ctx.text);
  if (!m) return null;
  const nums = [Number(m[2]), ...[...(m[3] ?? '').matchAll(/\d{1,2}/g)].map((x) => Number(x[0]))];
  return build(m[1]!, ctx, (info) => { info.seasons = [1]; info.episodes = episodeList(nums); });
}

function parseCombined(ctx: Ctx): ParsedSeriesInfo | null {
  const t = ctx.text;
  // "Series.10708" / "E.010910": season + two episodes
  const multi5 = /^(.+?)[-_. ](0?[1-9])(\d{2})(\d{2})(?=[-_. ]|$)/.exec(t);
  if (multi5 && Number(multi5[4]) === Number(multi5[3]) + 1) {
    return build(multi5[1]!, ctx, (info) => { info.seasons = [Number(multi5[2])]; info.episodes = [Number(multi5[3]), Number(multi5[4])]; });
  }
  // "Title.103.104"
  const pair = /^(.+?)[-_. ]([1-9])(\d{2})[-_. ]\2(\d{2})(?=[-_. ]|$)/.exec(t);
  if (pair) return build(pair[1]!, ctx, (info) => { info.seasons = [Number(pair[2])]; info.episodes = range(Number(pair[3]), Number(pair[4])); });
  // "Title.103", "Title.1013", "this.is.a.show.2015.0308"
  for (const m of t.matchAll(/(?<=[-_. ])(0?[1-9]|[1-9]\d)(\d{2})(?=[-_. ]|$)/g)) {
    const full = m[0];
    const title = t.slice(0, m.index!);
    if (!title.trim()) continue;
    if (/^(?:19|20)\d{2}$/.test(full)) continue;
    if (/[hx][-_. ]?$/i.test(title)) continue; // "H.264" / "x 265"
    const after = t.slice(m.index! + full.length);
    if (/^[pi]/i.test(after)) continue;
    if (/^(?:480|576|720|1080|2160)$/.test(full)) continue;
    const ep = Number(m[2]);
    if (ep === 0) continue;
    // Only accept at the end of the name, before tags, or before an episode title word.
    if (!(after === '' || TAG_AHEAD.test(after) || /^[-_. ]+[A-Za-z]/.test(after) || /^[-_. ]*$/.test(after))) continue;
    return build(title, ctx, (info) => { info.seasons = [Number(m[1])]; info.episodes = [ep]; });
  }
  return null;
}

function parseDashAbsolute(ctx: Ctx): ParsedSeriesInfo | null {
  const s = ctx.loose;
  const t = ctx.text;
  // "Title - 031 - Episode", "My Series - 158 [h264]"
  const dash = /^(.+?)\s-\s(\d{2,4})((?:-\d{2,4})*)(?:\s?v(\d))?(?=$|\s*[\[(]|\s+-\s)/.exec(s);
  if (dash && !/^(?:19|20)\d{2}$/.test(dash[2]!)) {
    const ver = dash[4] ? Number(dash[4]) : null;
    const nums = [dash[2]!, ...(dash[3] ?? '').split('-').filter(Boolean)].map(Number);
    return build(t.slice(0, dash[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = episodeList(nums); if (ver) info.releaseVersion = ver; });
  }
  // "Some Anime Show 1-13 (English Dub)", "Series Title 921-928 [English Dub]"
  const rg = /^(.+?)\s(\d{1,4})-(\d{1,4})(?=\s*[\[(])/.exec(s);
  if (rg && Number(rg[3]) > Number(rg[2]) && !/^(?:19|20)\d{2}$/.test(rg[2]!)) {
    return build(t.slice(0, rg[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = range(Number(rg[2]), Number(rg[3])); });
  }
  return null;
}

function parsePlainAbsolute(ctx: Ctx): ParsedSeriesInfo | null {
  const s = ctx.loose;
  const t = ctx.text;
  // "Title 2018 06 720p": a 2-3 digit number right before quality tags
  const q = new RegExp(String.raw`^(.+?)\s(\d{2,3})\s(?=${TAG})`, 'i').exec(s);
  if (q && !/(?:Part|Pt)$/i.test(q[1]!)) return build(t.slice(0, q[1]!.length), ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(q[2])]; });
  return null;
}

function parseMini(ctx: Ctx): ParsedSeriesInfo | null {
  const t = ctx.text;
  const part = /^(.+?)[-_. ]+Part[-_. ]?(\d{1,2}|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)(?:[-_. ]*\(?of[-_. ]*\d{1,2}\)?)?(?![a-z\d])/.exec(t);
  if (part && !/\([^)]*$/.test(part[1]!)) {
    const raw = part[2]!.toLowerCase();
    const n = NUMBER_WORDS[raw] ?? Number(raw);
    return build(part[1]!, ctx, (info) => { info.seasons = [1]; info.episodes = [n]; info.isMiniSeries = true; });
  }
  const of = /^(.+?)[-_. ]+\(?(\d{1,2})[-_. ]?of[-_. ]?\d{1,2}\)?(?![a-z\d])/i.exec(t);
  if (of) return build(of[1]!, ctx, (info) => { info.seasons = [1]; info.episodes = [Number(of[2])]; info.isMiniSeries = true; });
  return null;
}

/** Turkish: "Show 60.Bolum (31.01.2023)", "Show 1. Bölüm", "Show 79.BLM", "Show 01 BLM(" — before dates. */
function parseTurkish(ctx: Ctx): ParsedSeriesInfo | null {
  const tr = /^(.+?)\s(\d{1,4})\.?\s?(?:B[oö]l[uü]m|BLM|Blm)(?![a-z])/i.exec(ctx.text.replace(/_/g, ' '));
  if (!tr) return null;
  return build(tr[1]!, ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = [Number(tr[2])]; });
}

/** "Series_Title_2_[01]_[AniLibria_TV]": bracketed episode number without a sub-group. */
function parseInlineBracket(ctx: Ctx): ParsedSeriesInfo | null {
  if (ctx.subGroup) return null;
  const m = /^([^\[]+?)_\[(\d{1,4})(?:-(\d{1,4}))?\]/.exec(ctx.text);
  if (!m) return null;
  const a = Number(m[2]);
  const abs = m[3] ? range(a, Number(m[3])) : [a];
  return build(m[1]!, ctx, (info) => { info.seasons = [0]; info.absoluteEpisodes = abs; });
}

/** Korean broadcast rips: "Show.E56.190121.720p-NEXT" — episode then air date (yymmdd). */
function parseBroadcastEpisode(ctx: Ctx): ParsedSeriesInfo | null {
  const m = /^(.+?)[-_. ]E(\d{1,4})(?:-E?(\d{1,4}))?[-_. ](\d{2})(\d{2})(\d{2})(?=[-_. ]|$)/i.exec(ctx.text);
  if (!m || !isValidDate(2000 + Number(m[4]), Number(m[5]), Number(m[6]))) return null;
  const first = Number(m[2]);
  const eps = m[3] ? range(first, Number(m[3])) : [first];
  return build(m[1]!, ctx, (info) => { info.seasons = [1]; info.episodes = eps; });
}

/** A date-shaped token that failed validation means "do not guess": "Show 1950 10 14". */
const DATE_SHAPED = /(?<!\d)(?:(?:19|20)\d{2}([-_. ])\d{1,2}\1\d{1,2}|\d{1,2}([-_. ])\d{1,2}\2(?:19|20)\d{2})(?!\d)/;

/** "11-02 The Series Reaction (HD)": season-episode at the very start. */
function parseLeadingPair(ctx: Ctx): ParsedSeriesInfo | null {
  const m = /^(\d{1,2})-(\d{2})\s+(?=[A-Za-z])/.exec(ctx.text);
  if (!m) return null;
  return build('', ctx, (info) => { info.seasons = [Number(m[1])]; info.episodes = [Number(m[2])]; });
}

// ---------------------------------------------------------------------------------------
// Entry points

function acceptable(info: ParsedSeriesInfo | null, ctx: Ctx): ParsedSeriesInfo | null {
  if (!info) return null;
  if (!info.title && !ctx.subGroup) {
    // An empty title is fine for "S01E05 - Name" style file names, not for anything vaguer.
    const hasNumbers = info.episodes.length > 0 || info.airDate !== null || info.absoluteEpisodes.length > 0;
    if (!hasNumbers) return null;
  }
  return info;
}

/** Sentinel a step returns to stop the cascade without a result. */
const REJECT: ParsedSeriesInfo = emptyInfo();

export function parseSeries(releaseTitle: string): ParsedSeriesInfo | null {
  const ctx = prepareSeries(releaseTitle);
  if (!ctx.text.trim() && !ctx.subGroup) return null;

  const steps: Array<(c: Ctx) => ParsedSeriesInfo | null> = [
    parseBracketLayout,
    parseLeadingPair,
    parseBroadcastEpisode,
    parseTurkish,
    parseStrong,
    (c) => (DATE_SHAPED.test(c.text) ? REJECT : null),
  ];
  if (ctx.subGroup) steps.push(animeDashParts, animeSpaceNumber);
  steps.push(parseInlineBracket, parseExplicitAbsolute, parseDashAbsolute, parseSeasonPack, parseEpisodeOnly, parseCombined, parsePlainAbsolute, parseMini);

  for (const step of steps) {
    const raw = step(ctx);
    if (raw === REJECT) return null;
    const info = acceptable(raw, ctx);
    if (info) {
      cjkEpisodeRange(info, releaseTitle);
      return info;
    }
  }
  return null;
}

/** "当我飞奔向你[第01-15集]...S01": a CJK episode range in a season-pack name. */
function cjkEpisodeRange(info: ParsedSeriesInfo, raw: string): void {
  if (!info.fullSeason || info.seasons.length !== 1) return;
  const m = /\[第(\d{1,3})-(\d{1,3})集\]/.exec(raw);
  if (!m) return;
  info.episodes = range(Number(m[1]), Number(m[2]));
  info.fullSeason = false;
}

/**
 * Season-less anime batch titles ("[Group] Title (BDRip 1080p) [hash]"): the whole name is
 * the series title. Returns null when stripping leaves only metadata or the release is an
 * extra (OVA, NCOP, NCED, Special).
 */
export function parseSeasonTitle(releaseTitle: string): { title: string; fullSeason: true } | null {
  const ctx = prepareSeries(releaseTitle);
  if (!ctx.subGroup && !/\[[^\]]*\]\s*$/.test(ctx.text)) {
    // Without a group prefix only "Title [tags]" qualifies.
    if (!/^[^\[(]+[\[(]/.test(ctx.text)) return null;
  }
  const t = ctx.text.trim();
  if (t.startsWith('[') || t.startsWith('(')) return null;
  const m = /^([^\[(]+?)\s*[\[(]/.exec(t);
  const title = (m ? m[1]! : t).trim();
  if (!title) return null;
  const rest = t.slice(title.length);
  if (/[\[(]\s*(?:OVA|OVD|NCOP|NCED|Special|SP)\s*[\])]/i.test(rest)) return null;
  if (/\(\s*\)/.test(rest)) return null;
  return { title, fullSeason: true };
}
