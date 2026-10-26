import { useState } from 'react';
import { PROFILE_LANGUAGES, type CustomFormat, type QualityProfile, type QualityProfileInput } from '@arclight/shared';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { Modal } from '../../../components/modal.js';
import { useDeleteQualityProfile, useSaveQualityProfile } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError } from '../shared.js';
import { QualityItemList } from './quality-item-list.js';
import { cutoffOptions, formatScore, fromDisplay, setFormatScore, toDisplay, validateProfile, type ProfileErrors } from './quality-profile-model.js';

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

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={profile ? `Edit ${profile.name}` : 'Add quality profile'}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={profile ? () => setConfirmDelete(true) : undefined}
          />
        }
      >
        <div className="editor-columns">
          <div>
            <FormField label="Name" error={errors.name}>
              <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
            </FormField>
            <FormField label="Upgrades allowed" hint="Keep grabbing better releases until the cutoff is met.">
              <Toggle checked={draft.upgradeAllowed} onChange={(e) => set('upgradeAllowed', e.currentTarget.checked)} />
            </FormField>
            <FormField label="Upgrade until" hint="Stop upgrading once this quality is reached." error={errors.cutoff}>
              <Select
                value={String(draft.cutoff)}
                onChange={(e) => set('cutoff', Number(e.currentTarget.value))}
                options={cutoffs.map((o) => ({ value: String(o.value), label: o.label }))}
                {...(cutoffs.some((o) => o.value === draft.cutoff) ? {} : { placeholder: 'Choose an allowed quality' })}
              />
            </FormField>
            <FormField label="Minimum custom format score" hint="Releases scoring below this are rejected.">
              <Input type="number" value={draft.minFormatScore} onChange={(e) => set('minFormatScore', intOr(e.currentTarget.value, 0))} />
            </FormField>
            <FormField label="Upgrade until custom format score" hint="Stop upgrading once a file reaches this score.">
              <Input
                type="number"
                value={draft.cutoffFormatScore}
                onChange={(e) => set('cutoffFormatScore', intOr(e.currentTarget.value, 0))}
              />
            </FormField>
            <FormField
              label="Minimum custom format score increment"
              hint="An upgrade must beat the current file's score by at least this much."
              error={errors.minUpgradeFormatScore}
            >
              <Input
                type="number"
                min={1}
                value={draft.minUpgradeFormatScore}
                onChange={(e) => set('minUpgradeFormatScore', intOr(e.currentTarget.value, 1))}
              />
            </FormField>
            <FormField label="Languages" hint="Accepted languages. None selected means any language.">
              <div className="chip-group" role="group" aria-label="Languages">
                {PROFILE_LANGUAGES.map((l) => {
                  const on = draft.languages.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      type="button"
                      className={`chip ${on ? 'chip-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => set('languages', on ? draft.languages.filter((c) => c !== l.code) : [...draft.languages, l.code])}
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </FormField>
          </div>
          <div>
            <h3 className="section-title">Qualities</h3>
            {errors.items ? (
              <p className="inline-error" role="alert">
                {errors.items}
              </p>
            ) : null}
            <QualityItemList items={draft.items} onChange={(items) => set('items', items)} />
          </div>
        </div>

        <h3 className="section-title">Custom format scores</h3>
        {customFormats.length === 0 ? (
          <p className="muted">No custom formats yet. Add some under Settings → Custom Formats.</p>
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Custom format</th>
                <th className="align-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {customFormats.map((cf) => (
                <tr key={cf.id}>
                  <td>{cf.name}</td>
                  <td className="align-right">
                    <Input
                      type="number"
                      className="input-narrow"
                      aria-label={`Score for ${cf.name}`}
                      value={formatScore(draft.formatItems, cf.id)}
                      onChange={(e) => set('formatItems', setFormatScore(draft.formatItems, cf.id, intOr(e.currentTarget.value, 0)))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <SaveError error={save.error} />
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${profile.name}?`}
          onCancel={() => setConfirmDelete(false)}
          describeError={(err) => inUseMessage(err, 'quality profile')}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
