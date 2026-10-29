import { useEffect, useState } from 'react';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useFeatures } from '../../../hooks/music.js';
import { useMusicReleasesSettings, useSaveMusicReleasesSettings } from '../../../hooks/music-acquisition.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/**
 * Book packs and abridged recordings (`releases.allowBookPacks`, `allowAbridged`), shown while
 * audiobooks are on. The releases section is replaced as a whole on PUT, so the stored section
 * is sent back with the two audiobook knobs changed (packs share `minPackWanted` with music).
 */
export function AudiobookReleasesSection() {
  const features = useFeatures();
  if (!features.audiobooks) return null;
  return <AudiobookReleasesForm />;
}

function AudiobookReleasesForm() {
  const settings = useMusicReleasesSettings();
  const save = useSaveMusicReleasesSettings();
  const toast = useToast();
  const [packs, setPacks] = useState(false);
  const [abridged, setAbridged] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setPacks(settings.data.allowBookPacks);
    setAbridged(settings.data.allowAbridged);
  }, [settings.data]);
  const dirty = settings.data !== undefined && (packs !== settings.data.allowBookPacks || abridged !== settings.data.allowAbridged);

  return (
    <SettingsSection
      label={t('audiobooks.releases.title')}
      action={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            settings.data &&
            save.mutate({ ...settings.data, allowBookPacks: packs, allowAbridged: abridged }, { onSuccess: () => toast.push({ tone: 'ok', title: t('audiobooks.releases.saved') }) })
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
          <FormRow label={t('audiobooks.releases.allowBookPacks')} caption={t('audiobooks.releases.allowBookPacksCaption')} captionInline>
            <Toggle aria-label={t('audiobooks.releases.allowBookPacks')} checked={packs} onChange={(e) => setPacks(e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('audiobooks.releases.allowAbridged')} caption={t('audiobooks.releases.allowAbridgedCaption')} captionInline>
            <Toggle aria-label={t('audiobooks.releases.allowAbridged')} checked={abridged} onChange={(e) => setAbridged(e.currentTarget.checked)} />
          </FormRow>
        </>
      )}
    </SettingsSection>
  );
}
