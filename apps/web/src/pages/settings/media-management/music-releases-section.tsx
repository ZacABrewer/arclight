import { useEffect, useState } from 'react';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useFeatures } from '../../../hooks/music.js';
import { useMusicReleasesSettings, useSaveMusicReleasesSettings } from '../../../hooks/music-acquisition.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/**
 * Discography packs (`releases.allowDiscographyPacks`, `minPackWanted`), shown while music is
 * on. The releases section is replaced as a whole on PUT, so the stored section is sent back
 * with the two music knobs changed. Saves on its own, like the audio import section.
 */
export function MusicReleasesSection() {
  const features = useFeatures();
  if (!features.music) return null;
  return <MusicReleasesForm />;
}

function MusicReleasesForm() {
  const settings = useMusicReleasesSettings();
  const save = useSaveMusicReleasesSettings();
  const toast = useToast();
  const [allow, setAllow] = useState(false);
  const [minWanted, setMinWanted] = useState('2');
  useEffect(() => {
    if (!settings.data) return;
    setAllow(settings.data.allowDiscographyPacks);
    setMinWanted(String(settings.data.minPackWanted));
  }, [settings.data]);
  const n = Number(minWanted);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;
  const dirty = settings.data !== undefined && valid && (allow !== settings.data.allowDiscographyPacks || n !== settings.data.minPackWanted);

  return (
    <SettingsSection
      label={t('music.releases.title')}
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            settings.data &&
            save.mutate({ ...settings.data, allowDiscographyPacks: allow, minPackWanted: n }, { onSuccess: () => toast.push({ tone: 'ok', title: t('music.releases.saved') }) })
          }
        >
          {t('common.save')}
        </Button>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={2} />
      ) : settings.isError ? (
        <ErrorBlock title={t('music.releases.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <>
          <FormRow label={t('music.releases.allowDiscographyPacks')} caption={t('music.releases.allowDiscographyPacksCaption')} captionInline>
            <Toggle aria-label={t('music.releases.allowDiscographyPacks')} checked={allow} onChange={(e) => setAllow(e.currentTarget.checked)} />
          </FormRow>
          <FormRow
            label={t('music.releases.minPackWanted')}
            htmlFor="music-min-pack-wanted"
            caption={t('music.releases.minPackWantedCaption')}
            error={valid ? undefined : t('music.releases.wholeNumberAtLeastOne')}
          >
            <Input
              id="music-min-pack-wanted"
              type="number"
              mono
              min={1}
              max={100}
              disabled={!allow}
              value={minWanted}
              onChange={(e) => setMinWanted(e.currentTarget.value)}
              end={t('music.albums').toLowerCase()}
            />
          </FormRow>
        </>
      )}
    </SettingsSection>
  );
}
