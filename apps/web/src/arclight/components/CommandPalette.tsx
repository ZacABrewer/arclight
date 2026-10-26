import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/use-focus-trap.js';
import { Icon } from './Icon.js';
import { SectionLabel } from './SectionLabel.js';
import { t } from '../../i18n/index.js';

export interface ResultItem {
  id: string;
  label: ReactNode;
  /** Secondary text right of the label ("2022 · Apple TV+", "Settings › Indexers"). */
  meta?: ReactNode | undefined;
  /** Mono keyboard hint ("G D"). */
  hint?: string | undefined;
  /** Leading visual (small poster, icon). */
  leading?: ReactNode | undefined;
  onSelect: () => void;
}

export interface ResultGroup {
  /** "Series", "Movies", "People", "Settings", "Actions". */
  label: string;
  items: readonly ResultItem[];
}

interface ResultListProps {
  groups: readonly ResultGroup[];
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  placeholder: string;
  emptyText: ReactNode;
  loading?: boolean | undefined;
  footer?: ReactNode | undefined;
  inputLabel: string;
}

/** Shared engine: input + grouped 44px rows, ↑/↓ to move, Enter to run, Esc to close. */
function ResultList({ groups, query, onQueryChange, onClose, placeholder, emptyText, loading, footer, inputLabel }: ResultListProps) {
  const listId = useId();
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, flat.length]);

  const run = (item: ResultItem | undefined) => {
    if (!item) return;
    item.onSelect();
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    else if (e.key === 'ArrowUp') setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    else if (e.key === 'Enter') run(flat[active]);
    else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <>
      <div className="al-cmd__input-row">
        <Icon name="search" size={20} />
        <input
          className="al-cmd__input"
          role="combobox"
          aria-label={inputLabel}
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={flat.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="al-kbd">Esc</kbd>
      </div>
      <div className="al-cmd__results" id={listId} role="listbox" aria-label={t('common.results')} aria-busy={loading || undefined}>
        {flat.length === 0 ? (
          <div className="al-cmd__empty">{loading ? t('arclight.commandPalette.searching') : emptyText}</div>
        ) : (
          groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <SectionLabel className="al-cmd__group">{g.label}</SectionLabel>
                {g.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className="al-cmd__row"
                      onMouseMove={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(item)}
                    >
                      {item.leading}
                      <span className="al-cmd__row-label">{item.label}</span>
                      {item.meta ? <span className="al-cmd__row-meta">{item.meta}</span> : null}
                      {item.hint ? <span className="al-cmd__row-hint">{item.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))
        )}
      </div>
      <div className="al-cmd__foot" aria-hidden="true">
        {footer ?? (
          <>
            <span>{t('arclight.commandPalette.move')}</span>
            <span>{t('arclight.commandPalette.open')}</span>
            <span>{t('arclight.commandPalette.escClose')}</span>
          </>
        )}
      </div>
    </>
  );
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Results/commands, already filtered by the caller (data via props). */
  groups: readonly ResultGroup[];
  placeholder?: string | undefined;
  loading?: boolean | undefined;
  emptyText?: ReactNode | undefined;
}

/** Command palette: centred 640px pane, chamfer top-left, scrim. */
export function CommandPalette({ open, onClose, query, onQueryChange, groups, placeholder = t('arclight.commandPalette.typeACommandOrSearch'), loading, emptyText = t('arclight.commandPalette.noMatches') }: CommandPaletteProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { active: open, onEscape: onClose });
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="al-cmd-layer">
      <div className="al-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('common.commandPalette')} className="al-cmd al-pane al-pane--chamfer-tl al-pane--strong">
        <i className="al-edge al-edge--tl" aria-hidden="true" />
        <ResultList groups={groups} query={query} onQueryChange={onQueryChange} onClose={onClose} placeholder={placeholder} emptyText={emptyText} loading={loading} inputLabel={t('arclight.commandPalette.command')} />
      </div>
    </div>,
    document.body,
  );
}

export interface GlobalSearchOverlayProps extends CommandPaletteProps {
  /** Shown before the user types ("Search series, movies, people and settings"). */
  hint?: ReactNode | undefined;
}

/**
 * Global search overlay: full-width pane dropping from the top bar, grouped results
 * (Series / Movies / People / Settings) as 44px rows with mono keyboard hints. Opened by "/".
 */
export function GlobalSearchOverlay({ open, onClose, query, onQueryChange, groups, placeholder = t('common.search'), loading, emptyText, hint = t('arclight.commandPalette.searchSeriesMoviesPeopleAnd') }: GlobalSearchOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { active: open, onEscape: onClose });
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="al-search-overlay">
      <div className="al-search-overlay__scrim" aria-hidden="true" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('common.search')} className="al-pane al-pane--strong">
        <ResultList
          groups={groups}
          query={query}
          onQueryChange={onQueryChange}
          onClose={onClose}
          placeholder={placeholder}
          emptyText={query.trim() ? (emptyText ?? t('arclight.commandPalette.nothingMatchesQuery', { query: query.trim() })) : hint}
          loading={loading}
          inputLabel={t('common.search')}
        />
      </div>
    </div>,
    document.body,
  );
}
