// Title clean-up shared by every layer of the parser.

const TLD = String.raw`(?:com|net|org|to|me|tv|cc|tc|xyz|info|ws|io|ru|club|life|site|cx|cfd|biz|lol|in|pl)`;
// A leading domain is a website tag only when bracketed, "www."-prefixed, or followed by " - ";
// "Series.to.Me.S03" is a title.
const WEBSITE_PREFIX = new RegExp(
  String.raw`^(?:\[\s*(?:www\.)?[a-z0-9-]+\.${TLD}\s*\]|www\.[a-z0-9-]+\.${TLD}(?![a-z0-9])|[a-z0-9-]+\.${TLD}(?=\s+[-–]\s))\s*[-–:]?\s*`,
  'i',
);
const WEBSITE_POSTFIX = /\s*[-–]?\s*\[?\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|to|me|tv|cc|xyz|info|ws|io|ru|club|life|site|cx|cfd|biz|lol)\s*\]?\s*$/i;
const MEDIA_EXTENSION = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|mpg|mpeg|divx|xvid|webm|flv|ogm|iso|img|rar|zip|nzb|torrent|part\d+|r\d{2}|srt|sub|idx|nfo|sfv|txt)$/i;
const TORRENT_TRACKER_TAG = /\[(?:rartv|rarbg|ettv|eztv|TGx|ETRG|CTRG|GloDLS|Silence|AT-TEAM|SPARROW)\]/gi;
const BRACKET_HASH = /\[[a-f0-9]{8}\]$/i;

export function stripExtension(title: string): { title: string; extension: string | null } {
  const m = MEDIA_EXTENSION.exec(title);
  if (!m) return { title, extension: null };
  return { title: title.slice(0, m.index), extension: m[1]!.toLowerCase() };
}

export function stripWebsite(title: string): string {
  let t = title.replace(WEBSITE_PREFIX, '');
  // Only strip a trailing domain when it is clearly a tag, not the release group.
  if (/\]\s*$/.test(t) || /\s-\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,4}\s*$/i.test(t)) {
    t = t.replace(WEBSITE_POSTFIX, '');
  }
  return t;
}

export function stripTrackerTags(title: string): string {
  return title.replace(TORRENT_TRACKER_TAG, '').replace(BRACKET_HASH, '').trim();
}

/** Replace separators with single spaces and trim. */
export function spaced(text: string): string {
  return text
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower-case letters and digits only; what two titles must agree on to be "the same". */
export function cleanTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

const COMMON_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of']);
/** Letters that do not decompose into base letter + accent under NFD. */
const LETTER_FOLD: Record<string, string> = { ð: 'd', đ: 'd', þ: 'th', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', ı: 'i' };

/** Strip accents: "Carnivàle" → "Carnivale", "Ríkið" → "Rikid". */
export function removeAccents(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ðđþøæœßłı]/gi, (ch) => {
      const folded = LETTER_FOLD[ch.toLowerCase()] ?? ch;
      return ch === ch.toLowerCase() ? folded : folded.toUpperCase();
    });
}

/**
 * Series/movie title normalization for matching: lowercase letters and digits only, accents
 * removed, "3%" → "3percent", and the common words (a, an, the, and, or, of) dropped when they
 * sit between other words — never at the start or end of the title.
 */
export function normalizeTitle(title: string): string {
  const text = removeAccents(title).toLowerCase().replace(/(\d)\s*%/g, '$1percent');
  const words = text.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/'/g, '')).filter(Boolean);
  const kept = words.filter((w, i) => {
    if (i === 0 || i === words.length - 1 || !COMMON_WORDS.has(w)) return true;
    // "a" next to a single-letter word is part of an acronym: "word.a.N.K.L.E.word".
    if (w === 'a' && (words[i - 1]!.length === 1 || words[i + 1]!.length === 1)) return true;
    return false;
  });
  return kept.join('');
}

export function prepare(raw: string): string {
  let t = raw.trim();
  t = stripExtension(t).title;
  t = stripWebsite(t);
  t = stripTrackerTags(t);
  return t.trim();
}
