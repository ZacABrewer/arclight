import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from '../cx.js';
import { t } from '../../i18n/index.js';

/* ------------------------------------------------------------------ Segmented */

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean | undefined;
}

export interface SegmentedProps<V extends string = string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /**
   * solid = cyan fill (Series | Movies); soft = 14% cyan (Posters | Table | Overview,
   * Month | Week | Day | Agenda).
   */
  variant?: 'solid' | 'soft' | undefined;
  /** Stretch segments to fill the row (mobile). */
  full?: boolean | undefined;
  'aria-label': string;
  className?: string | undefined;
}

/** `.al-seg` — a group of toggle buttons with aria-pressed. ←/→ move between segments. */
export function Segmented<V extends string = string>({ options, value, onChange, variant = 'solid', full, className, ...aria }: SegmentedProps<V>) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = options.filter((o) => !o.disabled);
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    const btn = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.dataset.value === next.value);
    btn?.focus();
  };
  return (
    <div role="group" aria-label={aria['aria-label']} className={cx('al-seg', variant === 'soft' && 'al-seg--soft', full && 'al-seg--full', className)} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-value={o.value}
          aria-pressed={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Checkbox / Radio */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode | undefined;
  hint?: ReactNode | undefined;
  /** Mixed state (header "select all" with some rows selected). */
  indeterminate?: boolean | undefined;
  /** Red outline — destructive options ("Also delete 9 files (184 GB)"). */
  tone?: 'default' | 'danger' | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** `.al-check` — native checkbox, 16px square, ✓ on cyan. */
export function Checkbox({ label, hint, indeterminate = false, tone = 'default', className, disabled, ref, ...rest }: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const setRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref && typeof ref === 'object') (ref as { current: HTMLInputElement | null }).current = el;
  };
  const input = (
    <input
      ref={setRef}
      type="checkbox"
      className={cx('al-check', tone === 'danger' && 'al-check--danger', label === undefined && className)}
      aria-checked={indeterminate ? 'mixed' : undefined}
      disabled={disabled}
      {...rest}
    />
  );
  if (label === undefined) return input;
  return (
    <label className={cx('al-choice', className)} data-disabled={disabled || undefined}>
      {input}
      <span className="al-choice__text">
        <span>{label}</span>
        {hint ? <span className="al-choice__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode | undefined;
  hint?: ReactNode | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** Radio — the one round control (Design Kit §08). */
export function Radio({ label, hint, className, disabled, ...rest }: RadioProps) {
  const input = <input type="radio" className={cx('al-radio', label === undefined && className)} disabled={disabled} {...rest} />;
  if (label === undefined) return input;
  return (
    <label className={cx('al-choice', className)} data-disabled={disabled || undefined}>
      {input}
      <span className="al-choice__text">
        <span>{label}</span>
        {hint ? <span className="al-choice__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface RadioGroupProps<V extends string = string> {
  name?: string | undefined;
  legend: ReactNode;
  /** Hide the legend visually (still announced). */
  hideLegend?: boolean | undefined;
  options: ReadonlyArray<{ value: V; label: ReactNode; hint?: ReactNode; disabled?: boolean }>;
  value: V;
  onChange: (value: V) => void;
  direction?: 'column' | 'row' | undefined;
}

export function RadioGroup<V extends string = string>({ name, legend, hideLegend, options, value, onChange, direction = 'column' }: RadioGroupProps<V>) {
  const auto = useId();
  return (
    <fieldset className={cx('al-radio-group', direction === 'row' && 'al-radio-group--row')}>
      <legend className={hideLegend ? 'al-sr-only' : 'al-field__label'} style={hideLegend ? undefined : { marginBottom: 8, padding: 0 }}>
        {legend}
      </legend>
      {options.map((o) => (
        <Radio
          key={o.value}
          name={name ?? auto}
          value={o.value}
          label={o.label}
          hint={o.hint}
          disabled={o.disabled}
          checked={o.value === value}
          onChange={() => onChange(o.value)}
        />
      ))}
    </fieldset>
  );
}

/* ------------------------------------------------------------------ Toggle */

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Text right of the switch (the kit puts the caption here: "Rename imported files…"). */
  label?: ReactNode | undefined;
  /** 30×16 variant used inside accordion headers. */
  size?: 'md' | 'sm' | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * Switch — a native checkbox with role="switch" drawing the kit's `.al-toggle`. Works
 * controlled (`checked` + `onChange`) and uncontrolled (`name` + `defaultChecked`, submits
 * "on"), exactly like the old Toggle.
 */
export function Toggle({ label, size = 'md', className, disabled, id, ...rest }: ToggleProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label className={cx('al-switch', className)} htmlFor={inputId} data-disabled={disabled || undefined}>
      <input id={inputId} type="checkbox" role="switch" className="al-switch__input" disabled={disabled} {...rest} />
      <span className={cx('al-toggle', size === 'sm' && 'al-toggle--sm')} aria-hidden="true" />
      {label !== undefined ? <span>{label}</span> : <span className="al-sr-only">{t('arclight.controls.toggle')}</span>}
    </label>
  );
}

export interface SwitchButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: 'md' | 'sm' | undefined;
}

/** The kit's literal markup: `<button class="al-toggle" role="switch" aria-checked>`. */
export function SwitchButton({ checked, onChange, size = 'md', className, ...rest }: SwitchButtonProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx('al-toggle', size === 'sm' && 'al-toggle--sm', className)}
      onClick={() => onChange(!checked)}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------ Slider */

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'defaultValue'> {
  value: number;
  onChange: (value: number) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** Text left of the track ("Size", "Slider"). */
  label?: ReactNode | undefined;
  /** Show the mono value right of the track. */
  showValue?: boolean | undefined;
  formatValue?: ((v: number) => ReactNode) | undefined;
}

/** Range input with a 2px track and a diamond thumb. */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, label, showValue = true, formatValue, className, style, ...rest }: SliderProps) {
  const id = useId();
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cx('al-slider', className)}>
      {label !== undefined ? <label htmlFor={rest.id ?? id}>{label}</label> : null}
      <input
        id={id}
        type="range"
        className="al-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ ...style, '--p': `${pct}%` } as CSSProperties}
        {...rest}
      />
      {showValue ? <span className="al-slider__value">{formatValue ? formatValue(value) : value}</span> : null}
    </div>
  );
}
