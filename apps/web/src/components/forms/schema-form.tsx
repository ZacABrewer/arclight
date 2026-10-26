import { useCallback, useId, useState, type ReactNode } from 'react';
import { FormField, Input, Select, Toggle } from '../form.js';
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

export interface SchemaFormProps {
  fields: readonly FieldDefinition[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  errors?: FieldErrors | undefined;
  /** Controlled "show advanced"; omit to let the form keep it. */
  showAdvanced?: boolean | undefined;
  onShowAdvancedChange?: ((value: boolean) => void) | undefined;
  /** Per-field-name overrides (tag pickers, category trees, ...). */
  renderers?: FieldRenderers | undefined;
  /** Lay fields out label-beside-control (settings pages) instead of stacked (dialogs). */
  inline?: boolean | undefined;
  /** Extra content after the toggle row (e.g. a Test button). */
  toolbar?: ReactNode;
}

/** Renders a list of field definitions as a form section with a "Show advanced" toggle. */
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

  const shown = visibleFields(fields, showAdvanced, errors);

  return (
    <div className="schema-form">
      {hasAdvanced(fields) || toolbar ? (
        <div className="schema-form-toolbar">
          {hasAdvanced(fields) ? (
            <Toggle label="Show advanced" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.currentTarget.checked)} />
          ) : (
            <span />
          )}
          {toolbar}
        </div>
      ) : null}
      {shown.map((field) => {
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
            {field.required ? <span className="field-required" aria-hidden="true"> *</span> : null}
            {field.advanced ? <span className="field-advanced-tag">advanced</span> : null}
          </>
        );
        return (
          <FormField key={field.name} label={label} hint={field.helpText} error={props.error} htmlFor={id} inline={inline}>
            {control}
          </FormField>
        );
      })}
    </div>
  );
}

/** The default control for each field type. */
export function FieldControl({ field, id, value, onChange, error }: FieldRendererProps) {
  const invalid = error ? true : undefined;
  switch (field.type) {
    case 'checkbox':
      return <Toggle id={id} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} aria-invalid={invalid} />;
    case 'number':
      return (
        <span className="input-with-unit">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            value={toDisplayNumber(value, field.scale)}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            aria-invalid={invalid}
            onChange={(e) => onChange(fromDisplayNumber(e.currentTarget.value, field.scale))}
          />
          {field.unit ? <span className="input-unit">{field.unit}</span> : null}
        </span>
      );
    case 'password':
      return (
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={passwordDisplayValue(value)}
          placeholder={isMasked(value) ? '•••••••• (unchanged)' : field.placeholder}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case 'select':
      return (
        <Select
          id={id}
          value={value === undefined || value === null ? '' : String(value)}
          aria-invalid={invalid}
          onChange={(e) => onChange(coerceOption(field.options, e.currentTarget.value))}
          options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
          {...(value === undefined || value === null || value === '' ? { placeholder: 'Select…' } : {})}
        />
      );
    case 'multiSelect': {
      const selected = Array.isArray(value) ? (value as unknown[]) : [];
      return (
        <div id={id} className="check-grid" role="group" aria-invalid={invalid}>
          {(field.options ?? []).map((o) => {
            const on = selected.some((s) => String(s) === String(o.value));
            return (
              <label key={String(o.value)} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onChange(on ? selected.filter((s) => String(s) !== String(o.value)) : [...selected, o.value])}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      );
    }
    case 'textarea':
      return (
        <textarea
          id={id}
          className="input textarea"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          aria-invalid={invalid}
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
          className={field.type === 'regex' ? 'input-mono' : undefined}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          spellCheck={field.type === 'regex' ? false : undefined}
          aria-invalid={invalid}
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
