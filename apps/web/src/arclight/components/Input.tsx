import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../cx.js';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** field = boxed `.al-input` (default); underline = top-bar style search field. */
  variant?: 'field' | 'underline' | undefined;
  /** JetBrains Mono — paths, API keys, format strings, URLs. */
  mono?: boolean | undefined;
  /** 44px (login, wizard). */
  size?: 'md' | 'lg' | undefined;
  /** Sets aria-invalid (red border + help text in danger). */
  invalid?: boolean | undefined;
  /** Mono hint drawn inside the right edge ("/" shortcut, unit). */
  end?: ReactNode | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** `.al-input`. Square, 40px, field-tinted. Passes every native prop through. */
export function Input({ variant = 'field', mono, size = 'md', invalid, end, className, ...rest }: InputProps) {
  const input = (
    <input
      className={cx('al-input', variant === 'underline' && 'al-input--underline', mono && 'al-input--mono', size === 'lg' && 'al-input--lg', className)}
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      {...rest}
    />
  );
  if (end === undefined) return input;
  return (
    <span className="al-input-affix">
      {input}
      <span className="al-input-affix__end">{end}</span>
    </span>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean | undefined;
  invalid?: boolean | undefined;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}

/** Multi-line `.al-input` (JSON import uses `mono`). */
export function Textarea({ mono, invalid, className, ...rest }: TextareaProps) {
  return <textarea className={cx('al-input', mono && 'al-input--mono', className)} aria-invalid={invalid || undefined} {...rest} />;
}

type ControlElement = ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;

function useFieldWiring(children: ControlElement, htmlFor: string | undefined, hint: ReactNode, error: ReactNode) {
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
  return { id, hintId, errorId, control };
}

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control (13px text-4). */
  hint?: ReactNode | undefined;
  /** Error text — replaces the help colour with danger and sets aria-invalid on the control. */
  error?: ReactNode | undefined;
  htmlFor?: string | undefined;
  /** Side-by-side settings row (220px label column) instead of stacked. */
  inline?: boolean | undefined;
  /** Small mono text right of the label ("default", "focus"). */
  aside?: ReactNode | undefined;
  /** Single control; it receives id / aria-describedby / aria-invalid. */
  children: ControlElement;
  className?: string | undefined;
}

/**
 * `.al-field` — stacked label + control + help. Same props as the old FormField, so pages
 * swap the import. `inline` renders a FormRow.
 */
export function Field({ label, hint, error, htmlFor, inline = false, aside, children, className }: FieldProps) {
  const { id, hintId, errorId, control } = useFieldWiring(children, htmlFor, hint, error);
  if (inline) {
    return (
      <FormRowShell label={label} htmlFor={id} className={className}>
        {control}
        {hint ? (
          <p id={hintId} className="al-form-row__caption" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="al-form-row__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
      </FormRowShell>
    );
  }
  return (
    <div className={cx('al-field', className)}>
      <div className="al-field__label-row">
        <label className="al-field__label" htmlFor={id}>
          {label}
        </label>
        {aside ? <span className="al-num al-caption" style={{ fontSize: 11 }}>{aside}</span> : null}
      </div>
      {control}
      {hint && !error ? (
        <p id={hintId} className="al-field__help" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FormRowShell({ label, htmlFor, inlineControl, className, children }: { label: ReactNode; htmlFor?: string | undefined; inlineControl?: boolean | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <div className={cx('al-form-row', className)}>
      {htmlFor ? (
        <label className="al-form-row__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <div className="al-form-row__label">{label}</div>
      )}
      <div className={cx('al-form-row__control', inlineControl && 'al-form-row__control--inline')}>{children}</div>
    </div>
  );
}

export interface FormRowProps {
  label: ReactNode;
  /** Id of the control the label points at. */
  htmlFor?: string | undefined;
  /** Help caption (13px text-4). Beside the control for toggles (`captionInline`), under it otherwise. */
  caption?: ReactNode | undefined;
  /** Mono caption — e.g. the "→ Severance - S02E09 …mkv" preview line. */
  captionMono?: boolean | undefined;
  /** Put the caption on the same line as the control (toggle rows). */
  captionInline?: boolean | undefined;
  error?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/** Settings form row: 220px label column + control + caption (Page 06). */
export function FormRow({ label, htmlFor, caption, captionMono, captionInline, error, children, className }: FormRowProps) {
  return (
    <FormRowShell label={label} htmlFor={htmlFor} inlineControl={captionInline} className={className}>
      {children}
      {caption ? <span className={cx('al-form-row__caption', captionMono && 'al-form-row__caption--mono')}>{caption}</span> : null}
      {error ? (
        <span className="al-form-row__error" role="alert">
          {error}
        </span>
      ) : null}
    </FormRowShell>
  );
}

/** A form section: mono CAPS label, optional action on the right, then rows. */
export function FormSection({ label, action, children, className }: { label: ReactNode; action?: ReactNode; children: ReactNode; className?: string | undefined }) {
  return (
    <section className={cx('al-form-section', className)}>
      <div className="al-section-head" style={{ alignItems: 'center' }}>
        <div className="al-label">{label}</div>
        {action}
      </div>
      <div className="al-form-grid">{children}</div>
    </section>
  );
}
