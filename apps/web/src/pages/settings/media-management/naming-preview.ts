// Client-side naming preview: renders a naming format against canned sample data so the
// FormRow caption ("→ Severance - S02E09 - The After Hours [WEBDL-2160p].mkv") updates as
// the user types. The server stays the authority on the real file names.

export type PreviewKind = 'episode' | 'daily' | 'anime' | 'seriesFolder' | 'seasonFolder' | 'specialsFolder' | 'movie' | 'movieFolder';

/** Sample values keyed by the normalised token name (lower case, no separators). */
export const SAMPLE_TOKENS: Readonly<Record<string, string | number>> = {
  seriestitle: 'Severance',
  seriestitleyear: 'Severance (2022)',
  seriescleantitle: 'Severance',
  seriestitlethe: 'Severance',
  seriescleantitleyear: 'Severance 2022',
  season: 2,
  episode: 9,
  absoluteepisode: 19,
  absolute: 19,
  episodetitle: 'The After Hours',
  episodecleantitle: 'The After Hours',
  qualityfull: 'WEBDL-2160p',
  qualitytitle: 'WEBDL-2160p',
  qualityproper: '',
  airdate: '2025-03-14',
  'air-date': '2025-03-14',
  releasegroup: 'NTb',
  mediainfosimple: 'h265 EAC3',
  mediainfovideocodec: 'h265',
  mediainfoaudiocodec: 'EAC3',
  mediainfovideodynamicrange: 'HDR',
  mediainfovideodynamicrangetype: 'DV HDR10',
  customformats: 'DV HDR10',
  imdbid: 'tt11280740',
  tvdbid: 371980,
  tmdbid: 95396,
  movietitle: 'Dune Part Two',
  movietitleyear: 'Dune Part Two (2024)',
  moviecleantitle: 'Dune Part Two',
  moviecleantitleyear: 'Dune Part Two 2024',
  releaseyear: 2024,
  year: 2024,
};

const MOVIE_OVERRIDES: Readonly<Record<string, string | number>> = {
  imdbid: 'tt15239678',
  tmdbid: 693134,
};

const FILE_KINDS: ReadonlySet<PreviewKind> = new Set(['episode', 'daily', 'anime', 'movie']);

function lookup(rawName: string, kind: PreviewKind): string | number | undefined {
  const name = rawName.trim().toLowerCase();
  const key = name.replace(/[\s._-]+/g, '');
  if (kind === 'movie' || kind === 'movieFolder') {
    if (key in MOVIE_OVERRIDES) return MOVIE_OVERRIDES[key];
  }
  if (name === 'air-date' || key === 'airdate') return SAMPLE_TOKENS.airdate;
  return SAMPLE_TOKENS[key];
}

/** Word separator implied by the token spelling: {Series.Title} → ".", {Series_Title} → "_". */
function separatorOf(name: string): string {
  const m = /[._]/.exec(name);
  return m ? m[0] : ' ';
}

/** Render one format against the sample data. Unknown tokens are left as written. */
export function renderPreview(format: string, kind: PreviewKind): string {
  const out = format.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    const [name = '', pad] = inner.split(':');
    const value = lookup(name, kind);
    if (value === undefined) return whole;
    if (typeof value === 'number') {
      const width = pad && /^0+$/.test(pad) ? pad.length : 0;
      return String(value).padStart(width, '0');
    }
    const sep = separatorOf(name);
    return sep === ' ' ? value : value.split(' ').join(sep);
  });
  const tidy = out
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!tidy) return '';
  return FILE_KINDS.has(kind) ? `${tidy}.mkv` : tidy;
}

/** The FormRow caption: "→ <name>", or a plain hint when the format is empty. */
export function previewCaption(format: string, kind: PreviewKind): string {
  const name = renderPreview(format, kind);
  return name ? `→ ${name}` : 'Enter a format to see a sample';
}
