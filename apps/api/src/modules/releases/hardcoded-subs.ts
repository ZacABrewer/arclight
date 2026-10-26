// Hardcoded (burned-in) subtitle detection for release titles. The parser does not report
// it, so the decision engine tokenises the title itself. Markers recognised:
//   - a generic marker token: HC, HARDSUB(S/BED), HARDCODED, HCSUB(S); when the next token
//     is a language code the tag becomes `HC.<LANG>`;
//   - a language-prefixed subtitle token: KORSUB, ENGSUBS, CHSUB ... (prefix from a known list);
//   - SUBBED as a whole token (generic).
// Soft-subtitle tokens (Softsubs, MultiSubs, group names ending in "Subs") are not markers.

export interface HardcodedSubs {
  /** The marker as written in the title, upper-cased (`KORSUB`, `HC.ENG`, `HC`). */
  tag: string;
  /** Upper-case language code when the marker names one. */
  language?: string;
  /** True for a marker that names no language. */
  generic: boolean;
}

const GENERIC_MARKERS = new Set(['HC', 'HCSUB', 'HCSUBS', 'HARDSUB', 'HARDSUBS', 'HARDSUBBED', 'HARDCODED', 'HARDCODEDSUBS']);

/** Language prefixes seen in front of SUB/SUBS and after HC (two- and three-letter codes). */
const LANGUAGE_CODES = new Set([
  'ARA', 'AR', 'CHI', 'CHS', 'CHT', 'CH', 'CN', 'ZH', 'CZE', 'CZ', 'DAN', 'DK', 'DUT', 'NL', 'ENG', 'EN',
  'FIN', 'FI', 'FRE', 'FRA', 'FR', 'GER', 'DE', 'GRE', 'GR', 'HEB', 'HE', 'HIN', 'HI', 'HUN', 'HU',
  'ITA', 'IT', 'JAP', 'JPN', 'JP', 'KOR', 'KR', 'KO', 'NOR', 'NO', 'POL', 'PL', 'POR', 'PT', 'RUS', 'RU',
  'SPA', 'ESP', 'ES', 'SWE', 'SE', 'THA', 'TH', 'TUR', 'TR', 'VIE', 'VN',
]);

function tokens(title: string, releaseGroup: string | undefined): string[] {
  let t = title;
  // Drop a trailing "-GROUP" so a group literally named HC is not a marker.
  if (releaseGroup) {
    const suffix = `-${releaseGroup}`;
    if (t.toLowerCase().endsWith(suffix.toLowerCase())) t = t.slice(0, -suffix.length);
  }
  return t
    .split(/[\s._\-[\](){}+,]+/)
    .filter((s) => s !== '')
    .map((s) => s.toUpperCase());
}

export function detectHardcodedSubs(title: string, releaseGroup?: string): HardcodedSubs | null {
  const parts = tokens(title, releaseGroup);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i]!;
    if (GENERIC_MARKERS.has(tok)) {
      const next = parts[i + 1];
      if (next !== undefined && LANGUAGE_CODES.has(next)) return { tag: `HC.${next}`, language: next, generic: false };
      return { tag: tok, generic: true };
    }
    const m = /^([A-Z]{2,3})SUBS?$/.exec(tok);
    if (m && LANGUAGE_CODES.has(m[1]!)) return { tag: tok, language: m[1]!, generic: false };
    if (tok === 'SUBBED') return { tag: tok, generic: true };
  }
  return null;
}

function normalise(tag: string): string {
  return tag
    .trim()
    .toUpperCase()
    .split(/[\s._\-]+/)
    .filter((s) => s !== '')
    .join('.');
}

/**
 * Is a detected marker covered by the whitelist (Settings → Indexers)? An entry matches the
 * marker itself (`KORSUB`, `HC.ENG`; SUB and SUBS are equivalent), or its language (`KOR`,
 * `ENG`, or `HC.ENG` for any ENG marker). Generic markers only match an exact entry (`HC`).
 */
export function isWhitelistedHardcodedSubs(found: HardcodedSubs, whitelist: readonly string[]): boolean {
  const stem = (s: string) => s.replace(/SUBS$/, 'SUB');
  const tag = stem(normalise(found.tag));
  for (const raw of whitelist) {
    const entry = stem(normalise(raw));
    if (entry === '') continue;
    if (entry === tag) return true;
    if (found.language && (entry === found.language || entry === `HC.${found.language}`)) return true;
  }
  return false;
}
