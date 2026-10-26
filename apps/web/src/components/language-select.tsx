import type { SelectHTMLAttributes } from 'react';
import { Select } from '../arclight/index.js';
import { LOCALES, t, useLocale, type LocaleSetting } from '../i18n/index.js';

/**
 * Options for the UI language: "Automatic" plus every shipped locale by its own name
 * (Deutsch, Français, ...) so people can find their language whatever the current one is.
 */
export function languageOptions(): Array<{ value: LocaleSetting; label: string }> {
  return [
    { value: 'auto', label: t('components.languageSelect.auto') },
    ...LOCALES.map((l) => ({ value: l.code, label: l.nativeName === l.name ? l.nativeName : `${l.nativeName} · ${l.name}` })),
  ];
}

export interface LanguageSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: LocaleSetting;
  onChange: (value: LocaleSetting) => void;
}

/** UI language picker (Settings → General → UI, setup wizard first step). */
export function LanguageSelect({ value, onChange, ...rest }: LanguageSelectProps) {
  useLocale();
  return <Select {...rest} value={value} options={languageOptions()} onChange={(e) => onChange(e.currentTarget.value as LocaleSetting)} />;
}
