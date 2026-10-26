import { useCallback, useId, useState, type ReactNode } from 'react';
import { Checkbox, Field, FormRow, Input, Select, Textarea, Toggle } from '../../arclight/index.js';
import type { FieldDefinition, FieldErrors, FieldRendererProps, FieldRenderers, FormValues } from './types.js';
import {
  coerceOption,
  fromDisplayNumber,
  getPath,
  hasAdvanced,
  initialValues,
  isMasked,
  passwordDisplayValue,
  setPath,
  toDisplayNumber,
  validateFields,
  visibleFields,
} from './values.js';
import './forms.css';
import { t } from '../../i18n/index.js';

export interface SchemaFormProps {
  fields: readonly FieldDefinition[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  errors?: FieldErrors | undefined;
  /**
   * Controlled "Show advanced". Settings pages own the toggle (top right of the pane) and pass
   * it in; omit it and the form draws its own toggle above the rows.
   */
  showAdvanced?: boolean | undefined;
  onShowAdvancedChange?: ((value: boolean) => void) | undefined;
  /** Per-field-name overrides (tag pickers, category trees, ...). */
  renderers?: FieldRenderers | undefined;
  /** Settings layout: 220px label column + control + caption (FormRow). Dialogs stay stacked. */
  inline?: boolean | undefined;
  /** Extra content after the toggle row (e.g. a Test button). */
  toolbar?: ReactNode;
}

/** Placeholder of a password input while a secret is stored (the api sent the mask). */
export const STORED_SECRET_PLACEHOLDER = 'Stored, unchanged · type to replace'; // i18n-ignore: English source, tests compare with it
const storedSecretPlaceholder = () => t('components.forms.schemaForm.storedSecretPlaceholder');

/** Renders field definitions as Arclight form rows, with a "Show advanced" toggle. */
export function SchemaForm({
  fields,
  values,
  onChange,
  errors = {},
  showAdvanced: controlledAdvanced,
  onShowAdvancedChange,
  renderers,
  inline = false,
  toolbar,
}: SchemaFormProps) {
  const baseId = useId();
  const [internalAdvanced, setInternalAdvanced] = useState(false);
  const showAdvanced = controlledAdvanced ?? internalAdvanced;
  const setShowAdvanced = (v: boolean) => {
    if (controlledAdvanced === undefined) setInternalAdvanced(v);
    onShowAdvancedChange?.(v);
  };
  const ownToggle = controlledAdvanced === undefined && hasAdvanced(fields);
  const shown = visibleFields(fields, showAdvanced, errors);

  const rows = shown.map((field) => {
    const id = `${baseId}-${field.name.replace(/\W/g, '-')}`;
    const props: FieldRendererProps = {
      field,
      id,
      value: getPath(values, field.name),
      onChange: (v) => onChange(setPath(values, field.name, v)),
      error: errors[field.name],
    };
    const custom = renderers?.[field.name];
    const control = custom ? custom(props) : <FieldControl {...props} />;
    const label = (
      <>
        {field.label}
        {field.required ? (
          <span className="al-req" aria-hidden="true">
            {' *'}
          </span>
        ) : null}
        {field.advanced ? <span className="al-adv-tag">{t('components.forms.schemaForm.advanced')}</span> : null}
      </>
    );
    if (inline) {
      const toggleRow = field.type === 'checkbox' && !custom;
      return (
        <FormRow
          key={field.name}
          label={label}
          htmlFor={toggleRow ? undefined : id}
          caption={field.helpText}
          captionInline={toggleRow}
          error={props.error}
        >
          {control}
        </FormRow>
      );
    }
    return (
      <Field key={field.name} label={label} hint={field.helpText} error={props.error} htmlFor={id}>
        {control}
      </Field>
    );
  });

  return (
    <div className="al-schema-form" data-layout={inline ? 'rows' : 'stacked'}>
      {ownToggle || toolbar ? (
        <div className="al-schema-form__toolbar">
          {ownToggle ? <Toggle label={t('components.forms.schemaForm.showAdvanced')} checked={showAdvanced} onChange={(e) => setShowAdvanced(e.currentTarget.checked)} /> : <span />}
          {toolbar}
        </div>
      ) : null}
      {inline ? <div className="al-form-grid">{rows}</div> : <div className="al-schema-form__stack">{rows}</div>}
    </div>
  );
}

/** The default Arclight control for each field type. */
export function FieldControl({ field, id, value, onChange, error }: FieldRendererProps) {
  const invalid = error ? true : undefined;
  switch (field.type) {
    case 'checkbox':
      return (
        <Toggle id={id} aria-label={field.label} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} aria-invalid={invalid} />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          mono
          className="al-input--num"
          value={toDisplayNumber(value, field.scale)}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          invalid={invalid}
          end={field.unit}
          onChange={(e) => onChange(fromDisplayNumber(e.currentTarget.value, field.scale))}
        />
      );
    case 'password':
      return (
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={passwordDisplayValue(value)}
          placeholder={isMasked(value) ? storedSecretPlaceholder() : field.placeholder}
          data-stored={isMasked(value) || undefined}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case 'select':
      return (
        <Select
          id={id}
          className="al-select--fit"
          value={value === undefined || value === null ? '' : String(value)}
          invalid={invalid}
          onChange={(e) => onChange(coerceOption(field.options, e.currentTarget.value))}
          options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
          {...(value === undefined || value === null || value === '' ? { placeholder: t('components.forms.schemaForm.select') } : {})}
        />
      );
    case 'multiSelect': {
      const selected = Array.isArray(value) ? (value as unknown[]) : [];
      return (
        <div id={id} className="al-check-grid" role="group" aria-label={field.label} aria-invalid={invalid}>
          {(field.options ?? []).map((o) => {
            const on = selected.some((s) => String(s) === String(o.value));
            return (
              <Checkbox
                key={String(o.value)}
                label={o.label}
                checked={on}
                onChange={() => onChange(on ? selected.filter((s) => String(s) !== String(o.value)) : [...selected, o.value])}
              />
            );
          })}
        </div>
      );
    }
    case 'textarea':
      return (
        <Textarea
          id={id}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case 'regex':
    case 'text':
    default:
      return (
        <Input
          id={id}
          type="text"
          mono={field.type === 'regex'}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          spellCheck={field.type === 'regex' ? false : undefined}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
  }
}

/** State for a schema form: values, errors after the first submit attempt, and validate(). */
export function useSchemaForm(fields: readonly FieldDefinition[], base: FormValues = {}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, base));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);

  const change = useCallback(
    (next: FormValues) => {
      setValues(next);
      if (attempted) setErrors(validateFields(fields, next));
    },
    [attempted, fields],
  );

  /** Returns true when valid; otherwise shows the errors. */
  const validate = useCallback((): boolean => {
    const next = validateFields(fields, values);
    setAttempted(true);
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [fields, values]);

  const reset = useCallback(
    (nextBase: FormValues) => {
      setValues(initialValues(fields, nextBase));
      setErrors({});
      setAttempted(false);
    },
    [fields],
  );

  return { values, setValues: change, errors, validate, reset };
}
