import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { filterListSearch, listSearchTokens, type ListSearchField } from '@arclight/shared';
import { Button, EmptyState, Input } from '../arclight/index.js';
import { cx } from '../lib/cx.js';
import { t } from '../i18n/index.js';
import './list-search.css';

// The text search of list pages (Activity, Wanted, Requests, Issues, System, Settings lists).
// The query lives in the URL (`?q=`), so a reload or a shared link keeps it; typing is
// debounced before it reaches the URL. Matching is the shared forgiving rule
// (packages/shared list-search.ts): case-insensitive, dots / dashes / underscores count as
// spaces, every word must match. Client-side lists filter with `useClientListSearch`;
// server-paged lists send `q` to their endpoint.
//
// "/" stays with the top-bar search (TopBar binds it globally), so the page search has no
// shortcut of its own.

/** How long typing settles before the URL (and a server query) changes. */
export const LIST_SEARCH_DEBOUNCE_MS = 250;

type SearchRecord = Record<string, unknown>;

function asText(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
}

/**
 * The page's search query from the URL search params, and a setter that replaces the history
 * entry (typing should not fill the back button). `q` is trimmed; blank removes the param.
 */
export function useListSearch(param = 'q') {
  const raw = useRouterState({ select: (s) => (s.location.search as SearchRecord)[param] });
  const q = asText(raw).trim();
  const navigate = useNavigate();
  const setQ = useCallback(
    (next: string) => {
      const value = next.trim();
      void navigate({
        to: '.',
        replace: true,
        search: (prev: SearchRecord) => {
          const out: SearchRecord = { ...prev };
          if (value) out[param] = value;
          else delete out[param];
          return out;
        },
      } as unknown as Parameters<typeof navigate>[0]);
    },
    [navigate, param],
  );
  const clear = useCallback(() => setQ(''), [setQ]);
  return { q, setQ, clear, active: listSearchTokens(q).length > 0 };
}

/**
 * Client-side search over a loaded list: the URL query plus the matching rows. `fields` names
 * what a row is searched by (title, release name, indexer, client, user, status, message…).
 */
export function useClientListSearch<T>(rows: readonly T[] | undefined, fields: (row: T) => readonly ListSearchField[], param = 'q') {
  const search = useListSearch(param);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const filtered = useMemo(() => (rows ? filterListSearch(rows, search.q, (r) => fieldsRef.current(r)) : undefined), [rows, search.q]);
  return { ...search, rows: filtered, shown: filtered?.length ?? 0, total: rows?.length ?? 0 };
}

export interface ListSearchInputProps {
  /** The committed query (from `useListSearch`). */
  value: string;
  /** Called with the trimmed text once typing settles, on Enter, and on Escape (blank). */
  onChange: (q: string) => void;
  placeholder?: string | undefined;
  /** Accessible name; defaults to "Search this list". */
  label?: string | undefined;
  className?: string | undefined;
  debounceMs?: number | undefined;
}

/** The search box (`mk-search`): local text, debounced into `onChange`. */
export function ListSearchInput({ value, onChange, placeholder, label, className, debounceMs = LIST_SEARCH_DEBOUNCE_MS }: ListSearchInputProps) {
  const [text, setText] = useState(value);
  // What we last handed to onChange: an outside change (Clear search, back button) differs from it.
  const sent = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    const next = text.trim();
    if (next === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = next;
      onChangeRef.current(next);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [text, debounceMs]);

  const commit = (next: string) => {
    sent.current = next.trim();
    onChangeRef.current(next.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(text);
    } else if (e.key === 'Escape' && text !== '') {
      e.preventDefault();
      e.stopPropagation();
      setText('');
      commit('');
    }
  };

  return (
    <Input
      type="search"
      className={cx('mk-search', 'al-listsearch__input', className)}
      aria-label={label ?? t('listSearch.label')}
      placeholder={placeholder ?? t('listSearch.placeholder')}
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/**
 * "N of M" (client-side lists, where the full list is known) or "N results" (server-paged
 * lists, where `shown` is the server's total for the search). Nothing while the search is blank.
 */
export function ListSearchCount({ active, shown, total, className }: { active: boolean; shown: number | undefined; total?: number | undefined; className?: string | undefined }) {
  if (!active || shown === undefined) return null;
  return (
    <span className={cx('al-caption al-num al-listsearch__count', className)} role="status" aria-live="polite">
      {total === undefined ? t('listSearch.results', { count: shown }) : t('listSearch.count', { shown, total })}
    </span>
  );
}

/** Empty state for a search that hides every row, with "Clear search". */
export function ListSearchEmpty({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <EmptyState title={t('listSearch.noMatches', { query })} action={<Button onClick={onClear}>{t('listSearch.clear')}</Button>}>
      {t('listSearch.noMatchesHint')}
    </EmptyState>
  );
}

export interface ListSearchBarProps {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string | undefined;
  label?: string | undefined;
  /** Rows shown (client side: after the search; server side: the server's total). */
  shown?: number | undefined;
  /** Rows before the search (client side only); omit for "N results". */
  total?: number | undefined;
  /** Extra controls after the box (filters, toggles). */
  children?: ReactNode;
  className?: string | undefined;
}

/** A compact toolbar row: search box, then the count. For pages without a FilterBar. */
export function ListSearchBar({ value, onChange, placeholder, label, shown, total, children, className }: ListSearchBarProps) {
  const active = listSearchTokens(value).length > 0;
  return (
    <div className={cx('al-listsearch', className)} role="search">
      <ListSearchInput value={value} onChange={onChange} placeholder={placeholder} label={label} />
      {children}
      <ListSearchCount active={active} shown={shown} total={total} />
    </div>
  );
}
