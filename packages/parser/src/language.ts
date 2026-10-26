// Language detection from release names. Languages are identified by English name, the same
// vocabulary the subtitles and profiles layers use. A release that names no language is
// "Unknown" (the caller decides what that means: usually the title's original language).
//
// Three kinds of evidence, reported in this order (the first entry is the "main" language):
//  1. Full language names ("French", "Latino", "Dublado") anywhere in the language segment.
//  2. Short tags ("ITA", "VFF", "Ukr", "[CHS]") that are not followed by a "SUBS" marker:
//     "Ger.Eng.Sub" lists subtitle languages, not audio.
//  3. Case-sensitive two-letter codes ("DE", "EN", "PL") which are too common as words in any
//     other case, likewise ignored next to a SUB marker.
// Finally, a German-only release tagged DL (dual language) also carries the original audio,
// and one tagged ML (multi language) carries the original and English.

interface Rule {
  name: string;
  re: RegExp;
}

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const word = (alts: string, flags = 'iu') => new RegExp(`${B}(?:${alts})${E}`, flags);

// 1. Full names. Not subject to the subtitle rule ("Pilot.English.sub" is English).
const NAMES: Rule[] = [
  { name: 'Spanish (Latino)', re: word('latino') },
  { name: 'Spanish', re: /spanish/i },
  { name: 'Danish', re: /danish/i },
  { name: 'Dutch', re: /dutch/i },
  { name: 'Japanese', re: /japanese/i },
  { name: 'Icelandic', re: /icelandic/i },
  { name: 'Chinese', re: /mandarin|cantonese|chinese/i },
  { name: 'Korean', re: /korean/i },
  { name: 'Russian', re: /russian/i },
  { name: 'Polish', re: /polish/i },
  { name: 'Vietnamese', re: /vietnamese/i },
  { name: 'Swedish', re: /swedish/i },
  { name: 'Norwegian', re: /norwegian/i },
  { name: 'Finnish', re: /finnish/i },
  { name: 'Turkish', re: /turkish/i },
  { name: 'Portuguese', re: /portuguese/i },
  { name: 'Hungarian', re: /hungarian/i },
  { name: 'Hebrew', re: /hebrew/i },
  { name: 'Arabic', re: /arabic/i },
  { name: 'Hindi', re: /hindi/i },
  { name: 'Malayalam', re: /malayalam/i },
  { name: 'Ukrainian', re: /ukrainian/i },
  { name: 'Bulgarian', re: /bulgarian/i },
  { name: 'Slovak', re: /slovak/i },
  { name: 'Portuguese (Brazil)', re: /brazilian|dublado|(?<![a-z])pt[-_. ]?br(?![a-z])/i },
  { name: 'Latvian', re: /latvian/i },
  { name: 'Azerbaijani', re: /azerbaijan/i },
  { name: 'Uzbek', re: /uzbek/i },
  { name: 'Romanian', re: /romanian/i },
  { name: 'Thai', re: word('thai') },
  { name: 'Persian', re: /persian|farsi/i },
  { name: 'Bengali', re: /bengali/i },
  { name: 'Tamil', re: /tamil/i },
  { name: 'Telugu', re: /telugu/i },
  { name: 'Kannada', re: /kannada/i },
  { name: 'Albanian', re: /albanian/i },
  { name: 'Afrikaans', re: /afrikaans/i },
  { name: 'Marathi', re: /marathi/i },
  { name: 'Tagalog', re: /tagalog|filipino/i },
  { name: 'Mongolian', re: /mongolian|khalkha/i },
  { name: 'Greek', re: /greek/i },
  { name: 'Flemish', re: /flemish/i },
  { name: 'Catalan', re: word('catal[aàá]n?') },
  { name: 'English', re: /english/i },
];

// 2. Tags. Each alias list is also what the subtitle rule recognises as "another language" when
// walking a run like "Ger.Eng.Fre.Sub".
const TAGS: Rule[] = [
  { name: 'English', re: word('eng|ing|ingl[eé]s') },
  { name: 'Italian', re: word('ita|italian') },
  { name: 'German', re: new RegExp(String.raw`(?:swiss)?german${E}|videomann|${B}ger(?:[. ]dub)?${E}`, 'iu') },
  { name: 'French', re: word('fr|vf|vf2|vff|vfi|vfq|truefrench|french|fre|fra') },
  { name: 'Russian', re: word('rus|ru') },
  { name: 'Hungarian', re: word('hundub|hun') },
  { name: 'Hebrew', re: new RegExp(`${B}hebdub(?:bed)?${E}`, 'iu') },
  { name: 'Polish', re: word(String.raw`pl[^\p{L}\p{N}]?dub|dub[^\p{L}\p{N}]?pl|lek[^\p{L}\p{N}]?pl|pl[^\p{L}\p{N}]?lek`) },
  { name: 'Chinese', re: /\[(?:CH[ST]|BIG5|GB)\]|简|繁|字幕|国语|中文/i },
  { name: 'Bulgarian', re: word('bgaudio') },
  { name: 'Spanish', re: new RegExp(String.raw`${B}(?:español|castellano|esp|spa(?!\(latino\)))${E}`, 'iu') },
  { name: 'Ukrainian', re: new RegExp(String.raw`${B}(?:\dx?)?ukr`, 'iu') },
  { name: 'Romanian', re: word('rodubbed') },
  { name: 'Catalan', re: /[-,. ]cat[. ](?:dd|subs)/i },
  { name: 'Latvian', re: word('lat|lav|lv') },
  { name: 'Turkish', re: word('tur') },
  { name: 'Urdu', re: word('urdu') },
  { name: 'Romansh', re: word('romansh|rumantsch|romansch') },
  { name: 'Georgian', re: word('geo|ka|kat|georgian') },
  { name: 'Irish', re: word('irish|gaeilge') },
  { name: 'Japanese', re: /\(JA\)|JAP|JPN/i },
  { name: 'Korean', re: word('kor') },
  { name: 'Vietnamese', re: word('vie') },
  { name: 'Hindi', re: word('hin') },
  { name: 'Telugu', re: word('tel') },
  { name: 'Portuguese', re: /[ ._]por[ ._]/i },
  { name: 'Original', re: word('orig|original') },
];

// 3. Case-sensitive codes.
const CODES: Rule[] = [
  { name: 'Lithuanian', re: /\bLT\b/ },
  { name: 'Czech', re: /\bCZ\b/ },
  { name: 'Polish', re: /\bPL\b/ },
  { name: 'Bulgarian', re: /\bBG\b/ },
  { name: 'Slovak', re: /\bSK\b/ },
  { name: 'German', re: /\bDE\b/ },
  { name: 'English', re: /\bEN\b/ },
  { name: 'Spanish', re: /(?<!DTS[-. ])\bES\b/ }, // "DTS-ES" is an audio format
];

const TAG_ALIASES = String.raw`eng|ing|ita|ger|deu|fre|fra|fr|rus|ru|hun|spa|esp|por|jpn|jap|kor|chi|pl|cz|lt|lat|lav|lv|tur|ukr|ara|hin|tel`;
/** A run of further language tags ending in a SUB(S) marker. */
const SUBS_AFTER = new RegExp(String.raw`^(?:[-_. ](?:${TAG_ALIASES}))*[-_. ]subs?${E}`, 'iu');
const SUB_BEFORE = /sub[^a-z0-9]$/i;
const SUB_AFTER = /^[^a-z0-9]sub/i;

/**
 * Where language tags can appear: after the episode marker for series, after the year for
 * movies. Title words ("The.Danish.Girl", "Title.the.Spanish.Series") come before both.
 */
function languageSegment(title: string): string {
  const episode = /[_. ](S\d{2}(?:E\d{2,4})*[_. ].*)$/i.exec(title);
  if (episode) return episode[1]!;
  // A year needs title text before it and must stand alone ("1920x1080" is not a year).
  const year = /^.*?[\p{L}\p{N}].*?[\s._([](?:19|20)\d{2}(?![\p{L}\p{N}])(.*)$/su.exec(title);
  if (year) return year[1]!;
  return title;
}

// Site tags like "[www.site.org]" or "[YTS.MX]"; "[ES.EN]" is a language list, not a domain.
const BRACKETED_DOMAIN = /\[\s*(?:www\.)?[a-z0-9-]+\.(?:com|net|org|info|biz|to|tv|cc|me|io|ws|xyz|ru|club|site)\s*\]|\[YTS\.[a-z]{2}\]/gi;

function stripGroup(text: string, group: string | null): string {
  if (!group) return text;
  // Only a group at the end is removed; an anime "[Group]" prefix can itself carry a language
  // marker ("[ABC字幕组]") and stays.
  const idx = text.lastIndexOf(group);
  if (idx > 0 && /^[\])\s]*$/.test(text.slice(idx + group.length))) return text.slice(0, idx);
  return text;
}

function collect(text: string, rule: Rule, filter: (m: RegExpExecArray) => boolean): boolean {
  const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (filter(m)) return true;
    if (m[0].length === 0) re.lastIndex++;
  }
  return false;
}

export function parseLanguages(releaseTitle: string, releaseGroup: string | null = null): string[] {
  const text = languageSegment(stripGroup(releaseTitle, releaseGroup)).replace(BRACKETED_DOMAIN, ' ');
  const found: string[] = [];
  const add = (name: string) => {
    if (!found.includes(name)) found.push(name);
  };

  for (const rule of NAMES) if (rule.re.test(text)) add(rule.name);

  for (const rule of TAGS) {
    const audio = collect(text, rule, (m) => rule.name === 'Catalan' || !SUBS_AFTER.test(text.slice(m.index + m[0].length)));
    if (audio) add(rule.name);
  }

  // Chinese fansub groups name themselves "...字幕组" ("subtitle group"); callers that pass only
  // the text after the title would otherwise lose that marker with the "[Group]" prefix.
  if (releaseGroup && /字幕|简|繁/.test(releaseGroup)) add('Chinese');

  for (const rule of CODES) {
    const audio = collect(text, rule, (m) => !SUB_BEFORE.test(text.slice(Math.max(0, m.index - 4), m.index)) && !SUB_AFTER.test(text.slice(m.index + m[0].length)));
    if (audio) add(rule.name);
  }

  if (found.length === 0) return ['Unknown'];

  if (found.length === 1 && found[0] === 'German') {
    if (/(?<!WEB[-_. ]?)\bDL\b/i.test(text)) found.push('Original');
    else if (/\bML\b/i.test(text)) found.push('Original', 'English');
  }
  return found;
}
