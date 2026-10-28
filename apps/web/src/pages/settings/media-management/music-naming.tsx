import { useId } from 'react';
import { MultiDiscStyle, type NamingConfig } from '@arclight/shared';
import { FormRow, Input, Select, Toggle } from '../../../arclight/index.js';
import { useFeatures } from '../../../hooks/music.js';
import { SettingsSection } from '../shared.js';
import { musicPreview, previewCaption, type PreviewKind } from './naming-preview.js';
import { t } from '../../../i18n/index.js';

type MusicFormatKey = 'artistFolderFormat' | 'albumFolderFormat' | 'trackFormat' | 'multiDiscTrackFormat';

const MUSIC_FORMATS: ReadonlyArray<{ key: MusicFormatKey; kind: PreviewKind; readonly label: string }> = [
  { key: 'artistFolderFormat', kind: 'artistFolder', get label() { return t('music.naming.artistFolderFormat'); } },
  { key: 'albumFolderFormat', kind: 'albumFolder', get label() { return t('music.naming.albumFolderFormat'); } },
  { key: 'trackFormat', kind: 'track', get label() { return t('music.naming.trackFormat'); } },
  { key: 'multiDiscTrackFormat', kind: 'multiDiscTrack', get label() { return t('music.naming.multiDiscTrackFormat'); } },
];

const STYLE_LABELS: Record<MultiDiscStyle, string> = {
  get prefix() {
    return t('music.naming.multiDiscPrefix');
  },
  get subfolder() {
    return t('music.naming.multiDiscSubfolder');
  },
};

function MusicFormatRow({ label, testId, kind, value, disabled, onChange }: { label: string; testId: string; kind: PreviewKind; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={<span data-testid={`sample-${testId}`}>{previewCaption(value, kind)}</span>} captionMono>
      <Input id={id} mono value={value} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

/** Settings → Media management → Naming: the Music sub-section, shown while music is on. */
export function MusicNamingSection({
  value,
  set,
  disabled,
}: {
  value: NamingConfig;
  set: <K extends keyof NamingConfig>(k: K, v: NamingConfig[K]) => void;
  disabled: boolean;
}) {
  const features = useFeatures();
  const renameId = useId();
  const styleId = useId();
  if (!features.music) return null;
  return (
    <SettingsSection label={t('music.naming.title')}>
      <div className="al-mm-rows">
        <FormRow label={t('music.naming.renameTracks')} htmlFor={renameId} captionInline>
          <Toggle
            id={renameId}
            checked={value.renameTracks}
            disabled={disabled}
            label={t('settings.mediaManagement.renameImportedFilesUsingThe')}
            onChange={(e) => set('renameTracks', e.currentTarget.checked)}
          />
        </FormRow>
        {MUSIC_FORMATS.filter((f) => f.key !== 'multiDiscTrackFormat' || value.multiDiscStyle === 'prefix').map((f) => (
          <MusicFormatRow key={f.key} label={f.label} testId={f.key} kind={f.kind} value={value[f.key]} disabled={disabled} onChange={(v) => set(f.key, v)} />
        ))}
        <FormRow label={t('music.naming.multiDiscStyle')} htmlFor={styleId}>
          <Select
            id={styleId}
            className="al-mm-select"
            value={value.multiDiscStyle}
            disabled={disabled}
            options={MultiDiscStyle.options.map((o) => ({ value: o, label: STYLE_LABELS[o] }))}
            onChange={(e) => set('multiDiscStyle', MultiDiscStyle.parse(e.currentTarget.value))}
          />
        </FormRow>
        <FormRow label={t('music.naming.samplePaths')}>
          <span className="al-num al-mm-sample-paths">
            <span data-testid="sample-musicPath">{musicPreview(value, value.multiDiscStyle, false)}</span>
            <span data-testid="sample-musicMultiDiscPath">{musicPreview(value, value.multiDiscStyle, true)}</span>
          </span>
        </FormRow>
      </div>
    </SettingsSection>
  );
}
