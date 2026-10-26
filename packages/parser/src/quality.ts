import { QUALITIES, type QualityDefinition, type Resolution } from '@arclight/shared';
import type { ParsedQuality } from './types.js';

// Quality detection.
//
// 1. Revision (PROPER / REPACK / RERIP / REAL / vN) is read independently of everything else.
// 2. The *source* is the right-most source token in the name ("x264.WEB-DL.REPACK.BluRay" is a
//    BluRay). Tokens are tried left to right in one scan so a longer token ("HD-DVD") is consumed
//    before a shorter one inside it ("DVD") can claim the same characters.
// 3. The *resolution* is the left-most resolution token; "UHD"/"[4K]" only count when nothing
//    more specific is present.
// 4. Source + resolution (+ remux / full-disc flags) pick a definition from the shared vocabulary.
//    Without a source word we fall back, in order, to anime bracket conventions, the resolution
//    alone (using the file extension as the source when there is one), codec hints, and finally
//    the extension by itself.

type SourceKind =
  | 'bluray'
  | 'webdl'
  | 'webrip'
  | 'hdtv'
  | 'bdrip'
  | 'dvdr'
  | 'dvd'
  | 'lowtv' // PDTV / SDTV / DSR / TVRip: broadcast captures whose resolution is usually implied
  | 'regional'
  | 'screener'
  | 'telesync'
  | 'telecine'
  | 'cam'
  | 'workprint';

/** A separator or the edge of the string; used to keep tokens from matching inside words. */
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;

// Ordered: at a given position the first listed kind wins.
const SOURCE_TOKENS: ReadonlyArray<readonly [SourceKind, string]> = [
  ['bdrip', String.raw`${L}(?:BDRip|BD-?Light|BRRip|HD[-. ]?DVD-?Rip|UHD-?BD-?Rip)${R}`],
  ['webrip', String.raw`${L}(?:WEB-?Rip|WEB-?Mux)${R}`],
  ['webdl', String.raw`${L}(?:WEB[-. ]?DL(?:-?Rip|Mux)?)${R}`],
  ['webdl', String.raw`${L}(?:Amazon|Netflix|NetflixU|iTunes|Maxdome|Web|HBOMax|Disney)HD${R}|${L}AmazonSD${R}`],
  // A bare "WEB" is only trusted when something around it says it is the source tag.
  ['webdl', String.raw`(?<=[\p{L}\p{N}])[. ]WEB[. ](?=(?:[xh][ .]?26[4-6]|AVC|HEVC|E?AC3|DDP?[ .]?[25][. ][01])${R})`],
  ['webdl', String.raw`(?<=\d{3,4}p)[-. ](?:Hybrid[-. ])?WEB(?=[-. ])`],
  ['webdl', String.raw`[-. ]WEB(?=[-. ]\d{3,4}p${R})`],
  ['webdl', String.raw` / WEB(?= / )`],
  ['webdl', String.raw`${L}(?:AMZN|ATVP|DSNP|DP|NF|HMAX|PCOK|HULU)[. -]WEB(?=[. -](?!Rip))`],
  ['bluray', String.raw`${L}(?:M?Blu[-. ]?Ray|HD[-. ]?DVD|UHD2?BD|BD(?:ISO|Mux|25|50|66|100)|BD(?=[^\p{L}\p{N}]*.)|BR[-. ]?DISK)${R}`],
  ['hdtv', String.raw`${L}HDTV${R}`],
  ['screener', String.raw`${L}(?:DVD-?SCR(?:EENER)?|SCREENER|SCR)${R}`],
  ['dvdr', String.raw`${L}\d?x?M?DVD-?[R59]${R}`],
  ['dvd', String.raw`${L}(?:DVD(?:-?Rip)?|xvidvd)${R}`],
  ['lowtv', String.raw`${L}(?:(?:WS[-. ])?DSR|PDTV|SDTV|TV-?Rip)${R}`],
  ['regional', String.raw`${L}(?:R\d|REGIONAL)${R}`],
  ['telesync', String.raw`${L}(?:TELESYNCH?|HD-?TS(?:Rip)?|TS-?Rip|PDVD|TS(?=[-. ]))${R}`],
  ['telecine', String.raw`${L}(?:TELECINE|HD-?TC|TC)${R}`],
  ['cam', String.raw`${L}(?:(?:NEW|HQ|HD)?-?CAM(?:-?Rip)?)${R}`],
  ['workprint', String.raw`${L}(?:WORKPRINT|WP)${R}`],
];

const SOURCE_SCAN = new RegExp(SOURCE_TOKENS.map(([, p], i) => `(?<s${i}>${p})`).join('|'), 'giu');

/** "WEB" as the very last word, upper-case only ("The.Web.MT" is a title). */
const TRAILING_WEB = /[. ]WEB\.*$/;
/** PAL / NTSC say "DVD" only when nothing more specific does. */
const DVD_STANDARD = /(?<![a-z0-9])(?:NTSC|PAL)(?![a-z0-9])/i;

const RAW_HD = /(?<![a-z0-9])Raw[-. ]?HD(?![a-z0-9])/i;
const MPEG2 = /(?<![a-zA-Z0-9])MPEG[-. ]?2(?![0-9])/; // case-sensitive on purpose: the tag is always upper-case
const XVID_DIVX = /(?<![a-z0-9])(?:X-?vid|DivX)(?![a-z0-9])/i;
const X264 = /(?<![a-z0-9])x264(?![a-z0-9])/i;
const HR_WS = /(?<![a-z0-9])hr[-. ]ws(?![a-z0-9])/i;
const OTHER_TV = /(?<![a-z0-9])(HD|SD)[-. ]TV(?![a-z0-9])/i;

// Anime bracket conventions, used only when the main scan found no source.
const ANIME_BD = /bd(?:720|1080|2160)|(?<=[-. ([])bd(?=[-. )\]])/i;
const ANIME_WEB = /\[WEB\]|[[(]WEB[ .]/i;
const GLUED_BLURAY = /bluray(720|1080|2160)p/i;

const RESOLUTION_TOKENS: ReadonlyArray<readonly [Resolution, string]> = [
  [360, '360p'],
  [480, '480[pi]|640x480|848x480'],
  [540, '540p'],
  [576, '576[pi]'],
  [720, '720p|1280x720|960p'],
  [1080, '1080[pi]|1920x1080|1440p|FHD|4kto1080p'],
  [2160, String.raw`2160p|3840x2160|4k[-. ](?:UHD|HEVC|BD|H\.?26[56])|(?:UHD|HEVC|BD|H\.?26[56])[-. ]4k`],
];
const RESOLUTION_SCAN = new RegExp(
  String.raw`(?<![a-z0-9])(?:${RESOLUTION_TOKENS.map(([, p], i) => `(?<r${i}>${p})`).join('|')})(?![a-z0-9])`,
  'i',
);
const RESOLUTION_HINT_2160 = /(?<![a-z0-9])UHD(?![a-z0-9])|\[4K\]/i;

// Full Blu-ray / HD-DVD discs (movies). A disc is a bluray-ish source plus a disc codec or
// container, or an explicit disc marker, and none of the signs of an encode.
const DISC_SOURCE = /(?<![a-z0-9])(?:Blu[-. ]?ray|BD|HD[-. ]?DVD)(?![a-z0-9])/i;
const DISC_CODEC = /(?<![a-z0-9])(?:AVC|HEVC|VC[-. ]1|MVC|MPEG[-. ]?2|BDMV|ISO)(?![a-z0-9])/i;
const DISC_MARKER =
  /(?<![a-z0-9])(?:3D[-. ]?BD|BR[-. ]?DISK|Full[-. ]?Blu[-. ]?ray|BD[-. ]?Full|(?:BD|UHD)[-. ]?(?:25|50|66|100|ISO))(?![a-z0-9])/i;
const DISC_COMPLETE = /(?<![a-z0-9])(?:COMPLETE|Dis[ck])(?![a-z0-9])/i;
const DISC_COMPLETE_SOURCE = /(?<![a-z0-9])(?:Blu[-. ]?ray|HD[-. ]?DVD)(?![a-z0-9])/i;
const ENCODE_SIGNS =
  /(?<!HD[-. ])(?<![a-z0-9])DVD(?![a-z0-9])|(?<![a-z0-9])(?:BDRip|720p|MKV|XviD|WMV|d3g|(?:BD)?REMUX|[xh][-. ]?26[45])(?![a-z0-9])/i;
const GERMAN_DUAL = /(?<![a-z0-9])German(?![a-z0-9]).*(?<![a-z0-9])[DM]L(?![a-z0-9])/i;
// German scene releases tag untouched Blu-ray streams "German ... AVC ... BluRay": a remux.
const GERMAN_STREAM = /\d{4}(?![0-9]).*(?<![a-z0-9])German(?![a-z0-9])(?=.*(?<![a-z0-9])(?:AVC|HEVC|VC[-. ]?1|MVC|MPEG[-. ]?2)(?![a-z0-9]))/i;
const GERMAN_REMUX = new RegExp(GERMAN_STREAM.source + String.raw`(?=.*(?<![a-z0-9])Blu-?ray(?![a-z0-9]))`, 'i');

const REMUX = /(?:^|[ .[]|\d{3,4}p-|Hybrid-)(?:BD|UHD)?[-. ]?Remux(?![a-z0-9])|(?<![a-z0-9])(?:BD|UHD)?Remux[. ]\d{3,4}p/i;

const PROPER = /(?<![a-z0-9])proper(?![a-z0-9])/i;
const REPACK = /(?<![a-z0-9])(?:repack|rerip)(\d)?(?![a-z0-9])/i;
const VERSION = /\d[-. ]?v(\d)(?=[-. \]]|$)|\[v(\d)\]|\d{3,4}p[. ]v(\d)(?![0-9])/i;
const REAL = /(?<![A-Za-z0-9])REAL(?![A-Za-z0-9])/g; // case-sensitive: "Real" in a title is not a flag

const EXTENSION = /\.([a-z0-9]{2,4})$/i;

export function parseRevision(title: string): ParsedQuality['revision'] {
  const name = title.replace(/_/g, ' ');
  const v = VERSION.exec(name);
  const explicit = v ? Number(v[1] ?? v[2] ?? v[3]) : null;
  const repack = REPACK.exec(name);
  const repackNumber = repack?.[1] ? Number(repack[1]) : null;

  let version = explicit ?? 1;
  if (PROPER.test(name)) version = (explicit ?? 1) + 1;
  if (repack) version = (repackNumber ?? explicit ?? 1) + 1;

  return { version, real: title.match(REAL)?.length ?? 0, isRepack: Boolean(repack) };
}

function lastSource(name: string): { kind: SourceKind; index: number } | null {
  let found: { kind: SourceKind; index: number } | null = null;
  for (const m of name.matchAll(SOURCE_SCAN)) {
    const groups = m.groups ?? {};
    const i = SOURCE_TOKENS.findIndex((_, idx) => groups[`s${idx}`] !== undefined);
    if (i >= 0) found = { kind: SOURCE_TOKENS[i]![0], index: m.index };
  }
  const web = TRAILING_WEB.exec(name);
  if (web && (!found || web.index >= found.index)) found = { kind: 'webdl', index: web.index };
  if (!found && DVD_STANDARD.test(name)) found = { kind: 'dvd', index: 0 };
  return found;
}

function parseResolution(name: string): Resolution {
  const m = RESOLUTION_SCAN.exec(name);
  if (m?.groups) {
    const i = RESOLUTION_TOKENS.findIndex((_, idx) => m.groups![`r${idx}`] !== undefined);
    if (i >= 0) return RESOLUTION_TOKENS[i]![0];
  }
  return RESOLUTION_HINT_2160.test(name) ? 2160 : 0;
}

function isFullDisc(name: string, extension: string | null): boolean {
  if (ENCODE_SIGNS.test(name)) return false;
  if (/(?<![a-z0-9])1080p(?![a-z0-9])/i.test(name) && /(?<![a-z0-9])HEVC(?![a-z0-9])/i.test(name)) return false;
  if (GERMAN_DUAL.test(name) || GERMAN_STREAM.test(name)) return false;
  if (DISC_SOURCE.test(name) && (DISC_CODEC.test(name) || extension === 'iso')) return true;
  if (DISC_MARKER.test(name)) return true;
  return DISC_COMPLETE.test(name) && DISC_COMPLETE_SOURCE.test(name);
}

const SD_RESOLUTIONS: ReadonlySet<Resolution> = new Set<Resolution>([360, 480, 540, 576]);

/** The definition for a capture source at a resolution, snapping odd SD sizes to 480p. */
function bySource(source: 'television' | 'web' | 'webRip' | 'bluray' | 'blurayRaw' | 'dvd', resolution: Resolution): QualityDefinition {
  const Q = QUALITIES;
  const sd = SD_RESOLUTIONS.has(resolution) || resolution === 0;
  switch (source) {
    case 'television':
      return resolution === 2160 ? Q['HDTV-2160p'] : resolution === 1080 ? Q['HDTV-1080p'] : resolution === 720 ? Q['HDTV-720p'] : Q.SDTV;
    case 'web':
      return resolution === 2160 ? Q['WEBDL-2160p'] : resolution === 1080 ? Q['WEBDL-1080p'] : resolution === 720 ? Q['WEBDL-720p'] : Q['WEBDL-480p'];
    case 'webRip':
      return resolution === 2160 ? Q['WEBRip-2160p'] : resolution === 1080 ? Q['WEBRip-1080p'] : resolution === 720 ? Q['WEBRip-720p'] : Q['WEBRip-480p'];
    case 'bluray':
      if (resolution === 576) return Q['Bluray-576p'];
      return resolution === 2160 ? Q['Bluray-2160p'] : resolution === 1080 ? Q['Bluray-1080p'] : resolution === 720 ? Q['Bluray-720p'] : Q['Bluray-480p'];
    case 'blurayRaw':
      // There is no SD/720p remux definition: those are plain Blu-ray rips.
      if (resolution === 2160) return Q['Remux-2160p'];
      if (resolution === 1080) return Q['Remux-1080p'];
      return bySource('bluray', resolution);
    case 'dvd':
      return sd ? Q.DVD : bySource('bluray', resolution);
  }
}

function qualityFromExtension(ext: string | null): QualityDefinition | null {
  switch (ext) {
    case 'mkv':
    case 'ts':
    case 'wtv':
      return QUALITIES['HDTV-720p'];
    case 'm2ts':
      return QUALITIES['Bluray-720p'];
    case 'avi':
    case 'xvid':
    case 'divx':
    case 'mpg':
    case 'mpeg':
    case 'wmv':
    case 'mp4':
    case 'm4v':
    case 'mov':
    case 'ogm':
    case 'flv':
    case 'asf':
    case 'rm':
    case 'rmvb':
    case '3gp':
      return QUALITIES.SDTV;
    case 'iso':
    case 'img':
    case 'vob':
      return QUALITIES.DVD;
    default:
      return null; // includes webm: the container says nothing about the source
  }
}

interface Detected {
  quality: QualityDefinition;
  source: ParsedQuality['detectionSource'];
}

function detect(name: string, extension: string | null): Detected {
  const Q = QUALITIES;
  const named = (quality: QualityDefinition): Detected => ({ quality, source: 'name' });

  const fullDisc = isFullDisc(name, extension);
  if (RAW_HD.test(name) && !fullDisc) return named(Q['Raw-HD']);

  const resolution = parseResolution(name);
  const remux = REMUX.test(name) || GERMAN_REMUX.test(name);
  const src = lastSource(name);

  if (src) {
    switch (src.kind) {
      case 'bluray':
        if (fullDisc) return named(Q['BR-DISK']);
        if (XVID_DIVX.test(name)) return named(Q['Bluray-480p']);
        if (resolution === 0) return named(remux ? Q['Remux-1080p'] : Q['Bluray-720p']);
        return named(bySource(remux ? 'blurayRaw' : 'bluray', resolution));
      case 'webdl':
        if (resolution === 0 && name.includes('[WEBDL]')) return named(Q['WEBDL-720p']);
        return named(bySource('web', resolution));
      case 'webrip':
        return named(bySource('webRip', resolution));
      case 'hdtv':
        if (MPEG2.test(name)) return named(Q['Raw-HD']);
        if (resolution === 0 && name.includes('[HDTV]')) return named(Q['HDTV-720p']);
        return named(bySource('television', resolution));
      case 'bdrip':
        return named(bySource('bluray', resolution === 0 ? 480 : resolution));
      case 'dvdr':
        return named(Q['DVD-R']);
      case 'dvd':
        return named(Q.DVD);
      case 'lowtv':
        if (resolution === 1080 || /1080p/i.test(name)) return named(Q['HDTV-1080p']);
        if (resolution === 720 || /720p/i.test(name) || HR_WS.test(name)) return named(Q['HDTV-720p']);
        return named(Q.SDTV);
      case 'screener':
        return named(Q.DVDSCR);
      case 'regional':
        return named(Q.REGIONAL);
      case 'telesync':
        // Telesyncs are graded by their capture resolution, so keep it when the name has one.
        return named(resolution ? { ...Q.TELESYNC, resolution } : Q.TELESYNC);
      case 'telecine':
        return named(Q.TELECINE);
      case 'cam':
        return named(Q.CAM);
      case 'workprint':
        return named(Q.WORKPRINT);
    }
  }

  // A remux tag with a resolution but no source word is a Blu-ray remux.
  if (remux && resolution !== 0 && !SD_RESOLUTIONS.has(resolution)) {
    return { quality: bySource('blurayRaw', resolution), source: 'unknown' };
  }
  if (remux && resolution === 480) return { quality: Q['Bluray-480p'], source: 'unknown' };

  if (ANIME_BD.test(name)) {
    if (SD_RESOLUTIONS.has(resolution) || /480p/i.test(name)) return named(Q.DVD);
    const r: Resolution = resolution === 1080 || /1080p/i.test(name) ? 1080 : resolution === 2160 || /2160p/i.test(name) ? 2160 : 720;
    if (r === 720) return named(remux ? Q['Remux-1080p'] : Q['Bluray-720p']);
    return named(bySource(remux ? 'blurayRaw' : 'bluray', r));
  }
  if (ANIME_WEB.test(name)) {
    if (SD_RESOLUTIONS.has(resolution) || /480p/i.test(name)) return named(Q['WEBDL-480p']);
    if (resolution === 1080 || /1080p/i.test(name)) return named(Q['WEBDL-1080p']);
    if (resolution === 2160 || /2160p/i.test(name)) return named(Q['WEBDL-2160p']);
    return named(Q['WEBDL-720p']);
  }

  if (resolution !== 0) {
    if (remux) return named(bySource('blurayRaw', resolution));
    const byExt = qualityFromExtension(extension);
    if (byExt) {
      const s = byExt.source === 'bluray' ? 'bluray' : byExt.source === 'dvd' ? 'dvd' : 'television';
      return { quality: bySource(s, resolution), source: 'extension' };
    }
    return { quality: bySource('television', resolution), source: 'unknown' };
  }

  if (X264.test(name)) return { quality: Q.SDTV, source: 'unknown' };

  const glued = GLUED_BLURAY.exec(name);
  if (glued) return named(bySource('bluray', Number(glued[1]) as Resolution));

  const other = OTHER_TV.exec(name);
  if (other) return named(other[1]!.toUpperCase() === 'HD' ? Q['HDTV-720p'] : Q.SDTV);

  const byExt = qualityFromExtension(extension);
  if (byExt) return { quality: byExt, source: 'extension' };
  return { quality: Q.Unknown, source: 'unknown' };
}

/**
 * Parse the quality of a release or file name. `extension` is the media file extension (without
 * the dot) when the caller already split it off; otherwise a trailing extension is detected here.
 */
export function parseQuality(releaseTitle: string, extension: string | null = null): ParsedQuality {
  let title = releaseTitle.trim();
  let ext = extension?.toLowerCase() ?? null;
  if (!ext) {
    const m = EXTENSION.exec(title);
    if (m && qualityFromExtension(m[1]!.toLowerCase()) !== null) {
      ext = m[1]!.toLowerCase();
      title = title.slice(0, m.index);
    } else if (m && m[1]!.toLowerCase() === 'webm') {
      ext = 'webm';
      title = title.slice(0, m.index);
    }
  }
  const name = title.replace(/_/g, ' ').trim();
  const { quality, source } = detect(name, ext);
  return { quality, revision: parseRevision(title), detectionSource: source };
}
