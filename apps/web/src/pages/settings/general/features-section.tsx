import { ErrorBlock, FormRow, Skeleton, Toggle } from '../../../arclight/index.js';
import { errorMessage } from '../../../api/client.js';
import { useToast } from '../../../components/toast.js';
import { FEATURES_OFF, useFeatureSettings, useSaveFeatures } from '../../../hooks/music.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/**
 * Optional media types (GET/PUT /settings/features). Each toggle saves at once: turning Music
 * on adds Library → Music, the Music tab of Add New, music root folders, album calendar items
 * and wanted albums (Audiobooks likewise for authors, books and series); off hides them again
 * (nothing is deleted).
 */
export function FeaturesSection() {
  const features = useFeatureSettings();
  const save = useSaveFeatures();
  const toast = useToast();
  const value = features.data ?? FEATURES_OFF;

  return (
    <SettingsSection label={t('music.settings.features')}>
      {features.isPending ? (
        <Skeleton lines={2} />
      ) : features.isError ? (
        <ErrorBlock title={t('music.settings.couldNotLoadFeatures')} onRetry={() => void features.refetch()}>
          {errorMessage(features.error)}
        </ErrorBlock>
      ) : (
        <>
          <FormRow label={t('common.music')} htmlFor="feature-music" captionInline caption={t('music.settings.musicCaption')}>
            <Toggle
              id="feature-music"
              checked={value.music}
              disabled={save.isPending}
              onChange={(e) => {
                const music = e.target.checked;
                save.mutate(
                  { ...value, music },
                  { onSuccess: () => toast.push({ tone: 'ok', title: music ? t('music.settings.musicOn') : t('music.settings.musicOff') }) },
                );
              }}
            />
          </FormRow>
          <FormRow label={t('common.audiobooks')} htmlFor="feature-audiobooks" captionInline caption={t('music.settings.audiobooksCaption')}>
            <Toggle
              id="feature-audiobooks"
              checked={value.audiobooks}
              disabled={save.isPending}
              onChange={(e) => {
                const audiobooks = e.target.checked;
                save.mutate(
                  { ...value, audiobooks },
                  { onSuccess: () => toast.push({ tone: 'ok', title: audiobooks ? t('audiobooks.settings.audiobooksOn') : t('audiobooks.settings.audiobooksOff') }) },
                );
              }}
            />
          </FormRow>
        </>
      )}
    </SettingsSection>
  );
}
