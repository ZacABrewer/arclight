import { useId } from 'react';
import type { NamingConfig } from '@arclight/shared';
import { FormRow, Input, Toggle } from '../../../arclight/index.js';
import { useFeatures } from '../../../hooks/music.js';
import { SettingsSection } from '../shared.js';
import { audiobookPreview, previewCaption, type PreviewKind } from './naming-preview.js';
import { t } from '../../../i18n/index.js';

type AudiobookFormatKey = 'authorFolderFormat' | 'seriesBookFolderFormat' | 'bookFolderFormat' | 'bookFileFormat' | 'bookPartFormat';

const AUDIOBOOK_FORMATS: ReadonlyArray<{ key: AudiobookFormatKey; kind: PreviewKind; readonly label: string; readonly caption?: string }> = [
  { key: 'authorFolderFormat', kind: 'authorFolder', get label() { return t('audiobooks.naming.authorFolderFormat'); } },
  { key: 'seriesBookFolderFormat', kind: 'seriesBookFolder', get label() { return t('audiobooks.naming.seriesBookFolderFormat'); } },
  { key: 'bookFolderFormat', kind: 'bookFolder', get label() { return t('audiobooks.naming.bookFolderFormat'); } },
  { key: 'bookFileFormat', kind: 'bookFile', get label() { return t('audiobooks.naming.bookFileFormat'); } },
  { key: 'bookPartFormat', kind: 'bookPart', get label() { return t('audiobooks.naming.bookPartFormat'); } },
];

function FormatRow({ label, testId, kind, value, disabled, onChange }: { label: string; testId: string; kind: PreviewKind; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={<span data-testid={`sample-${testId}`}>{previewCaption(value, kind)}</span>} captionMono>
      <Input id={id} mono value={value} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

/** Settings → Media management → Naming: the Audiobooks sub-section, shown while audiobooks are on. */
export function AudiobookNamingSection({
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
  if (!features.audiobooks) return null;
  return (
    <SettingsSection label={t('audiobooks.naming.title')}>
      <div className="al-mm-rows">
        <FormRow label={t('audiobooks.naming.renameAudiobooks')} htmlFor={renameId} captionInline>
          <Toggle
            id={renameId}
            checked={value.renameAudiobooks}
            disabled={disabled}
            label={t('settings.mediaManagement.renameImportedFilesUsingThe')}
            onChange={(e) => set('renameAudiobooks', e.currentTarget.checked)}
          />
        </FormRow>
        {AUDIOBOOK_FORMATS.map((f) => (
          <FormatRow key={f.key} label={f.label} testId={f.key} kind={f.kind} value={value[f.key]} disabled={disabled} onChange={(v) => set(f.key, v)} />
        ))}
        <FormRow label={t('music.naming.samplePaths')}>
          <span className="al-num al-mm-sample-paths">
            <span data-testid="sample-audiobookSeriesPath">{audiobookPreview(value, 'series')}</span>
            <span data-testid="sample-audiobookPartsPath">{audiobookPreview(value, 'parts')}</span>
          </span>
        </FormRow>
      </div>
    </SettingsSection>
  );
}
