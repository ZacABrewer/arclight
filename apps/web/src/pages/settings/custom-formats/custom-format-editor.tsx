import { useState } from 'react';
import {
  CustomFormatSpec,
  type CustomFormat,
  type CustomFormatInput,
  type SpecImplementationDefinition,
} from '@arclight/shared';
import { Button, Chip, Field, Icon, Input, Modal, Select, Textarea, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldErrors } from '../../../components/forms/types.js';
import { initialValues, validateFields } from '../../../components/forms/values.js';
import { useDeleteCustomFormat, useSaveCustomFormat } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';
import { exportCustomFormat } from './custom-format-json.js';
import { AudioSpecEditor, audioSpecErrors, editorSchema, isAudioSpec } from './audio-spec-editors.js';
import { useFeatures } from '../../../hooks/music.js';
import { customFormatDomain } from '../../../lib/custom-format-domain.js';
import { domainLabel } from '../profiles/quality-profile-model.js';
import { CustomFormatTestBox } from './custom-format-test-box.js';
import './custom-formats.css';
import { t } from '../../../i18n/index.js';

type SpecDraft = { implementation: string; name: string; negate: boolean; required: boolean; fields: Record<string, unknown> };

export function specFields(def: SpecImplementationDefinition | undefined): FieldDefinition[] {
  return (def?.fields ?? []).map((f) => ({ ...f, required: f.type !== 'checkbox' && f.type !== 'multiSelect' }));
}

/** A blank spec of the given implementation with every field default filled in. */
export function newSpec(def: SpecImplementationDefinition): SpecDraft {
  return { implementation: def.implementation, name: def.label, negate: false, required: false, fields: initialValues(specFields(def)) };
}

/** Validate drafts against the shared spec union; returns per-spec field errors or a message. */
export function validateSpecs(
  specs: readonly SpecDraft[],
  schema: readonly SpecImplementationDefinition[],
): { fieldErrors: FieldErrors[]; parsed: CustomFormatSpec[] | null } {
  const fieldErrors = specs.map((s) =>
    isAudioSpec(s.implementation) ? audioSpecErrors(s.implementation, s.fields) : validateFields(specFields(schema.find((d) => d.implementation === s.implementation)), s.fields),
  );
  const results = specs.map((s) => CustomFormatSpec.safeParse(s));
  if (fieldErrors.some((e) => Object.keys(e).length) || results.some((r) => !r.success)) {
    results.forEach((r, i) => {
      if (!r.success && Object.keys(fieldErrors[i]!).length === 0) {
        const issue = r.error.issues[0];
        const key = issue?.path[0] === 'fields' ? String(issue.path[1] ?? '') : '';
        fieldErrors[i] = { ...fieldErrors[i], [key || '_spec']: issue?.message ?? t('settings.customFormats.customFormatEditor.invalidSpecification') };
      }
    });
    return { fieldErrors, parsed: null };
  }
  return { fieldErrors, parsed: results.map((r) => r.data!) };
}

export interface CustomFormatEditorProps {
  format: CustomFormat | null;
  /** Prefill for a new format (e.g. a single imported one). */
  initial?: CustomFormatInput | undefined;
  schema: readonly SpecImplementationDefinition[];
  onClose: () => void;
}

export function CustomFormatEditor({ format, initial, schema: serverSchema, onClose }: CustomFormatEditorProps) {
  const start = format ?? initial ?? { name: '', includeWhenRenaming: false, specifications: [] };
  const features = useFeatures();
  const [name, setName] = useState(start.name);
  const [includeWhenRenaming, setIncludeWhenRenaming] = useState(start.includeWhenRenaming);
  const [specs, setSpecs] = useState<SpecDraft[]>(() => structuredClone(start.specifications) as SpecDraft[]);
  const [specErrors, setSpecErrors] = useState<FieldErrors[]>([]);
  const [nameError, setNameError] = useState<string>();
  const [showJson, setShowJson] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveCustomFormat();
  const remove = useDeleteCustomFormat();

  // The server's kinds plus the audio editors, gated by the music / audiobooks flags.
  const schema = editorSchema(serverSchema, features, start.specifications.map((x) => x.implementation));
  const domain = customFormatDomain({ specifications: specs as CustomFormatSpec[] });
  const updateSpec = (index: number, patch: Partial<SpecDraft>) => setSpecs((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = () => {
    const { fieldErrors, parsed } = validateSpecs(specs, schema);
    setSpecErrors(fieldErrors);
    setNameError(name.trim() ? undefined : t('common.nameIsRequired'));
    if (!name.trim() || !parsed) return;
    save.mutate({ id: format?.id, body: { name: name.trim(), includeWhenRenaming, specifications: parsed } }, { onSuccess: onClose });
  };

  const json = JSON.stringify(exportCustomFormat({ name, includeWhenRenaming, specifications: specs as CustomFormatSpec[] }), null, 2);

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={format ? t('settings.customFormats.customFormatEditor.editName', { name: format.name }) : t('settings.customFormats.customFormatEditor.addCustomFormat')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={format ? () => setConfirmDelete(true) : undefined}
            deleteLabel={t('settings.customFormats.customFormatEditor.deleteFormat')}
            extra={
              <Button variant="ghost" onClick={() => setShowJson((v) => !v)}>
                {showJson ? t('settings.customFormats.customFormatEditor.hideJson') : t('settings.customFormats.customFormatEditor.exportJson')}
              </Button>
            }
          />
        }
      >
        <div className="al-cf-editor">
          <Field label={t('common.name')} error={nameError}>
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Toggle
            checked={includeWhenRenaming}
            label={t('settings.customFormats.customFormatEditor.includeInTheCustomFormats')}
            onChange={(e) => setIncludeWhenRenaming(e.currentTarget.checked)}
          />

          {showJson ? (
            <Field label={t('settings.customFormats.customFormatEditor.json')} hint={t('settings.customFormats.customFormatEditor.copyThisToShareOr')}>
              <Textarea mono rows={10} readOnly value={json} onFocus={(e) => e.currentTarget.select()} />
            </Field>
          ) : null}

          <SettingsSection
            label={t('common.conditions')}
            count={specs.length}
            action={
              features.music || features.audiobooks || domain !== 'any' ? (
                <Chip tone="neutral" dot="none" data-testid="format-domain">
                  {domainLabel(domain)}
                </Chip>
              ) : undefined
            }
          >
            <p className="al-caption">
              {t('settings.customFormats.customFormatEditor.theFormatMatchesWhenEvery')}
            </p>
            <ol className="al-cf-specs">
              {specs.map((spec, index) => {
                const def = schema.find((d) => d.implementation === spec.implementation);
                const errors = specErrors[index] ?? {};
                return (
                  <li key={index} className="al-cf-spec">
                    <fieldset className="al-cf-spec__set">
                      <legend className="al-sr-only">{t('settings.customFormats.customFormatEditor.conditionValue', { value: index + 1 })}</legend>
                      <div className="al-cf-spec__head">
                        <Select
                          aria-label={t('settings.customFormats.customFormatEditor.conditionType')}
                          value={spec.implementation}
                          onChange={(e) => {
                            const next = schema.find((d) => d.implementation === e.currentTarget.value);
                            if (next) updateSpec(index, { ...newSpec(next), name: spec.name });
                          }}
                          options={schema.map((d) => ({ value: d.implementation, label: d.label }))}
                        />
                        <Input aria-label={t('settings.customFormats.customFormatEditor.conditionName')} value={spec.name} onChange={(e) => updateSpec(index, { name: e.currentTarget.value })} />
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Icon name="close" />}
                          aria-label={t('settings.customFormats.customFormatEditor.removeConditionName', { name: spec.name })}
                          onClick={() => setSpecs((list) => list.filter((_, i) => i !== index))}
                        />
                      </div>
                      <div className="al-cf-spec__flags">
                        <Toggle size="sm" label={t('settings.customFormats.customFormatEditor.negate')} checked={spec.negate} onChange={(e) => updateSpec(index, { negate: e.currentTarget.checked })} />
                        <Toggle size="sm" label={t('settings.customFormats.customFormatEditor.required')} checked={spec.required} onChange={(e) => updateSpec(index, { required: e.currentTarget.checked })} />
                      </div>
                      {isAudioSpec(spec.implementation) ? (
                        <AudioSpecEditor implementation={spec.implementation} fields={spec.fields} errors={errors} onChange={(fields) => updateSpec(index, { fields })} />
                      ) : (
                        <SchemaForm fields={specFields(def)} values={spec.fields} errors={errors} onChange={(fields) => updateSpec(index, { fields })} />
                      )}
                      {errors._spec ? <p className="al-inline-error">{errors._spec}</p> : null}
                    </fieldset>
                  </li>
                );
              })}
            </ol>
            <Select
              aria-label={t('settings.customFormats.customFormatEditor.addCondition')}
              className="al-cf-add"
              value=""
              placeholder={t('settings.customFormats.customFormatEditor.addCondition2')}
              onChange={(e) => {
                const def = schema.find((d) => d.implementation === e.currentTarget.value);
                if (def) setSpecs((list) => [...list, newSpec(def)]);
              }}
              options={schema.map((d) => ({ value: d.implementation, label: d.label }))}
            />
          </SettingsSection>

          <SettingsSection label={t('common.test')}>
            <CustomFormatTestBox highlightId={format?.id} />
          </SettingsSection>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {format ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.customFormats.customFormatEditor.deleteName', { name: format.name })}
          confirmLabel={t('settings.customFormats.customFormatEditor.deleteFormat')}
          onCancel={() => setConfirmDelete(false)}
          describeError={(err) => inUseMessage(err, 'custom format')}
          onConfirm={async () => {
            await remove.mutateAsync(format.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>{t('settings.customFormats.customFormatEditor.itsScoresAreRemovedFrom')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
