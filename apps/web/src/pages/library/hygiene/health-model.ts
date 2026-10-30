import type { HealthFinding, HealthFindingType, HealthMediaType, HealthSeverity } from '@arclight/shared';
import type { ChipTone } from '../../../arclight/index.js';
import { intlLocale, t } from '../../../i18n/index.js';

// Pure helpers of the Health view (Library → Hygiene → Health) and the item Health tabs.

export const HEALTH_TYPES: readonly HealthFindingType[] = [
  'missing',
  'empty',
  'unreadable',
  'unparseable',
  'decodeErrors',
  'truncated',
  'sample',
  'noAudio',
  'noVideo',
  'wrongLanguage',
  'trackNumberMissing',
  'trackGaps',
  'bookParts',
];

const TYPE_LABEL: Record<HealthFindingType, string> = {
  missing: 'library.health.type.missing',
  empty: 'library.health.type.empty',
  unreadable: 'library.health.type.unreadable',
  unparseable: 'library.health.type.unparseable',
  decodeErrors: 'library.health.type.decodeErrors',
  truncated: 'library.health.type.truncated',
  sample: 'library.health.type.sample',
  noAudio: 'library.health.type.noAudio',
  noVideo: 'library.health.type.noVideo',
  wrongLanguage: 'library.health.type.wrongLanguage',
  trackNumberMissing: 'library.health.type.trackNumberMissing',
  trackGaps: 'library.health.type.trackGaps',
  bookParts: 'library.health.type.bookParts',
};

const SEVERITY_LABEL: Record<HealthSeverity, string> = {
  error: 'library.health.severity.error',
  warning: 'library.health.severity.warning',
  info: 'library.health.severity.info',
};

const MEDIA_LABEL: Record<HealthMediaType, string> = {
  series: 'library.health.media.series',
  movie: 'library.health.media.movie',
  music: 'library.health.media.music',
  audiobook: 'library.health.media.audiobook',
};

export const typeLabel = (type: HealthFindingType): string => t(TYPE_LABEL[type]);
export const severityLabel = (s: HealthSeverity): string => t(SEVERITY_LABEL[s]);
export const mediaLabel = (m: HealthMediaType): string => t(MEDIA_LABEL[m]);

export function severityTone(s: HealthSeverity): ChipTone {
  return s === 'error' ? 'danger' : s === 'warning' ? 'warn' : 'neutral';
}

/** "1:05:09" / "45:00". */
export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function languageNames(tags: readonly string[] | null | undefined): string {
  if (!tags?.length) return t('library.health.none');
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(intlLocale(), { type: 'language' });
  } catch {
    names = null;
  }
  return tags.map((tag) => names?.of(tag) ?? tag).join(', ');
}

/** The plain-language explanation of a finding, in the user's language. */
export function explain(f: Pick<HealthFinding, 'type' | 'data'>): string {
  const d = f.data;
  switch (f.type) {
    case 'missing':
      return t('library.health.explain.missing');
    case 'empty':
      return t('library.health.explain.empty');
    case 'unreadable':
      return t('library.health.explain.unreadable', { message: d.message ?? '' });
    case 'unparseable':
      return t('library.health.explain.unparseable', { message: d.message ?? '' });
    case 'decodeErrors':
      return d.mode === 'deep'
        ? t('library.health.explain.decodeErrorsDeep', { count: d.errorCount ?? 1 })
        : t('library.health.explain.decodeErrorsQuick', { count: d.errorCount ?? 1 });
    case 'truncated':
      return t('library.health.explain.truncated', { actual: clock(d.actualSeconds), expected: clock(d.expectedSeconds) });
    case 'sample':
      return t('library.health.explain.sample');
    case 'noAudio':
      return t('library.health.explain.noAudio');
    case 'noVideo':
      return t('library.health.explain.noVideo');
    case 'wrongLanguage':
      return d.missing?.length
        ? t('library.health.explain.languageMissing', { missing: languageNames(d.missing), have: languageNames(d.have) })
        : t('library.health.explain.languageWrong', { have: languageNames(d.have), wanted: languageNames(d.wanted) });
    case 'trackNumberMissing':
      return t('library.health.explain.trackNumberMissing');
    case 'trackGaps':
      return t('library.health.explain.trackGaps', { numbers: (d.missingNumbers ?? []).join(', '), disc: d.disc ?? 1 });
    case 'bookParts': {
      const parts: string[] = [];
      if (d.missingNumbers?.length) parts.push(t('library.health.explain.partsMissing', { numbers: d.missingNumbers.join(', ') }));
      if (d.duplicateNumbers?.length) parts.push(t('library.health.explain.partsDuplicate', { numbers: d.duplicateNumbers.join(', ') }));
      if (d.outOfOrder) parts.push(t('library.health.explain.partsOrder'));
      return t('library.health.explain.bookParts', { problems: parts.join('; ') });
    }
  }
}

/** Album and book findings have no single file: no replace or delete. */
export function hasFile(f: Pick<HealthFinding, 'source' | 'fileId'>): boolean {
  return f.source !== null && f.fileId !== null;
}

export interface HealthFilters {
  type: HealthFindingType | '';
  severity: HealthSeverity | '';
  mediaType: HealthMediaType | '';
}

export const NO_FILTERS: HealthFilters = { type: '', severity: '', mediaType: '' };

export function applyFilters(records: readonly HealthFinding[], f: HealthFilters): HealthFinding[] {
  return records.filter((r) => (!f.type || r.type === f.type) && (!f.severity || r.severity === f.severity) && (!f.mediaType || r.mediaType === f.mediaType));
}

export function activeFilterCount(f: HealthFilters): number {
  return [f.type, f.severity, f.mediaType].filter(Boolean).length;
}

/** Summary tiles: types that have open findings, most first. */
export function summaryTiles(byType: Partial<Record<HealthFindingType, number>>): Array<{ type: HealthFindingType; count: number }> {
  return HEALTH_TYPES.map((type) => ({ type, count: byType[type] ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
}

export type ItemLink =
  | { to: '/library/movie/$id'; params: { id: string } }
  | { to: '/library/series/$id'; params: { id: string } }
  | { to: '/library/music/album/$id'; params: { id: string } }
  | { to: '/library/audiobooks/book/$id'; params: { id: string } };

/** Link to the item a finding belongs to. */
export function itemLink(f: Pick<HealthFinding, 'seriesId' | 'movieId' | 'albumId' | 'bookId'>): ItemLink | null {
  if (f.movieId !== null) return { to: '/library/movie/$id', params: { id: String(f.movieId) } };
  if (f.seriesId !== null) return { to: '/library/series/$id', params: { id: String(f.seriesId) } };
  if (f.albumId !== null) return { to: '/library/music/album/$id', params: { id: String(f.albumId) } };
  if (f.bookId !== null) return { to: '/library/audiobooks/book/$id', params: { id: String(f.bookId) } };
  return null;
}
