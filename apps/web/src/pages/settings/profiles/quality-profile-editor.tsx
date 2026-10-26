import { useId, useState } from 'react';
import { PROFILE_LANGUAGES, type CustomFormat, type QualityProfile, type QualityProfileInput } from '@arclight/shared';
import { Field, Input, Modal, ScoreTag, Select, Table, Toggle, type Column } from '../../../arclight/index.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { useDeleteQualityProfile, useSaveQualityProfile } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';
import { QualityItemList } from './quality-item-list.js';
import { cutoffOptions, formatScore, fromDisplay, setFormatScore, toDisplay, validateProfile, type ProfileErrors } from './quality-profile-model.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

export interface QualityProfileEditorProps {
  /** Existing profile, or null to create one from `template`. */
  profile: QualityProfile | null;
  template: QualityProfileInput;
  customFormats: readonly CustomFormat[];
  onClose: () => void;
}

const intOr = (text: string, fallback: number) => {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? fallback : n;
};

/** Dialog body + state for one quality profile. Mount it only while open (key by profile id). */
export function QualityProfileEditor({ profile, template, customFormats, onClose }: QualityProfileEditorProps) {
  const initial = profile ?? template;
  // `items` is held best-first while editing.
  const [draft, setDraft] = useState<QualityProfileInput>(() => ({ ...structuredClone(initial), items: toDisplay(initial.items) }));
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveQualityProfile();
  const remove = useDeleteQualityProfile();
  const upgradeId = useId();

  const set = <K extends keyof QualityProfileInput>(key: K, value: QualityProfileInput[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (Object.keys(errors).length) setErrors(validateProfile(next));
  };

  const submit = () => {
    const found = validateProfile(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    save.mutate({ id: profile?.id, body: { ...draft, items: fromDisplay(draft.items) } }, { onSuccess: onClose });
  };

  const cutoffs = cutoffOptions(draft.items);

  const scoreColumns: Column<CustomFormat>[] = [
    { key: 'name', header: t('settings.profiles.qualityProfileEditor.customFormat'), cell: (cf) => cf.name },
    {
      key: 'preview',
      header: t('settings.profiles.qualityProfileEditor.effect'),
      cell: (cf) => <ScoreTag name={cf.name} score={formatScore(draft.formatItems, cf.id)} />,
    },
    {
      key: 'score',
      header: t('common.score'),
      align: 'right',
      width: '140px',
      cell: (cf) => (
        <Input
          type="number"
          mono
          className="al-score-input"
          aria-label={t('settings.profiles.qualityProfileEditor.scoreForName', { name: cf.name })}
          value={formatScore(draft.formatItems, cf.id)}
          onChange={(e) => set('formatItems', setFormatScore(draft.formatItems, cf.id, intOr(e.currentTarget.value, 0)))}
        />
      ),
    },
  ];

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={640}
        title={profile ? t('settings.profiles.qualityProfileEditor.editName', { name: profile.name }) : t('settings.profiles.qualityProfileEditor.addQualityProfile')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={profile ? () => setConfirmDelete(true) : undefined}
            deleteLabel={t('settings.profiles.qualityProfileEditor.deleteProfile')}
          />
        }
      >
        <div className="al-profile-editor">
          <Field label={t('common.name')} error={errors.name}>
            <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <Toggle
            id={upgradeId}
            checked={draft.upgradeAllowed}
            label={t('settings.profiles.qualityProfileEditor.upgradesAllowedKeepGrabbingBetter')}
            onChange={(e) => set('upgradeAllowed', e.currentTarget.checked)}
          />
          <Field label={t('settings.profiles.qualityProfileEditor.upgradeUntil')} hint={t('settings.profiles.qualityProfileEditor.stopUpgradingOnceThisQuality')} error={errors.cutoff}>
            <Select
              value={String(draft.cutoff)}
              onChange={(e) => set('cutoff', Number(e.currentTarget.value))}
              options={cutoffs.map((o) => ({ value: String(o.value), label: o.label }))}
              {...(cutoffs.some((o) => o.value === draft.cutoff) ? {} : { placeholder: t('settings.profiles.qualityProfileEditor.chooseAnAllowedQuality') })}
            />
          </Field>

          <SettingsSection label={t('settings.profiles.qualityProfileEditor.qualities')}>
            {errors.items ? (
              <p className="al-inline-error" role="alert">
                {errors.items}
              </p>
            ) : null}
            <QualityItemList items={draft.items} cutoff={draft.cutoff} onChange={(items) => set('items', items)} />
          </SettingsSection>

          <SettingsSection label={t('settings.profiles.qualityProfileEditor.customFormatScores')}>
            <div className="al-profile-editor__scores">
              <Field label={t('settings.profiles.qualityProfileEditor.minimumScore')} hint={t('settings.profiles.qualityProfileEditor.releasesScoringBelowThisAre')}>
                <Input type="number" mono value={draft.minFormatScore} onChange={(e) => set('minFormatScore', intOr(e.currentTarget.value, 0))} />
              </Field>
              <Field label={t('settings.profiles.qualityProfileEditor.upgradeUntilScore')} hint={t('settings.profiles.qualityProfileEditor.stopUpgradingOnceAFile')}>
                <Input type="number" mono value={draft.cutoffFormatScore} onChange={(e) => set('cutoffFormatScore', intOr(e.currentTarget.value, 0))} />
              </Field>
              <Field label={t('settings.profiles.qualityProfileEditor.minimumIncrement')} hint={t('settings.profiles.qualityProfileEditor.anUpgradeMustBeatThe')} error={errors.minUpgradeFormatScore}>
                <Input
                  type="number"
                  mono
                  min={1}
                  value={draft.minUpgradeFormatScore}
                  onChange={(e) => set('minUpgradeFormatScore', intOr(e.currentTarget.value, 1))}
                />
              </Field>
            </div>
            {customFormats.length === 0 ? (
              <p className="al-muted">{t('settings.profiles.qualityProfileEditor.noCustomFormatsYetAdd')}</p>
            ) : (
              <Table columns={scoreColumns} rows={customFormats} rowKey={(cf) => cf.id} caption={t('settings.profiles.qualityProfileEditor.customFormatScores')} />
            )}
          </SettingsSection>

          <SettingsSection label={t('common.languages')}>
            <p className="al-caption">{t('settings.profiles.qualityProfileEditor.acceptedLanguagesNoneSelectedMeans')}</p>
            <div className="al-tag-toggles" role="group" aria-label={t('common.languages')}>
              {PROFILE_LANGUAGES.map((l) => {
                const on = draft.languages.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    className="al-tag al-tag-toggle"
                    aria-pressed={on}
                    onClick={() => set('languages', on ? draft.languages.filter((c) => c !== l.code) : [...draft.languages, l.code])}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </SettingsSection>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.profiles.qualityProfileEditor.deleteName', { name: profile.name })}
          confirmLabel={t('settings.profiles.qualityProfileEditor.deleteProfile')}
          onCancel={() => setConfirmDelete(false)}
          describeError={(err) => inUseMessage(err, 'quality profile')}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>{t('settings.profiles.qualityProfileEditor.thisCannotBeUndone')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
