import type { AnyMediaType } from '@arclight/shared';
import { t } from '../../i18n/index.js';

/**
 * Label of a root folder's media type. `series` reads "TV" by default; pages that call the
 * kind "Series" pass that word instead.
 */
export function rootKindLabel(mediaType: AnyMediaType | (string & {}), seriesLabel: string = t('common.tv')): string {
  switch (mediaType) {
    case 'series':
      return seriesLabel;
    case 'movie':
      return t('common.movies');
    case 'music':
      return t('common.music');
    case 'audiobook':
      return t('common.audiobooks');
    default:
      return mediaType;
  }
}
