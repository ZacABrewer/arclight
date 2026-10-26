import { useState } from 'react';
import {
  CustomFormatSpec,
  type CustomFormat,
  type CustomFormatInput,
  type SpecImplementationDefinition,
} from '@arclight/shared';
import { Button, Field, Icon, Input, Modal, Select, Textarea, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog, inUseMessage } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldErrors } from '../../../components/forms/types.js';
import { initialValues, validateFields } from '../../../components/forms/values.js';
import { useDeleteCustomFormat, useSaveCustomFormat } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';
import { exportCustomFormat } from './custom-format-json.js';
import { CustomFormatTestBox } from './custom-format-test-box.js';
import './custom-formats.css';

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
  const fieldErrors = specs.map((s) => validateFields(specFields(schema.find((d) => d.implementation === s.implementation)), s.fields));
  const results = specs.map((s) => CustomFormatSpec.safeParse(s));
  if (fieldErrors.some((e) => Object.keys(e).length) || results.some((r) => !r.success)) {
    results.forEach((r, i) => {
      if (!r.success && Object.keys(fieldErrors[i]!).length === 0) {
        const issue = r.error.issues[0];
        const key = issue?.path[0] === 'fields' ? String(issue.path[1] ?? '') : '';
        fieldErrors[i] = { ...fieldErrors[i], [key || '_spec']: issue?.message ?? 'Invalid specification' };
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

export function CustomFormatEditor({ format, initial, schema, onClose }: CustomFormatEditorProps) {
  const start = format ?? initial ?? { name: '', includeWhenRenaming: false, specifications: [] };
  const [name, setName] = useState(start.name);
  const [includeWhenRenaming, setIncludeWhenRenaming] = useState(start.includeWhenRenaming);
  const [specs, setSpecs] = useState<SpecDraft[]>(() => structuredClone(start.specifications) as SpecDraft[]);
  const [specErrors, setSpecErrors] = useState<FieldErrors[]>([]);
  const [nameError, setNameError] = useState<string>();
  const [showJson, setShowJson] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveCustomFormat();
  const remove = useDeleteCustomFormat();

  const updateSpec = (index: number, patch: Partial<SpecDraft>) => setSpecs((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const submit = () => {
    const { fieldErrors, parsed } = validateSpecs(specs, schema);
    setSpecErrors(fieldErrors);
    setNameError(name.trim() ? undefined : 'Name is required');
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
        title={format ? `Edit ${format.name}` : 'Add custom format'}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={format ? () => setConfirmDelete(true) : undefined}
            deleteLabel="Delete format"
            extra={
              <Button variant="ghost" onClick={() => setShowJson((v) => !v)}>
                {showJson ? 'Hide JSON' : 'Export JSON'}
              </Button>
            }
          />
        }
      >
        <div className="al-cf-editor">
          <Field label="Name" error={nameError}>
            <Input value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Toggle
            checked={includeWhenRenaming}
            label="Include in the {Custom Formats} renaming token"
            onChange={(e) => setIncludeWhenRenaming(e.currentTarget.checked)}
          />

          {showJson ? (
            <Field label="JSON" hint="Copy this to share or back up the format.">
              <Textarea mono rows={10} readOnly value={json} onFocus={(e) => e.currentTarget.select()} />
            </Field>
          ) : null}

          <SettingsSection label="Conditions" count={specs.length}>
            <p className="al-caption">
              The format matches when every required condition matches and, for each kind of condition, at least one of that kind matches.
              Negate inverts a condition.
            </p>
            <ol className="al-cf-specs">
              {specs.map((spec, index) => {
                const def = schema.find((d) => d.implementation === spec.implementation);
                const errors = specErrors[index] ?? {};
                return (
                  <li key={index} className="al-cf-spec">
                    <fieldset className="al-cf-spec__set">
                      <legend className="al-sr-only">Condition {index + 1}</legend>
                      <div className="al-cf-spec__head">
                        <Select
                          aria-label="Condition type"
                          value={spec.implementation}
                          onChange={(e) => {
                            const next = schema.find((d) => d.implementation === e.currentTarget.value);
                            if (next) updateSpec(index, { ...newSpec(next), name: spec.name });
                          }}
                          options={schema.map((d) => ({ value: d.implementation, label: d.label }))}
                        />
                        <Input aria-label="Condition name" value={spec.name} onChange={(e) => updateSpec(index, { name: e.currentTarget.value })} />
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Icon name="close" />}
                          aria-label={`Remove condition ${spec.name}`}
                          onClick={() => setSpecs((list) => list.filter((_, i) => i !== index))}
                        />
                      </div>
                      <div className="al-cf-spec__flags">
                        <Toggle size="sm" label="Negate" checked={spec.negate} onChange={(e) => updateSpec(index, { negate: e.currentTarget.checked })} />
                        <Toggle size="sm" label="Required" checked={spec.required} onChange={(e) => updateSpec(index, { required: e.currentTarget.checked })} />
                      </div>
                      <SchemaForm fields={specFields(def)} values={spec.fields} errors={errors} onChange={(fields) => updateSpec(index, { fields })} />
                      {errors._spec ? <p className="al-inline-error">{errors._spec}</p> : null}
                    </fieldset>
                  </li>
                );
              })}
            </ol>
            <Select
              aria-label="Add condition"
              className="al-cf-add"
              value=""
              placeholder="Add condition…"
              onChange={(e) => {
                const def = schema.find((d) => d.implementation === e.currentTarget.value);
                if (def) setSpecs((list) => [...list, newSpec(def)]);
              }}
              options={schema.map((d) => ({ value: d.implementation, label: d.label }))}
            />
          </SettingsSection>

          <SettingsSection label="Test">
            <CustomFormatTestBox highlightId={format?.id} />
          </SettingsSection>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {format ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${format.name}?`}
          confirmLabel="Delete format"
          onCancel={() => setConfirmDelete(false)}
          describeError={(err) => inUseMessage(err, 'custom format')}
          onConfirm={async () => {
            await remove.mutateAsync(format.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>Its scores are removed from every quality profile.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
