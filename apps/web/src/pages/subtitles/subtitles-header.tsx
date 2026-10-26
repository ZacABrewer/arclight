import { useEffect, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader, Tabs } from '../../arclight/index.js';

export type SubtitlesSection = 'wanted' | 'history' | 'blacklist';

const SECTIONS: { id: SubtitlesSection; label: string; to: '/subtitles/wanted' | '/subtitles/history' | '/subtitles/blacklist' }[] = [
  { id: 'wanted', label: 'Wanted', to: '/subtitles/wanted' },
  { id: 'history', label: 'History', to: '/subtitles/history' },
  { id: 'blacklist', label: 'Blacklist', to: '/subtitles/blacklist' },
];

/** `07 Subtitles` header with route-driven tabs (Wanted / History / Blacklist). */
export function SubtitlesHeader({ active, actions }: { active: SubtitlesSection; actions?: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = 'Subtitles · Arclight';
  }, []);
  return (
    <PageHeader index="07" title="Subtitles" actions={actions}>
      <Tabs
        compact
        aria-label="Subtitles sections"
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
