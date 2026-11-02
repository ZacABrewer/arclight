import { useEffect, useState } from 'react';
import type { AudioImportSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useAudioImportSettings, useFeatures, useSaveAudioImportSettings } from '../../../hooks/music.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

type CueHandling = AudioImportSettings['cueHandling'];

/**
 * Audio import knobs (GET/PUT /settings/audio), shown while music or audiobooks are on; saves
 * on its own. The PUT sends the whole stored section back, so the music and audiobook fields
 * never overwrite each other.
 */
export function AudioImportSection() {
  const features = useFeatures();
  if (!features.music && !features.audiobooks) return null;
  return <AudioImportForm music={features.music} audiobooks={features.audiobooks} />;
}

interface Draft {
  threshold: string;
  tolerance: string;
  renameParts: boolean;
  sidecars: boolean;
  cueHandling: CueHandling;
  writeTags: boolean;
  embedCoverArt: boolean;
  saveCoverArt: boolean;
  replayGain: boolean;
}

/** Music toggles that map one-to-one onto the stored section, with their label and caption keys. */
const MUSIC_FLAG_ROWS = [
  ['writeTags', 'music.settings.writeTags', 'music.settings.writeTagsCaption'],
  ['embedCoverArt', 'music.settings.embedCoverArt', 'music.settings.embedCoverArtCaption'],
  ['saveCoverArt', 'music.settings.saveCoverArt', 'music.settings.saveCoverArtCaption'],
  ['replayGain', 'music.settings.replayGain', 'music.settings.replayGainCaption'],
] as const;
const MUSIC_FLAGS = MUSIC_FLAG_ROWS.map(([k]) => k);

const toDraft = (s: AudioImportSettings): Draft => ({
  threshold: String(Math.round(s.trackMatchThreshold * 100)),
  tolerance: String(s.audiobookDurationTolerance),
  renameParts: s.renameAudiobookParts,
  sidecars: s.writeAbsSidecars,
  cueHandling: s.cueHandling,
  writeTags: s.writeTags,
  embedCoverArt: s.embedCoverArt,
  saveCoverArt: s.saveCoverArt,
  replayGain: s.replayGain,
});

const percentOk = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;

/** Draft -> PUT body: the stored section with the edited fields. */
export function toAudioImportUpdate(saved: AudioImportSettings, d: Draft): AudioImportSettings {
  return {
    ...saved,
    trackMatchThreshold: Number(d.threshold) / 100,
    audiobookDurationTolerance: Number(d.tolerance),
    renameAudiobookParts: d.renameParts,
    writeAbsSidecars: d.sidecars,
    cueHandling: d.cueHandling,
    writeTags: d.writeTags,
    embedCoverArt: d.embedCoverArt,
    saveCoverArt: d.saveCoverArt,
    replayGain: d.replayGain,
  };
}

function AudioImportForm({ music, audiobooks }: { music: boolean; audiobooks: boolean }) {
  const settings = useAudioImportSettings();
  const save = useSaveAudioImportSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data));
  }, [settings.data]);
  const saved = settings.data ? toDraft(settings.data) : null;
  const valid = draft !== null && percentOk(draft.threshold) && percentOk(draft.tolerance);
  const dirty =
    saved !== null &&
    draft !== null &&
    valid &&
    (Number(draft.threshold) !== Number(saved.threshold) ||
      Number(draft.tolerance) !== Number(saved.tolerance) ||
      draft.renameParts !== saved.renameParts ||
      draft.sidecars !== saved.sidecars ||
      draft.cueHandling !== saved.cueHandling ||
      MUSIC_FLAGS.some((k) => draft[k] !== saved[k]));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

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
            settings.data &&
            draft &&
            save.mutate(toAudioImportUpdate(settings.data, draft), { onSuccess: () => toast.push({ tone: 'ok', title: t('music.settings.audioImportSaved') }) })
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
      ) : draft ? (
        <>
          {music ? (
            <FormRow
              label={t('music.settings.trackMatchThreshold')}
              htmlFor="audio-track-match"
              caption={t('music.settings.trackMatchThresholdCaption')}
              error={percentOk(draft.threshold) ? undefined : t('music.settings.percentRange')}
            >
              <Input id="audio-track-match" type="number" mono min={0} max={100} value={draft.threshold} onChange={(e) => set('threshold', e.target.value)} end="%" />
            </FormRow>
          ) : null}
          {music ? (
            <>
              <FormRow label={t('music.settings.cueHandling')} htmlFor="audio-cue-handling" caption={t('music.settings.cueHandlingCaption')}>
                <Select
                  id="audio-cue-handling"
                  className="al-mm-select"
                  value={draft.cueHandling}
                  options={[
                    { value: 'split', label: t('music.settings.cueSplit') },
                    { value: 'keepImage', label: t('music.settings.cueKeepImage') },
                    { value: 'manual', label: t('music.settings.cueManual') },
                  ]}
                  onChange={(e) => set('cueHandling', e.currentTarget.value as CueHandling)}
                />
              </FormRow>
              {MUSIC_FLAG_ROWS.map(([k, label, caption]) => (
                <FormRow key={k} label={t(label)} htmlFor={`audio-${k}`} caption={t(caption)} captionInline>
                  <Toggle id={`audio-${k}`} checked={draft[k]} onChange={(e) => set(k, e.currentTarget.checked)} />
                </FormRow>
              ))}
            </>
          ) : null}
          {audiobooks ? (
            <>
              <FormRow
                label={t('audiobooks.settings.durationTolerance')}
                htmlFor="audio-duration-tolerance"
                caption={t('audiobooks.settings.durationToleranceCaption')}
                error={percentOk(draft.tolerance) ? undefined : t('music.settings.percentRange')}
              >
                <Input
                  id="audio-duration-tolerance"
                  type="number"
                  mono
                  min={0}
                  max={100}
                  value={draft.tolerance}
                  onChange={(e) => set('tolerance', e.target.value)}
                  end="%"
                />
              </FormRow>
              <FormRow label={t('audiobooks.settings.renameParts')} htmlFor="audio-rename-parts" caption={t('audiobooks.settings.renamePartsCaption')} captionInline>
                <Toggle id="audio-rename-parts" checked={draft.renameParts} onChange={(e) => set('renameParts', e.currentTarget.checked)} />
              </FormRow>
              <FormRow label={t('audiobooks.settings.writeSidecars')} htmlFor="audio-sidecars" caption={t('audiobooks.settings.writeSidecarsCaption')} captionInline>
                <Toggle id="audio-sidecars" checked={draft.sidecars} onChange={(e) => set('sidecars', e.currentTarget.checked)} />
              </FormRow>
            </>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
