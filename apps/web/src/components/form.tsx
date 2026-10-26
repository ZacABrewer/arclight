import { cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../lib/cx.js';

// Form primitives for the settings pages. All are thin wrappers over native elements and
// pass every prop through, so they work uncontrolled (name + defaultValue, read with
// FormData on submit) as well as controlled.

export interface FormFieldProps {
  label: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  error?: ReactNode;
  /** Defaults to an auto-generated id that is injected into the single child control. */
  htmlFor?: string;
  /** Lay label and control out side by side (settings rows) instead of stacked. */
  inline?: boolean;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}

export function FormField({ label, hint, error, htmlFor, inline = false, children }: FormFieldProps) {
  const autoId = useId();
  const id = htmlFor ?? children.props.id ?? autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children;

  return (
    <div className={cx('field', inline && 'field-inline', error ? 'field-error' : null)}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="field-control">
        {control}
        {hint ? (
          <p id={hintId} className="field-hint">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="field-error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> };

export function Input({ className, ...rest }: InputProps) {
  return <input className={cx('input', className)} {...rest} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options?: readonly SelectOption[];
  placeholder?: string;
  ref?: React.Ref<HTMLSelectElement>;
};

export function Select({ className, options, placeholder, children, ...rest }: SelectProps) {
  return (
    <select className={cx('input', 'select', className)} {...rest}>
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

export type ToggleProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label?: ReactNode;
  ref?: React.Ref<HTMLInputElement>;
};

/** A checkbox styled as a switch. Submits "on" like a checkbox when uncontrolled. */
export function Toggle({ className, label, id, ...rest }: ToggleProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <span className={cx('toggle', className)}>
      <input id={inputId} type="checkbox" role="switch" className="toggle-input" {...rest} />
      <label htmlFor={inputId} className="toggle-track">
        <span className="toggle-thumb" aria-hidden="true" />
        {label ? <span className="toggle-label">{label}</span> : <span className="sr-only">Toggle</span>}
      </label>
    </span>
  );
}
