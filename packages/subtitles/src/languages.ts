import type { Language, LanguageTag, SubtitleLanguage } from './types.js';

// ISO 639 table. Each row: alpha2 | 639-2/B (blank when equal to /T) | 639-2/T | English name.
// For every 639-1 language the 639-3 code equals 639-2/T. Rows with a blank alpha2 are
// languages that only have three-letter codes but show up in subtitle catalogues.
const RAW = `
aa||aar|Afar
ab||abk|Abkhazian
ae||ave|Avestan
af||afr|Afrikaans
ak||aka|Akan
am||amh|Amharic
an||arg|Aragonese
ar||ara|Arabic
as||asm|Assamese
av||ava|Avaric
ay||aym|Aymara
az||aze|Azerbaijani
ba||bak|Bashkir
be||bel|Belarusian
bg||bul|Bulgarian
bh||bih|Bihari
bi||bis|Bislama
bm||bam|Bambara
bn||ben|Bengali
bo|tib|bod|Tibetan
br||bre|Breton
bs||bos|Bosnian
ca||cat|Catalan
ce||che|Chechen
ch||cha|Chamorro
co||cos|Corsican
cr||cre|Cree
cs|cze|ces|Czech
cu||chu|Church Slavic
cv||chv|Chuvash
cy|wel|cym|Welsh
da||dan|Danish
de|ger|deu|German
dv||div|Divehi
dz||dzo|Dzongkha
ee||ewe|Ewe
el|gre|ell|Greek
en||eng|English
eo||epo|Esperanto
es||spa|Spanish
et||est|Estonian
eu|baq|eus|Basque
fa|per|fas|Persian
ff||ful|Fulah
fi||fin|Finnish
fj||fij|Fijian
fo||fao|Faroese
fr|fre|fra|French
fy||fry|Western Frisian
ga||gle|Irish
gd||gla|Scottish Gaelic
gl||glg|Galician
gn||grn|Guarani
gu||guj|Gujarati
gv||glv|Manx
ha||hau|Hausa
he||heb|Hebrew
hi||hin|Hindi
ho||hmo|Hiri Motu
hr||hrv|Croatian
ht||hat|Haitian
hu||hun|Hungarian
hy|arm|hye|Armenian
hz||her|Herero
ia||ina|Interlingua
id||ind|Indonesian
ie||ile|Interlingue
ig||ibo|Igbo
ii||iii|Sichuan Yi
ik||ipk|Inupiaq
io||ido|Ido
is|ice|isl|Icelandic
it||ita|Italian
iu||iku|Inuktitut
ja||jpn|Japanese
jv||jav|Javanese
ka|geo|kat|Georgian
kg||kon|Kongo
ki||kik|Kikuyu
kj||kua|Kuanyama
kk||kaz|Kazakh
kl||kal|Kalaallisut
km||khm|Khmer
kn||kan|Kannada
ko||kor|Korean
kr||kau|Kanuri
ks||kas|Kashmiri
ku||kur|Kurdish
kv||kom|Komi
kw||cor|Cornish
ky||kir|Kirghiz
la||lat|Latin
lb||ltz|Luxembourgish
lg||lug|Ganda
li||lim|Limburgish
ln||lin|Lingala
lo||lao|Lao
lt||lit|Lithuanian
lu||lub|Luba-Katanga
lv||lav|Latvian
mg||mlg|Malagasy
mh||mah|Marshallese
mi|mao|mri|Maori
mk|mac|mkd|Macedonian
ml||mal|Malayalam
mn||mon|Mongolian
mr||mar|Marathi
ms|may|msa|Malay
mt||mlt|Maltese
my|bur|mya|Burmese
na||nau|Nauru
nb||nob|Norwegian Bokmal
nd||nde|North Ndebele
ne||nep|Nepali
ng||ndo|Ndonga
nl|dut|nld|Dutch
nn||nno|Norwegian Nynorsk
no||nor|Norwegian
nr||nbl|South Ndebele
nv||nav|Navajo
ny||nya|Chichewa
oc||oci|Occitan
oj||oji|Ojibwa
om||orm|Oromo
or||ori|Oriya
os||oss|Ossetian
pa||pan|Punjabi
pi||pli|Pali
pl||pol|Polish
ps||pus|Pashto
pt||por|Portuguese
qu||que|Quechua
rm||roh|Romansh
rn||run|Rundi
ro|rum|ron|Romanian
ru||rus|Russian
rw||kin|Kinyarwanda
sa||san|Sanskrit
sc||srd|Sardinian
sd||snd|Sindhi
se||sme|Northern Sami
sg||sag|Sango
si||sin|Sinhala
sk|slo|slk|Slovak
sl||slv|Slovenian
sm||smo|Samoan
sn||sna|Shona
so||som|Somali
sq|alb|sqi|Albanian
sr||srp|Serbian
ss||ssw|Swati
st||sot|Southern Sotho
su||sun|Sundanese
sv||swe|Swedish
sw||swa|Swahili
ta||tam|Tamil
te||tel|Telugu
tg||tgk|Tajik
th||tha|Thai
ti||tir|Tigrinya
tk||tuk|Turkmen
tl||tgl|Tagalog
tn||tsn|Tswana
to||ton|Tonga
tr||tur|Turkish
ts||tso|Tsonga
tt||tat|Tatar
tw||twi|Twi
ty||tah|Tahitian
ug||uig|Uighur
uk||ukr|Ukrainian
ur||urd|Urdu
uz||uzb|Uzbek
ve||ven|Venda
vi||vie|Vietnamese
vo||vol|Volapuk
wa||wln|Walloon
wo||wol|Wolof
xh||xho|Xhosa
yi||yid|Yiddish
yo||yor|Yoruba
za||zha|Zhuang
zh|chi|zho|Chinese
zu||zul|Zulu
||ast|Asturian
||fil|Filipino
||kok|Konkani
||mai|Maithili
||mni|Manipuri
||sat|Santali
||yue|Cantonese
||ckb|Central Kurdish
`;

export const LANGUAGES: readonly Language[] = RAW.trim()
  .split('\n')
  .map((line) => {
    const [a2, b, t, name] = line.split('|') as [string, string, string, string];
    return { alpha2: a2 || null, alpha3b: b || t, alpha3t: t, alpha3: t, name };
  });

const byCode = new Map<string, Language>();
const byName = new Map<string, Language>();
for (const l of LANGUAGES) {
  if (l.alpha2) byCode.set(l.alpha2, l);
  byCode.set(l.alpha3b, l);
  byCode.set(l.alpha3t, l);
  byName.set(l.name.toLowerCase(), l);
}
// Common alternative English names.
for (const [alias, code] of [
  ['farsi', 'fa'], ['castilian', 'es'], ['flemish', 'nl'], ['moldavian', 'ro'], ['moldovan', 'ro'],
  ['gaelic', 'gd'], ['panjabi', 'pa'], ['sinhalese', 'si'], ['kyrgyz', 'ky'], ['uyghur', 'ug'],
  ['norwegian bokmål', 'nb'], ['bokmal', 'nb'], ['volapük', 'vo'], ['catalan', 'ca'],
  ['valencian', 'ca'], ['letzeburgesch', 'lb'], ['slovene', 'sl'], ['mandarin', 'zh'],
] as const) {
  const l = byCode.get(code);
  if (l) byName.set(alias, l);
}

/** Region/script variants we name explicitly, with their aliases. */
interface Variant {
  tag: LanguageTag;
  name: string;
  aliases: readonly string[];
}
const VARIANTS: readonly Variant[] = [
  { tag: 'pt-BR', name: 'Portuguese (Brazil)', aliases: ['pob', 'pb', 'pt-br', 'ptbr', 'brazilian portuguese', 'portuguese (brazil)', 'portuguese (brazilian)', 'brazilian'] },
  { tag: 'pt-PT', name: 'Portuguese (Portugal)', aliases: ['pt-pt', 'portuguese (portugal)'] },
  { tag: 'zh-Hans', name: 'Chinese (Simplified)', aliases: ['zh-hans', 'chs', 'zhs', 'chinese simplified', 'chinese (simplified)', 'simplified chinese'] },
  { tag: 'zh-Hant', name: 'Chinese (Traditional)', aliases: ['zh-hant', 'cht', 'zht', 'chinese traditional', 'chinese (traditional)', 'traditional chinese', 'big5'] },
  { tag: 'zh-CN', name: 'Chinese (China)', aliases: ['zh-cn'] },
  { tag: 'zh-TW', name: 'Chinese (Taiwan)', aliases: ['zh-tw', 'zhtw'] },
  { tag: 'zh-HK', name: 'Chinese (Hong Kong)', aliases: ['zh-hk'] },
  { tag: 'es-MX', name: 'Spanish (Mexico)', aliases: ['es-mx', 'ea', 'spl', 'spanish (mexico)', 'spanish (latin america)'] },
  { tag: 'es-419', name: 'Spanish (Latin America)', aliases: ['es-419', 'latin american spanish'] },
  { tag: 'es-ES', name: 'Spanish (Spain)', aliases: ['es-es', 'spanish (spain)'] },
  { tag: 'sr-Latn', name: 'Serbian (Latin)', aliases: ['sr-latn', 'serbian (latin)', 'srp-latn'] },
  { tag: 'sr-Cyrl', name: 'Serbian (Cyrillic)', aliases: ['sr-cyrl', 'serbian (cyrillic)', 'srp-cyrl'] },
  { tag: 'fr-CA', name: 'French (Canada)', aliases: ['fr-ca', 'french (canada)', 'canadian french'] },
];
const variantByAlias = new Map<string, Variant>();
const variantByTag = new Map<string, Variant>();
for (const v of VARIANTS) {
  variantByTag.set(v.tag.toLowerCase(), v);
  for (const a of v.aliases) variantByAlias.set(a, v);
}

/** Look up a base language by any code (alpha2, 639-2/B, 639-2/T) or English name. */
export function findLanguage(input: string): Language | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  return byCode.get(s) ?? byName.get(s);
}

/** The base part of a tag ("pt-BR" -> "pt"). */
export function baseTag(tag: LanguageTag): string {
  return tag.split('-')[0]!.toLowerCase();
}

/**
 * Normalise any language spelling to a LanguageTag: "eng" -> "en", "pob" -> "pt-BR",
 * "zh_tw" -> "zh-TW", "English" -> "en", "srp-latn" -> "sr-Latn". Unknown input -> undefined.
 */
export function parseLanguageTag(input: string): LanguageTag | undefined {
  const s = input.trim().toLowerCase().replace(/_/g, '-');
  if (!s) return undefined;
  const variant = variantByAlias.get(s) ?? variantByTag.get(s);
  if (variant) return variant.tag;
  const direct = findLanguage(s);
  if (direct) return direct.alpha2 ?? direct.alpha3t;
  const parts = s.split('-');
  if (parts.length >= 2) {
    const base = findLanguage(parts[0]!);
    if (!base) return undefined;
    const head = base.alpha2 ?? base.alpha3t;
    const sub = parts[1]!;
    const known = variantByTag.get(`${head}-${sub}`);
    if (known) return known.tag;
    if (sub.length === 4) return `${head}-${sub[0]!.toUpperCase()}${sub.slice(1)}`;
    if (/^[a-z]{2}$/.test(sub) || /^\d{3}$/.test(sub)) return `${head}-${sub.toUpperCase()}`;
    return head;
  }
  return undefined;
}

/** English display name for a tag. */
export function languageName(tag: LanguageTag): string {
  const v = variantByTag.get(tag.toLowerCase());
  if (v) return v.name;
  const base = findLanguage(baseTag(tag));
  if (!base) return tag;
  const region = tag.split('-')[1];
  return region ? `${base.name} (${region})` : base.name;
}

export function toAlpha2(tag: LanguageTag): string | null {
  return findLanguage(baseTag(tag))?.alpha2 ?? null;
}

/** Three-letter code; 'b' for bibliographic (fre), 't' for terminology (fra). */
export function toAlpha3(tag: LanguageTag, form: 'b' | 't' = 't'): string | null {
  const l = findLanguage(baseTag(tag));
  if (!l) return null;
  return form === 'b' ? l.alpha3b : l.alpha3t;
}

export function isKnownLanguage(tag: LanguageTag): boolean {
  return findLanguage(baseTag(tag)) !== undefined;
}

/** Same base language, ignoring region/script. */
export function sameBaseLanguage(a: LanguageTag, b: LanguageTag): boolean {
  return toAlpha3(a) !== null && toAlpha3(a) === toAlpha3(b);
}

/** Spec R1.4 string form: "en", "en:forced", "en:hi". Forced wins. */
export function languageString(l: SubtitleLanguage): string {
  if (l.forced) return `${l.tag}:forced`;
  if (l.hi) return `${l.tag}:hi`;
  return l.tag;
}

export function parseLanguageString(s: string): SubtitleLanguage | undefined {
  const [code, suffix] = s.split(':');
  const tag = code ? parseLanguageTag(code) : undefined;
  if (!tag) return undefined;
  return { tag, forced: suffix === 'forced', hi: suffix === 'hi' };
}

/** Every base tag in the table plus the named variants (for "any language" providers). */
export function allLanguageTags(): LanguageTag[] {
  return [...LANGUAGES.map((l) => l.alpha2 ?? l.alpha3t), ...VARIANTS.map((v) => v.tag)];
}
