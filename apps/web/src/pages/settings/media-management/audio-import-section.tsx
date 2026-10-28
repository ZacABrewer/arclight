import { useEffect, useState } from 'react';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Skeleton } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useAudioImportSettings, useFeatures, useSaveAudioImportSettings } from '../../../hooks/music.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/** Audio import knobs (GET/PUT /settings/audio), shown while music is on; saves on its own. */
export function AudioImportSection() {
  const features = useFeatures();
  if (!features.music) return null;
  return <AudioImportForm />;
}

function AudioImportForm() {
  const settings = useAudioImportSettings();
  const save = useSaveAudioImportSettings();
  const toast = useToast();
  const saved = settings.data ? Math.round(settings.data.trackMatchThreshold * 100) : null;
  const [percent, setPercent] = useState<string>('');
  useEffect(() => {
    if (saved !== null) setPercent(String(saved));
  }, [saved]);
  const value = Number(percent);
  const valid = percent.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100;
  const dirty = saved !== null && valid && value !== saved;

  return (
    <SettingsSection
      label={t('music.settings.audioImport')}
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            save.mutate({ trackMatchThreshold: value / 100 }, { onSuccess: () => toast.push({ tone: 'ok', title: t('music.settings.audioImportSaved') }) })
          }
        >
          {t('common.save')}
        </Button>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={1} />
      ) : settings.isError ? (
        <ErrorBlock title={t('music.settings.couldNotLoadAudio')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <FormRow
          label={t('music.settings.trackMatchThreshold')}
          htmlFor="audio-track-match"
          caption={t('music.settings.trackMatchThresholdCaption')}
          error={valid ? undefined : t('music.settings.percentRange')}
        >
          <Input id="audio-track-match" type="number" mono min={0} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} end="%" />
        </FormRow>
      )}
    </SettingsSection>
  );
}
