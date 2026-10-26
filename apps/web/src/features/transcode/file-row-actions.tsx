import type { MediaFile } from '@arclight/shared';
import { CrossSeedSearchButton } from '../cross-seed/cross-seed-search.js';
import { TranscodeNowButton } from './transcode-now.js';
import { t } from '../../i18n/index.js';

/** Admin actions on a library file row: Search cross-seeds and Transcode now (both hidden for non-admins). */
export function MediaFileRowActions({ file }: { file: Pick<MediaFile, 'id' | 'relativePath'> }) {
  return (
    <>
      <CrossSeedSearchButton
        target={{ mediaFileId: file.id }}
        size="sm"
        variant="ghost"
        aria-label={t('features.crossSeed.searchCrossSeedsFor', { file: file.relativePath })}
      />
      <TranscodeNowButton mediaFileId={file.id} fileLabel={file.relativePath} />
    </>
  );
}
