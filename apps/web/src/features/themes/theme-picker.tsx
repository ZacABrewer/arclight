import type { KeyboardEvent } from 'react';
import type { ThemeInfo } from '@arclight/shared';
import { cx } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';
import './theme-picker.css';

export interface ThemePickerProps {
  themes: readonly ThemeInfo[];
  /** A theme id, or 'default' when `defaultTheme` is given. */
  value: string;
  onChange: (id: string) => void;
  /** Offer "Server default (<name>)" first, as the value 'default'. */
  defaultTheme?: ThemeInfo | undefined;
  disabled?: boolean | undefined;
  'aria-label': string;
  className?: string | undefined;
}

interface Choice {
  value: string;
  name: string;
  caption: string;
  swatches: readonly string[];
}

/** Theme cards (a radio group): each shows the pack's colours, its name and description. */
export function ThemePicker({ themes, value, onChange, defaultTheme, disabled, className, ...aria }: ThemePickerProps) {
  const choices: Choice[] = [
    ...(defaultTheme ? [{ value: 'default', name: t('features.themes.serverDefault'), caption: defaultTheme.name, swatches: defaultTheme.swatches }] : []),
    ...themes.map((th) => ({ value: th.id, name: th.name, caption: th.description, swatches: th.swatches })),
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || disabled) return;
    const at = Math.max(0, choices.findIndex((c) => c.value === value));
    const next = choices[(at + step + choices.length) % choices.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={aria['aria-label']} className={cx('theme-picker', className)} onKeyDown={onKeyDown}>
      {choices.map((c) => {
        const checked = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!choices.some((x) => x.value === value) && c === choices[0]) ? 0 : -1}
            data-value={c.value}
            disabled={disabled}
            className="theme-picker__card"
            onClick={() => onChange(c.value)}
          >
            <span className="theme-picker__preview" aria-hidden="true" style={{ background: c.swatches[0] }}>
              {c.swatches.slice(1).map((color, i) => (
                <i key={i} style={{ background: color }} />
              ))}
            </span>
            <span className="theme-picker__name">{c.name}</span>
            {c.caption ? <span className="theme-picker__caption">{c.caption}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
