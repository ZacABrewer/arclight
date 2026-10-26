import type { ArrApp } from './quality.js';
import { field, int, str } from '../foreign-db.js';

// Upstream language ids → ISO 639-1 codes (Arclight's LanguageCode). Ids are per app (the
// two lists diverge after 25); both are mapped through the language name.

const SONARR_LANGUAGE_NAMES = [
  'Unknown', 'English', 'French', 'Spanish', 'German', 'Italian', 'Danish', 'Dutch', 'Japanese', 'Icelandic',
  'Chinese', 'Russian', 'Polish', 'Vietnamese', 'Swedish', 'Norwegian', 'Finnish', 'Turkish', 'Portuguese', 'Flemish',
  'Greek', 'Korean', 'Hungarian', 'Hebrew', 'Lithuanian', 'Czech', 'Arabic', 'Hindi', 'Bulgarian', 'Malayalam',
  'Ukrainian', 'Slovak', 'Thai', 'Portuguese (Brazil)', 'Spanish (Latino)', 'Romanian', 'Latvian', 'Persian', 'Catalan', 'Croatian',
  'Serbian', 'Bosnian', 'Estonian', 'Tamil', 'Indonesian', 'Macedonian', 'Slovenian', 'Azerbaijani', 'Uzbek', 'Malay',
  'Urdu', 'Romansh', 'Georgian', 'Irish',
];

const RADARR_LANGUAGE_NAMES = [
  'Unknown', 'English', 'French', 'Spanish', 'German', 'Italian', 'Danish', 'Dutch', 'Japanese', 'Icelandic',
  'Chinese', 'Russian', 'Polish', 'Vietnamese', 'Swedish', 'Norwegian', 'Finnish', 'Turkish', 'Portuguese', 'Flemish',
  'Greek', 'Korean', 'Hungarian', 'Hebrew', 'Lithuanian', 'Czech', 'Hindi', 'Romanian', 'Thai', 'Bulgarian',
  'Portuguese (Brazil)', 'Arabic', 'Ukrainian', 'Persian', 'Bengali', 'Slovak', 'Latvian', 'Spanish (Latino)', 'Catalan', 'Croatian',
  'Serbian', 'Bosnian', 'Estonian', 'Tamil', 'Indonesian', 'Telugu', 'Macedonian', 'Slovenian', 'Malayalam', 'Kannada',
  'Albanian', 'Afrikaans', 'Marathi', 'Tagalog', 'Urdu', 'Romansh', 'Mongolian', 'Georgian', 'Irish',
];

const NAME_TO_ISO: Record<string, string> = {
  unknown: 'unknown',
  original: 'original',
  english: 'en',
  french: 'fr',
  spanish: 'es',
  'spanish (latino)': 'es',
  german: 'de',
  italian: 'it',
  danish: 'da',
  dutch: 'nl',
  flemish: 'nl',
  japanese: 'ja',
  icelandic: 'is',
  chinese: 'zh',
  russian: 'ru',
  polish: 'pl',
  vietnamese: 'vi',
  swedish: 'sv',
  norwegian: 'no',
  finnish: 'fi',
  turkish: 'tr',
  portuguese: 'pt',
  'portuguese (brazil)': 'pt',
  greek: 'el',
  korean: 'ko',
  hungarian: 'hu',
  hebrew: 'he',
  lithuanian: 'lt',
  czech: 'cs',
  arabic: 'ar',
  hindi: 'hi',
  bulgarian: 'bg',
  malayalam: 'ml',
  ukrainian: 'uk',
  slovak: 'sk',
  thai: 'th',
  romanian: 'ro',
  latvian: 'lv',
  persian: 'fa',
  catalan: 'ca',
  croatian: 'hr',
  serbian: 'sr',
  bosnian: 'bs',
  estonian: 'et',
  tamil: 'ta',
  indonesian: 'id',
  macedonian: 'mk',
  slovenian: 'sl',
  azerbaijani: 'az',
  uzbek: 'uz',
  malay: 'ms',
  urdu: 'ur',
  romansh: 'rm',
  georgian: 'ka',
  irish: 'ga',
  bengali: 'bn',
  telugu: 'te',
  kannada: 'kn',
  albanian: 'sq',
  afrikaans: 'af',
  marathi: 'mr',
  tagalog: 'tl',
  mongolian: 'mn',
};

/** ISO code for a language name (`English`, `Portuguese (Brazil)`), or undefined. */
export function languageNameToIso(name: string): string | undefined {
  return NAME_TO_ISO[name.trim().toLowerCase()];
}

/**
 * ISO code for an upstream language id. `-2` is "Original"; `-1` ("Any") returns undefined
 * because Arclight expresses "any" as an empty language list.
 */
export function mapLanguageId(app: ArrApp, id: number): string | undefined {
  if (id === -2) return 'original';
  if (id < 0) return undefined;
  const name = (app === 'sonarr' ? SONARR_LANGUAGE_NAMES : RADARR_LANGUAGE_NAMES)[id];
  return name ? languageNameToIso(name) : undefined;
}

/** A Languages JSON column (`[1, 2]` or `[{"id":1,"name":"English"}]`) → ISO codes. */
export function mapLanguageList(app: ArrApp, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const entry of list) {
    let code: string | undefined;
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const id = int(field(obj, 'id'));
      const name = str(field(obj, 'name'));
      code = (id !== null ? mapLanguageId(app, id) : undefined) ?? (name ? languageNameToIso(name) : undefined);
    } else {
      const id = int(entry);
      code = id !== null ? mapLanguageId(app, id) : typeof entry === 'string' ? languageNameToIso(entry) : undefined;
    }
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Bazarr / ISO 639-2 / custom codes → ISO 639-1 where they differ. */
const CODE_ALIASES: Record<string, string> = {
  pb: 'pt',
  'pt-br': 'pt',
  zt: 'zh',
  'zh-tw': 'zh',
  'zh-hant': 'zh',
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  dut: 'nl',
  nld: 'nl',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  rus: 'ru',
  por: 'pt',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  pol: 'pl',
  kor: 'ko',
  ara: 'ar',
  tur: 'tr',
  gre: 'el',
  ell: 'el',
  heb: 'he',
  hun: 'hu',
  cze: 'cs',
  ces: 'cs',
};

export function normalizeLanguageCode(code: string): string {
  const c = code.trim().toLowerCase();
  return CODE_ALIASES[c] ?? (c.length > 2 && c.includes('-') ? c.split('-')[0]! : c);
}
