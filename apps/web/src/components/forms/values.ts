import { PASSWORD_MASK } from '@arclight/shared';
import type { FieldDefinition, FieldErrors, FieldOption, FieldType, FormValues } from './types.js';
import { t } from '../../i18n/index.js';

// Pure helpers behind the schema form: dotted-path access, defaults, validation and the
// write-only secret round-trip. Kept free of React so they are unit-testable.

export { PASSWORD_MASK };

export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Immutable set: returns a copy with `path` replaced, creating intermediate objects. */
export function setPath<T extends FormValues>(source: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  const childObj = child !== null && typeof child === 'object' && !Array.isArray(child) ? (child as FormValues) : {};
  return { ...source, [head]: setPath(childObj, rest.join('.'), value) };
}

/** Start values: a deep copy of `base` with every missing field filled from its default. */
export function initialValues(fields: readonly FieldDefinition[], base: FormValues = {}): FormValues {
  let values = structuredClone(base);
  for (const f of fields) {
    if (getPath(values, f.name) === undefined && f.default !== undefined) values = setPath(values, f.name, f.default);
  }
  return values;
}

export function isEmptyValue(type: FieldType, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (type === 'multiSelect') return !Array.isArray(value) || value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/** Field-level errors keyed by field name. A stored secret (mask) satisfies `required`. */
export function validateFields(fields: readonly FieldDefinition[], values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  for (const f of fields) {
    if (f.type === 'checkbox') continue;
    const value = getPath(values, f.name);
    if (isEmptyValue(f.type, value)) {
      if (f.required) errors[f.name] = `${f.label} is required`;
      continue;
    }
    if (f.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) errors[f.name] = `${f.label} must be a number`;
      else if (f.min !== undefined && n < f.min * (f.scale ?? 1)) errors[f.name] = `${f.label} must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max * (f.scale ?? 1)) errors[f.name] = `${f.label} must be at most ${f.max}`;
    }
    if (f.type === 'regex' && typeof value === 'string') {
      try {
        new RegExp(value);
      } catch {
        errors[f.name] = `${f.label} is not a valid regular expression`;
      }
    }
    if (f.type === 'select' && f.options && !f.options.some((o) => String(o.value) === String(value))) {
      errors[f.name] = t('components.forms.values.chooseAValidLabel', { label: f.label.toLowerCase() });
    }
  }
  return errors;
}

// ---- write-only secrets ----------------------------------------------------------------
// The api never returns a stored password; it sends PASSWORD_MASK instead and keeps the
// stored value when the mask comes back. The input therefore shows empty with an "unchanged"
// placeholder while the value is the mask, typing replaces it, and clearing the field after
// typing sends '' (which clears the stored secret).

export function isMasked(value: unknown): boolean {
  return value === PASSWORD_MASK;
}

/** What the password <input> shows for a stored value. */
export function passwordDisplayValue(value: unknown): string {
  if (isMasked(value) || value === undefined || value === null) return '';
  return String(value);
}

/** Number input: stored value shown in the field's unit. */
export function toDisplayNumber(value: unknown, scale = 1): string {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Math.round((n / scale) * 1000) / 1000);
}

export function fromDisplayNumber(text: string, scale = 1): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * scale * 1000) / 1000 : undefined;
}

/** Select values keep the option's type (numbers stay numbers). */
export function coerceOption(options: readonly FieldOption[] | undefined, raw: string): string | number {
  const match = options?.find((o) => String(o.value) === raw);
  return match ? match.value : raw;
}

export function hasAdvanced(fields: readonly FieldDefinition[]): boolean {
  return fields.some((f) => f.advanced);
}

/** Fields to show: basic ones, plus advanced ones when toggled on or when they carry an error. */
export function visibleFields(fields: readonly FieldDefinition[], showAdvanced: boolean, errors: FieldErrors = {}) {
  return fields.filter((f) => !f.advanced || showAdvanced || errors[f.name] !== undefined);
}
