export interface I18nCheckResult {
  problems: string[];
  keys: number;
  locales: string[];
  unused: string[];
}
export function checkI18n(opts?: { srcDir?: string; localesDir?: string; sourceLocale?: string }): I18nCheckResult;
