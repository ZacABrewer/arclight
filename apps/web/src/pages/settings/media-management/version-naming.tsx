import { useId } from 'react';
import type { NamingConfig } from '@arclight/shared';
import { FormRow, Select } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { SettingsSection } from '../shared.js';
import { hasVersionToken, versionedPreview, type VersionLayout } from './naming-preview.js';

/** The sample version tag the previews use. */
export const SAMPLE_VERSION_TAG = '4K';

/** Sample paths for an episode and a movie kept as version `tag` under the chosen layout. */
export function versionSamples(naming: NamingConfig, layout: VersionLayout, tag = SAMPLE_VERSION_TAG): { episode: string; movie: string } {
  return {
    episode: versionedPreview(
      { format: naming.standardEpisodeFormat, kind: 'episode' },
      [
        { format: naming.seriesFolderFormat, kind: 'seriesFolder' },
        ...(naming.seasonFolderFormat ? [{ format: naming.seasonFolderFormat, kind: 'seasonFolder' as const }] : []),
      ],
      layout,
      tag,
    ),
    movie: versionedPreview({ format: naming.movieFormat, kind: 'movie' }, [{ format: naming.movieFolderFormat, kind: 'movieFolder' }], layout, tag),
  };
}

/** Settings -> Media management: how multi-version items are laid out on disk. */
export function VersionNamingSection({
  value,
  set,
  disabled,
}: {
  value: NamingConfig;
  set: (k: 'versionLayout', v: VersionLayout) => void;
  disabled: boolean;
}) {
  const t = useT();
  const id = useId();
  const layout: VersionLayout = value.versionLayout ?? 'sideBySide';
  const samples = versionSamples(value, layout);
  const tokenUsed = hasVersionToken(value.standardEpisodeFormat) || hasVersionToken(value.movieFormat);
  const tokenHelp = t('settings.mediaManagement.versions.tokenHelp');
  return (
    <SettingsSection label={t('settings.mediaManagement.versions.title')}>
      <div className="al-mm-rows">
        <FormRow
          label={t('settings.mediaManagement.versions.layout')}
          htmlFor={id}
          caption={layout === 'sideBySide' ? t('settings.mediaManagement.versions.sideBySideHint') : t('settings.mediaManagement.versions.subfolderHint')}
        >
          <Select
            id={id}
            className="al-mm-select"
            value={layout}
            disabled={disabled}
            onChange={(e) => set('versionLayout', e.currentTarget.value === 'subfolder' ? 'subfolder' : 'sideBySide')}
            options={[
              { value: 'sideBySide', label: t('settings.mediaManagement.versions.sideBySide') },
              { value: 'subfolder', label: t('settings.mediaManagement.versions.subfolder') },
            ]}
          />
        </FormRow>
        <FormRow label={t('settings.mediaManagement.versions.token')} caption={tokenUsed ? t('settings.mediaManagement.versions.tokenInUse') : tokenHelp}>
          <code className="al-num">{'{Version}'}</code>
        </FormRow>
        <FormRow label={t('settings.mediaManagement.versions.episodeSample', { tag: SAMPLE_VERSION_TAG })}>
          <span className="al-num al-mm-version-sample" data-testid="version-sample-episode">
            {samples.episode}
          </span>
        </FormRow>
        <FormRow label={t('settings.mediaManagement.versions.movieSample', { tag: SAMPLE_VERSION_TAG })}>
          <span className="al-num al-mm-version-sample" data-testid="version-sample-movie">
            {samples.movie}
          </span>
        </FormRow>
      </div>
    </SettingsSection>
  );
}
