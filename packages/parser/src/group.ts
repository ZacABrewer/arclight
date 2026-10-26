// Release group detection. Where a group can sit, in the order we look:
//
//   [Group] Title - 01 [1080p]                  anime prefix
//   ... [Softsubs (Group)]                      anime batch naming
//   ... x264-Group                              scene suffix (after junk suffixes are peeled off)
//   ... [Group]                                 trailing bracket tag
//   ... (1080p BluRay x265 Group)               encoder tag inside the last parenthesis; only for
//                                               groups known to sign that way, since any word
//                                               could otherwise be taken for a group
//   ... (1080p WEB-DL English - Group)          " - Group" closing the last parenthesis
//
// A trailing bracket that is clearly not a group ("[x264]", "[v2]", "[HDTV-720p]") means the
// release has no group: we do not reach past it for a "-Word" that is probably a title word.

const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;

// Reposters, indexers and obfuscation tools append their own tag after the real group. An
// indexer name is only junk when a group precedes it ("x264-NZBgeek" is all we have).
const JUNK_SUFFIX = new RegExp(
  String.raw`(?:(?<=-[\p{L}\p{N}_]+)-(?:NZBgeek|NZBFinder)|-(?:RP|Pre|Obfuscat(?:ed|ion)|Scrambled|postbot|xpost|sample|Rakuv[\p{L}\p{N}]*|WhiteRev|BUYMORE|AsRequested|AlternativeToRequested|GEROV|Z0iDS3N|Chamele0n|4P|4Planet|AlteZachen|RePACKPOST|\d{1,2})|-?\[N-Z-B\]|\.(?:mkv|mp4|avi|m4v|ts)|-)$`,
  'iu',
);
// Languages some posters glue after the group: "-SKGTV English".
const TRAILING_LANGUAGE = /[ ._](?:English|French|German|Spanish|Italian|Dutch|Multi)$/i;
// Tracker/indexer bracket tags that are never the group.
const TRACKER_TAG = /\s*\[(?:eztv|ettv|rartv|rarbg|TGx|PublicHD|ETRG|CTRG|GloDLS|AT-TEAM|SPARROW)\]\s*$/i;
const SITE_TAG = /\s*[-–]?\s*\[\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|info|biz|to|tv|cc|me|io|ws|xyz|ru|club|site)\s*\]\s*$/i;
const SITE_PREFIX = /^\s*\[\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|info|biz|to|tv|cc|me|io|ws|xyz|ru|club|site)\s*\]\s*[-–]?\s*/i;
const HASH_TAG = /\s*\[[a-f0-9]{8}\]\s*$/i;
const FILE_EXTENSION = /\.(?:mkv|mp4|avi|m4v|ts|m2ts|wmv|mov|webm|mpg|mpeg|divx|xvid|iso|img|srt|sub|idx|nfo)$/i;

// Groups that sign in ways the generic rules cannot see (spaces, dots, no separator). Group
// names are data; matching keeps the case written in the release.
const SIGNED_ANYWHERE = [
  'QxR', 'TAoE', 'UTR', 'KCRT', 'YIFY', String.raw`YTS(?:\.[A-Z]{2})?`, String.raw`E\.N\.D`, 'BEN[ .]THE[ .]MEN',
  'EML HDTeam', 'HQMUX', 'KRaLiMaRKo', 'BluDragon', 'LMain', 'TMd', 'Vialle',
];
const SIGNED_IN_PARENS = [
  'Tigole', 'Joy', 'ImE', 't3nzin', 'Vyndros', 'Garshasp', 'Kappa', 'Natty', 'RCVR', 'SAMPA', 'YOGI', 'r00t', 'EDGE2020',
  'Silence', 'afm72', 'Panda', 'Ghost', 'MONOLITH', 'Anna', 'Bandi', 'Qman', 'RZeroX', 'FreetheFish', 'theincognito', 'Celdra',
];
const ANYWHERE_RE = new RegExp(String.raw`(?:^|[-. ([])(${SIGNED_ANYWHERE.join('|')})[)\]]*$`, 'i');
const PARENS_RE = new RegExp(String.raw`[ .](${SIGNED_IN_PARENS.join('|')})[)\]]+$`, 'i');

// Scene groups whose name contains a hyphen.
const HYPHENATED = ['Erai-raws', 'D-Z0N3', 'Fight-BB', 'Blu-bits', 'DX-TV', 'FTW-HS', 'VH-PROD', 'Tenrai-Sensei', 'Anime-Koi', 'Exiled-Destiny'];
const HYPHENATED_RE = new RegExp(String.raw`(?:^|[-. ])(${HYPHENATED.join('|')})$`, 'i');

const SCENE_GROUP = new RegExp(String.raw`-([\p{L}\p{N}_]+)$`, 'u');
const TRAILING_BRACKET = /\[([^[\]]*)\]\)?$/;
const LAST_PAREN_DASH = new RegExp(String.raw`\([^()]*\s-\s?([\p{L}\p{N}_]+)\)$`, 'u');
const SOFTSUBS = /\[Softsubs \(([^)]+)\)\]?$/i;
const ANIME_PREFIX = /^\[([^\]]+)\]/;

// Words that look like a group in "-WORD" or "[WORD]" position but describe the release.
const NOT_A_GROUP = new Set(
  [
    'web', 'webdl', 'web-dl', 'webrip', 'hdtv', 'sdtv', 'pdtv', 'dvd', 'dvdrip', 'bd', 'bdrip', 'brrip', 'bluray', 'blu-ray', 'remux', 'hdrip',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'dts', 'ac3', 'aac', 'eac3', 'flac', 'opus', 'mp3', 'truehd', 'atmos', 'ddp',
    'hdr', 'sdr', 'uhd', 'dv', 'imax', '10bit', '8bit', 'hi10p', 'hybrid', 'mkv', 'mp4', 'avi', 'ts', 'proper', 'repack', 'internal', 'readnfo',
    'multi', 'dual', 'dl', 'subbed', 'dubbed', 'subs', 'sub', 'multisub', 'softsubs', 'hardsubs', 'raw', 'batch', 'pack', 'complete', 'extended',
    'unrated', 'uncut', 'limited', 'retail', 'eng', 'ita', 'ger', 'fre', 'spa', 'jpn', 'rus', 'kor', 'chi', 'www', 'sample', 'english',
  ],
);

function plausible(group: string): string | null {
  const g = group.trim();
  if (!g || g.length > 40) return null;
  if (NOT_A_GROUP.has(g.toLowerCase())) return null;
  if (/^(?:19|20)\d{2}$/.test(g)) return null; // year
  if (/^\d{1,4}$/.test(g)) return null; // episode number, short number
  if (/\d{3,4}[pi](?![a-z])/i.test(g)) return null; // contains a resolution
  if (/^v\d$/i.test(g)) return null; // version tag
  if (/^[a-f0-9]{8}$/i.test(g) && /\d/.test(g)) return null; // CRC
  if (/^(?:s\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3})$/i.test(g)) return null; // numbering
  if (/^(?:dd|ddp|aac|ac3|eac3|dts)?\d(?:\.\d)?$/i.test(g)) return null; // channels
  return g;
}

/** Bracket content that can be a group: one word (dots, hyphens and underscores allowed). */
function bracketGroup(inner: string): string | null {
  if (!/^[\p{L}\p{N}._-]+$/u.test(inner)) return null;
  return plausible(inner);
}

function peel(title: string): string {
  let t = title;
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(TRACKER_TAG, '')
      .replace(SITE_TAG, '')
      .replace(HASH_TAG, '')
      .replace(TRAILING_LANGUAGE, '')
      .replace(JUNK_SUFFIX, '')
      .trimEnd();
    if (next === t) break;
    t = next;
  }
  return t;
}

export function parseReleaseGroup(releaseTitle: string): string | null {
  let t = releaseTitle.trim().replace(FILE_EXTENSION, '').replace(SITE_PREFIX, '').trim();
  // A path: the group belongs to the file name.
  if (/^[a-z]:\\|\\/i.test(t)) t = t.slice(t.lastIndexOf('\\') + 1).replace(FILE_EXTENSION, '');

  const prefix = ANIME_PREFIX.exec(t);
  if (prefix) {
    const inner = prefix[1]!.trim();
    if (!/\d{3,4}p/i.test(inner) && !NOT_A_GROUP.has(inner.toLowerCase()) && plausible(inner)) return inner;
  }

  const softsubs = SOFTSUBS.exec(t);
  if (softsubs) return softsubs[1]!;

  t = peel(t);

  const signed = ANYWHERE_RE.exec(t) ?? PARENS_RE.exec(t);
  if (signed) return signed[1]!;

  const hyphenated = HYPHENATED_RE.exec(t);
  if (hyphenated) return hyphenated[1]!;

  const bracket = TRAILING_BRACKET.exec(t);
  if (bracket) {
    const g = bracketGroup(bracket[1]!.trim());
    // Anything else in that position is a description; the release carries no group.
    return g;
  }

  const paren = LAST_PAREN_DASH.exec(t);
  if (paren) return plausible(paren[1]!);

  // "-Group (Some, Description)": drop trailing descriptive parentheses.
  t = t.replace(/\s*\([^()]*[\s,][^()]*\)$/, '').trimEnd();

  const scene = SCENE_GROUP.exec(t);
  if (scene) {
    const g = scene[1]!;
    // Long all-digit names exist ("-126811"); short ones are episode numbers.
    if (/^\d+$/.test(g)) return g.length >= 5 ? g : null;
    return plausible(g);
  }
  return null;
}
