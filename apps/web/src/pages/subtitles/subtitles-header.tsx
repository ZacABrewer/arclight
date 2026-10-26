import { useEffect, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader, Tabs } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

export type SubtitlesSection = 'wanted' | 'history' | 'blacklist';

const SECTIONS: { id: SubtitlesSection; label: string; to: '/subtitles/wanted' | '/subtitles/history' | '/subtitles/blacklist' }[] = [
  { id: 'wanted', get label() { return t('common.wanted'); }, to: '/subtitles/wanted' },
  { id: 'history', get label() { return t('common.history'); }, to: '/subtitles/history' },
  { id: 'blacklist', get label() { return t('common.blacklist'); }, to: '/subtitles/blacklist' },
];

/** `07 Subtitles` header with route-driven tabs (Wanted / History / Blacklist). */
export function SubtitlesHeader({ active, actions }: { active: SubtitlesSection; actions?: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = t('subtitles.header.subtitlesArclight');
  }, []);
  return (
    <PageHeader index="07" title={t('common.subtitles')} actions={actions}>
      <Tabs
        compact
        aria-label={t('subtitles.header.subtitlesSections')}
        value={active}
        tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => {
          const section = SECTIONS.find((s) => s.id === id);
          if (section && section.id !== active) void navigate({ to: section.to });
        }}
      />
    </PageHeader>
  );
}
