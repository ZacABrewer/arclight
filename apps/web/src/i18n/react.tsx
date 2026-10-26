import { Fragment, cloneElement, isValidElement, useCallback, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import type { MessageParams, MessageValue } from './message-format.js';
import { getLocale, setLocale, subscribeLocale, t } from './store.js';
import { localeDir, type LocaleCode } from './locales-meta.js';

function useActiveLocale(): LocaleCode {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/** The active locale; re-renders the caller when it changes. */
export function useLocale(): { locale: LocaleCode; dir: 'ltr' | 'rtl'; setLocale: (code: string) => Promise<LocaleCode> } {
  const locale = useActiveLocale();
  return { locale, dir: localeDir(locale), setLocale };
}

/**
 * `const t = useT()` in components. Same function as the module-level `t`, but the
 * component re-renders on a locale change even when it is memoised, and the returned
 * function changes identity per locale so memo dependencies that include it refresh.
 */
export function useT(): typeof t {
  const locale = useActiveLocale();
  return useCallback((key: string, params?: MessageParams) => t(key, params), [locale]);
}

/**
 * Remounts its children when the locale changes, so module-level getters, memoised rows
 * and cached labels all render in the new language. Changing language is rare; losing
 * local component state then is fine (the query cache survives).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useActiveLocale();
  return <Fragment key={locale}>{children}</Fragment>;
}

export type TransValue = MessageValue | ReactElement;

export interface TransProps {
  /** Message key; the message may contain `<tag>text</tag>` and `<tag/>` markers. */
  k: string;
  values?: Readonly<Record<string, TransValue>> | undefined;
  /** Elements for the tags: `{ link: <Link to="/settings" /> }`. Tag text becomes their children. */
  components?: Readonly<Record<string, ReactElement>> | undefined;
}

const SENTINEL = '\u0000';
const TOKEN = /<(\w+)\s*\/>|<(\w+)>([\s\S]*?)<\/\2>|\u0000(\d+)\u0000/g;

/**
 * Rich-text translation. Tags in the message map to `components` (their inner text becomes
 * the element's children); element-valued `values` are spliced in where `{name}` appears.
 * Unknown tags render their text only.
 */
export function Trans({ k, values, components }: TransProps) {
  useActiveLocale();
  return <>{renderRich(k, values ?? {}, components ?? {})}</>;
}

/** The pure part of <Trans>. */
export function renderRich(
  key: string,
  values: Readonly<Record<string, TransValue>>,
  components: Readonly<Record<string, ReactElement>>,
): ReactNode[] {
  const elements: ReactElement[] = [];
  const params: Record<string, MessageValue> = {};
  for (const [name, v] of Object.entries(values)) {
    if (isValidElement(v)) {
      params[name] = `${SENTINEL}${elements.length}${SENTINEL}`;
      elements.push(v);
    } else {
      params[name] = v as MessageValue;
    }
  }
  let n = 0;
  const walk = (src: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = new RegExp(TOKEN.source, 'g');
    let last = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (m.index > last) out.push(src.slice(last, m.index));
      last = re.lastIndex;
      if (m[4] !== undefined) {
        const el = elements[Number(m[4])];
        if (el) out.push(cloneElement(el, { key: `v${n++}` }));
        continue;
      }
      const tag = (m[1] ?? m[2])!;
      const inner = m[3] === undefined ? [] : walk(m[3]);
      const el = components[tag];
      if (el) out.push(inner.length ? cloneElement(el, { key: `c${n++}` }, ...inner) : cloneElement(el, { key: `c${n++}` }));
      else out.push(<Fragment key={`f${n++}`}>{inner}</Fragment>);
    }
    if (last < src.length) out.push(src.slice(last));
    return out;
  };
  return walk(t(key, params));
}
