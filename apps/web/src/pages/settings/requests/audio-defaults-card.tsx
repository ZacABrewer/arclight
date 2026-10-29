import { useId } from 'react';
import type { AudioRequestDefaults, QualityProfile, RootFolder } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Select, Skeleton } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useAudioRequestDefaults, useSaveAudioRequestDefaults } from '../../../hooks/audio-requests.js';
import { useAudiobookQualityProfiles } from '../../../hooks/audiobooks.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useFeatures, useMusicQualityProfiles } from '../../../hooks/music.js';
import { useDraft, type Draft } from '../settings-layout.js';
import { SaveError, SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

type AudioKind = keyof AudioRequestDefaults;
type DomainDefaults = AudioRequestDefaults[AudioKind];

/**
 * Default root folder and quality profile for music and audiobook requests
 * (GET/PUT /settings/audiorequests). Each half shows only while its feature flag is on;
 * the card is hidden when both are off. It saves on its own, like the sliders card.
 */
export function AudioDefaultsCard() {
  const features = useFeatures();
  if (!features.music && !features.audiobooks) return null;
  return <AudioDefaultsForm music={features.music} audiobooks={features.audiobooks} />;
}

function AudioDefaultsForm({ music, audiobooks }: { music: boolean; audiobooks: boolean }) {
  const query = useAudioRequestDefaults();
  const save = useSaveAudioRequestDefaults();
  const toast = useToast();
  const draft = useDraft<AudioRequestDefaults | null>(query.data ?? null);
  const folders = useRootFolders();
  const musicProfiles = useMusicQualityProfiles(music);
  const bookProfiles = useAudiobookQualityProfiles(audiobooks);

  const submit = () => {
    if (!draft.value) return;
    save.mutate(draft.value, {
      onSuccess: () => toast.push({ tone: 'ok', title: t('settings.requests.audioDefaults.saved') }),
    });
  };

  return (
    <SettingsSection
      label={t('settings.requests.audioDefaults.title')}
      action={
        <Button size="sm" variant="secondary" disabled={!draft.dirty} loading={save.isPending} onClick={submit}>
          {t('common.save')}
        </Button>
      }
    >
      {query.isError ? (
        <ErrorBlock title={t('settings.requests.audioDefaults.couldNotLoad')} onRetry={() => void query.refetch()}>
          {errorMessage(query.error)}
        </ErrorBlock>
      ) : !draft.value ? (
        <Skeleton lines={4} />
      ) : (
        <>
          {music ? (
            <DomainFields
              kind="music"
              title={t('common.music')}
              draft={draft as Draft<AudioRequestDefaults>}
              folders={(folders.data ?? []).filter((f) => f.mediaType === 'music')}
              profiles={musicProfiles.data ?? []}
            />
          ) : null}
          {audiobooks ? (
            <DomainFields
              kind="audiobook"
              title={t('common.audiobooks')}
              draft={draft as Draft<AudioRequestDefaults>}
              folders={(folders.data ?? []).filter((f) => f.mediaType === 'audiobook')}
              profiles={bookProfiles.data ?? []}
            />
          ) : null}
          <SaveError error={save.error} />
        </>
      )}
    </SettingsSection>
  );
}

function DomainFields({
  kind,
  title,
  draft,
  folders,
  profiles,
}: {
  kind: AudioKind;
  title: string;
  draft: Draft<AudioRequestDefaults>;
  folders: readonly RootFolder[];
  profiles: readonly QualityProfile[];
}) {
  const ids = useId();
  const value = draft.value[kind];
  const set = <K extends keyof DomainDefaults>(k: K, v: DomainDefaults[K]) => draft.set((d) => ({ ...d, [kind]: { ...d[kind], [k]: v } }));
  const path = value.rootFolderPath;
  const profileId = value.qualityProfileId;
  return (
    <>
      <FormRow label={t('settings.requests.audioDefaults.titleRootFolder', { title })} htmlFor={`${ids}-root`}>
        <Select
          id={`${ids}-root`}
          className="al-select--fit al-mono"
          value={path ?? ''}
          onChange={(e) => set('rootFolderPath', e.currentTarget.value || null)}
        >
          <option value="">{t('settings.requests.audioDefaults.automatic')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.path}>
              {f.path}
            </option>
          ))}
          {path && !folders.some((f) => f.path === path) ? <option value={path}>{path}</option> : null}
        </Select>
      </FormRow>
      <FormRow label={t('settings.requests.audioDefaults.titleQualityProfile', { title })} htmlFor={`${ids}-profile`}>
        <Select
          id={`${ids}-profile`}
          className="al-select--fit"
          value={profileId === null ? '' : String(profileId)}
          onChange={(e) => set('qualityProfileId', e.currentTarget.value ? Number(e.currentTarget.value) : null)}
        >
          <option value="">{t('settings.requests.audioDefaults.automatic')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
          {profileId !== null && !profiles.some((p) => p.id === profileId) ? <option value={String(profileId)}>{`#${profileId}`}</option> : null}
        </Select>
      </FormRow>
    </>
  );
}
