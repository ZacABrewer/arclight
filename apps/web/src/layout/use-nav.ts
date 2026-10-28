import { useMemo } from 'react';
import { useFeatureSettings } from '../hooks/music.js';
import { navFor, type NavSection } from '../nav.js';

/** The navigation tree with feature-gated pages (Library → Music) shown only while their flag is on. */
export function useNav(): readonly NavSection[] {
  const features = useFeatureSettings();
  return useMemo(() => navFor(features.data), [features.data]);
}
