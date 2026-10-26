// Friendly codec names, channel text and language lists for the MediaInfo tokens (spec 7.5-7.7).

import { DOUBLE_DASH } from './text.js';
import type { NamingMediaInfo } from './types.js';

const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

function stripExtension(name: string): string {
  return name.replace(/\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm)$/i, '');
}

function fromSceneName(sceneName: string | null | undefined, candidates: readonly string[]): string {
  const scene = stripExtension(sceneName ?? '').toLowerCase();
  if (scene) {
    for (const c of candidates.slice(0, -1)) if (scene.includes(c.toLowerCase())) return c;
  }
  return candidates[candidates.length - 1] ?? '';
}

export function videoCodecName(info: NamingMediaInfo, sceneName?: string | null): string {
  const raw = (info.videoFormat ?? info.videoCodec ?? '').trim();
  const f = raw.toLowerCase();
  const id = lower(info.videoCodecId);
  if (id === 'x264' || f === 'x264') return 'x264';
  if (f === 'h264' || f === 'avc' || f === 'h.264') return fromSceneName(sceneName, ['AVC', 'x264', 'h264']);
  if (id === 'x265' || f === 'x265') return 'x265';
  if (f === 'hevc' || f === 'h265' || f === 'h.265') return fromSceneName(sceneName, ['HEVC', 'x265', 'h265']);
  if (id === 'x266' || f === 'x266') return 'x266';
  if (f === 'vvc' || f === 'h266') return fromSceneName(sceneName, ['VVC', 'x266', 'h266']);
  if (f === 'mpeg2video') return 'MPEG2';
  if (f === 'mpeg1video') return 'MPEG';
  if (f === 'mpeg4' || f.startsWith('msmpeg4')) {
    if (id === 'xvid') return 'XviD';
    if (id === 'div3' || id === 'dx50' || id === 'divx') return 'DivX';
    return '';
  }
  if (f === 'vc1') return 'VC1';
  if (f === 'av1') return 'AV1';
  if (/^vp[6-9]$/.test(f)) return f.toUpperCase();
  if (/^wmv[1-3]$/.test(f)) return 'WMV';
  if (['qtrle', 'rpza', 'rv10', 'rv20', 'rv30', 'rv40', 'cinepak', 'rawvideo', 'msvideo1'].includes(f)) return '';
  return raw;
}

export function audioCodecName(info: NamingMediaInfo): string {
  const raw = (info.audioFormat ?? info.audioCodec ?? '').trim();
  const f = raw.toLowerCase();
  const p = lower(info.audioProfile);
  const id = lower(info.audioCodecId);
  const atmos = p.includes('atmos');
  if (id === 'thd+' || (f === 'truehd' && atmos)) return 'TrueHD Atmos';
  if (f === 'truehd') return 'TrueHD';
  if (f === 'flac') return 'FLAC';
  if (f === 'dts') {
    if (p.includes('dts:x') || p.includes('dts-x')) return 'DTS-X';
    if (p.includes('ma')) return 'DTS-HD MA';
    if (p.includes('es')) return 'DTS-ES';
    if (p.includes('hra') || p.includes('high resolution')) return 'DTS-HD HRA';
    if (p.includes('express')) return 'DTS Express';
    if (p.includes('96/24')) return 'DTS 96/24';
    return 'DTS';
  }
  if (id === 'ec+3' || (f === 'eac3' && atmos)) return 'EAC3 Atmos';
  if (f === 'eac3') return 'EAC3';
  if (f === 'ac3') return 'AC3';
  if (f === 'aac') {
    if (p.includes('xhe-aac')) return 'xHE-AAC';
    if (id.includes('aac/mpeg4/lc/sbr') || p.includes('he-aac')) return 'HE-AAC';
    return 'AAC';
  }
  const simple: Record<string, string> = { mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis' };
  if (simple[f]) return simple[f];
  if (f.startsWith('pcm_') || f.startsWith('adpcm_')) return 'PCM';
  if (f === 'wmav1' || f === 'wmav2' || f === 'wmapro') return 'WMA';
  return raw;
}

export function audioChannelsText(info: NamingMediaInfo): string {
  const m = /^\s*(\d+\.\d)/.exec(info.audioChannelPositions ?? '');
  if (m?.[1] && Number.parseFloat(m[1]) !== 0) return m[1];
  const n = info.audioChannels ?? 0;
  return n > 0 ? n.toFixed(1) : '';
}

export function bitDepthText(info: NamingMediaInfo): string {
  const d = info.videoBitDepth ?? 0;
  return d > 0 ? String(d) : '8';
}

const DYNAMIC_RANGE_ALIASES: Record<string, string> = {
  'dolby vision': 'DV',
  dovi: 'DV',
  'hdr10+': 'HDR10Plus',
  hdr10plus: 'HDR10Plus',
};

export function dynamicRangeType(info: NamingMediaInfo): string {
  const raw = (info.videoDynamicRangeType ?? info.videoDynamicRange ?? '').trim();
  if (!raw || raw.toUpperCase() === 'SDR') return '';
  return DYNAMIC_RANGE_ALIASES[raw.toLowerCase()] ?? raw;
}

export function dynamicRange(info: NamingMediaInfo): string {
  return dynamicRangeType(info) ? 'HDR' : '';
}

// ---------------------------------------------------------------------------------------
// Languages (spec 7.6)
// ---------------------------------------------------------------------------------------

// [ISO 639-1, ISO 639-2/T, English name]
const LANGUAGES: ReadonlyArray<readonly [string, string, string]> = [
  ['af', 'afr', 'afrikaans'], ['ar', 'ara', 'arabic'], ['az', 'aze', 'azerbaijani'],
  ['be', 'bel', 'belarusian'], ['bg', 'bul', 'bulgarian'], ['bn', 'ben', 'bengali'],
  ['bo', 'bod', 'tibetan'], ['bs', 'bos', 'bosnian'], ['ca', 'cat', 'catalan'],
  ['cs', 'ces', 'czech'], ['cy', 'cym', 'welsh'], ['da', 'dan', 'danish'], ['de', 'deu', 'german'],
  ['el', 'ell', 'greek'], ['en', 'eng', 'english'], ['es', 'spa', 'spanish'],
  ['et', 'est', 'estonian'], ['eu', 'eus', 'basque'], ['fa', 'fas', 'persian'],
  ['fi', 'fin', 'finnish'], ['fr', 'fra', 'french'], ['ga', 'gle', 'irish'],
  ['gl', 'glg', 'galician'], ['gu', 'guj', 'gujarati'], ['he', 'heb', 'hebrew'],
  ['hi', 'hin', 'hindi'], ['hr', 'hrv', 'croatian'], ['hu', 'hun', 'hungarian'],
  ['hy', 'hye', 'armenian'], ['id', 'ind', 'indonesian'], ['is', 'isl', 'icelandic'],
  ['it', 'ita', 'italian'], ['ja', 'jpn', 'japanese'], ['ka', 'kat', 'georgian'],
  ['kk', 'kaz', 'kazakh'], ['km', 'khm', 'khmer'], ['kn', 'kan', 'kannada'],
  ['ko', 'kor', 'korean'], ['la', 'lat', 'latin'], ['lo', 'lao', 'lao'],
  ['lt', 'lit', 'lithuanian'], ['lv', 'lav', 'latvian'], ['mi', 'mri', 'maori'],
  ['mk', 'mkd', 'macedonian'], ['ml', 'mal', 'malayalam'], ['mn', 'mon', 'mongolian'],
  ['mr', 'mar', 'marathi'], ['ms', 'msa', 'malay'], ['my', 'mya', 'burmese'],
  ['nb', 'nob', 'norwegian bokmal'], ['ne', 'nep', 'nepali'], ['nl', 'nld', 'dutch'],
  ['nn', 'nno', 'norwegian nynorsk'], ['no', 'nor', 'norwegian'], ['pa', 'pan', 'punjabi'],
  ['pl', 'pol', 'polish'], ['pt', 'por', 'portuguese'], ['ro', 'ron', 'romanian'],
  ['ru', 'rus', 'russian'], ['si', 'sin', 'sinhala'], ['sk', 'slk', 'slovak'],
  ['sl', 'slv', 'slovenian'], ['sq', 'sqi', 'albanian'], ['sr', 'srp', 'serbian'],
  ['sv', 'swe', 'swedish'], ['sw', 'swa', 'swahili'], ['ta', 'tam', 'tamil'],
  ['te', 'tel', 'telugu'], ['th', 'tha', 'thai'], ['tl', 'tgl', 'tagalog'],
  ['tr', 'tur', 'turkish'], ['uk', 'ukr', 'ukrainian'], ['ur', 'urd', 'urdu'],
  ['uz', 'uzb', 'uzbek'], ['vi', 'vie', 'vietnamese'], ['zh', 'zho', 'chinese'],
];

/** ISO 639-2/B bibliographic codes -> terminology codes. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'zho', cze: 'ces', dut: 'nld', fre: 'fra',
  geo: 'kat', ger: 'deu', gre: 'ell', gsw: 'deu', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa',
  per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym',
};

const BY_CODE = new Map<string, string>();
for (const [two, three, name] of LANGUAGES) {
  BY_CODE.set(two, two);
  BY_CODE.set(three, two);
  BY_CODE.set(name, two);
}
for (const [b, t] of Object.entries(BIBLIOGRAPHIC)) {
  const two = BY_CODE.get(t);
  if (two) BY_CODE.set(b, two);
}

/** Two-letter ISO 639-1 code (lower-case) for a code or English name, if known. */
export function resolveLanguage(code: string): string | undefined {
  const key = code.trim().toLowerCase();
  return BY_CODE.get(key) ?? BY_CODE.get(key.split(/[-_]/)[0] ?? '');
}

export function normalizeLanguages(languages: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of languages ?? []) {
    const t = raw.trim();
    if (!t || t.toLowerCase() === 'und') continue;
    const code = resolveLanguage(t)?.toUpperCase() ?? t;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Language list text, e.g. `[EN+DE]` (spec 7.6). `skipEnglishOnly` returns empty when the
 * filtered result is exactly English.
 */
export function languageListText(
  languages: readonly string[] | null | undefined,
  modifier: string | undefined,
  skipEnglishOnly: boolean,
): string {
  const present = normalizeLanguages(languages);
  let result = present;
  let andOthers = false;
  let mod = (modifier ?? '').trim();
  if (mod.endsWith('+')) {
    andOthers = true;
    mod = mod.slice(0, -1);
  }
  if (mod.startsWith('-')) {
    const excluded = mod.split('-').map((s) => s.trim().toUpperCase()).filter(Boolean);
    result = present.filter((l) => !excluded.includes(l.toUpperCase()));
  } else if (mod) {
    const wanted = mod.split('+').map((s) => s.trim().toUpperCase()).filter(Boolean);
    result = wanted.filter((w) => present.some((l) => l.toUpperCase() === w));
  }
  const filteredOut = result.length < present.length;
  if (skipEnglishOnly && result.length === 1 && result[0] === 'EN') return '';
  const items = [...result];
  if (andOthers && filteredOut) items.push(DOUBLE_DASH);
  if (items.length === 0) return '';
  return `[${items.join('+')}]`;
}
