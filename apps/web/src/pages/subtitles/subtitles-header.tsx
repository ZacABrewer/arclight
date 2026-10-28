import { useEffect, type ReactNode } from 'react';
import { PageHeader } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

export type SubtitlesSection = 'wanted' | 'history' | 'blacklist';

/** `07 Subtitles` header; the sections (Wanted / History / Blacklist) are in the shell's sub-navigation. */
export function SubtitlesHeader({ actions }: { active: SubtitlesSection; actions?: ReactNode }) {
  useEffect(() => {
    document.title = t('subtitles.header.subtitlesArclight');
  }, []);
  return (
    <PageHeader index="07" title={t('common.subtitles')} actions={actions} />
  );
}
