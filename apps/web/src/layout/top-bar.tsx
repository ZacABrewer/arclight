import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { libraryApi } from '../api/library.js';
import { libraryKeys } from '../hooks/library-keys.js';
import { cx } from '../lib/cx.js';
import { ConnectionIndicator } from './connection-indicator.js';
import { RestartBanner } from './restart-banner.js';
import { libraryMatches, type LibraryMatch } from './search-matches.js';
import { UserMenu } from './user-menu.js';

/** True when a key press is going into a text field and must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

interface TopBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  sidebarId: string;
}

export function TopBar({ drawerOpen, onToggleDrawer, sidebarId }: TopBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted; matches.length: the "search indexers" entry.
  const [active, setActive] = useState(-1);
  const q = text.trim();

  // Library lists share the library pages' cache; only fetched once the user types.
  const series = useQuery({
    queryKey: libraryKeys.series.list(),
    queryFn: () => libraryApi.series.list({ includeStatistics: true }),
    enabled: q.length > 0,
  });
  const movies = useQuery({ queryKey: libraryKeys.movie.list(), queryFn: () => libraryApi.movies.list(), enabled: q.length > 0 });
  const matches = useMemo(() => libraryMatches(q, series.data ?? [], movies.data ?? []), [q, series.data, movies.data]);

  // "/" focuses the global search from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const finish = () => {
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
  };

  const goToMatch = (m: LibraryMatch) => {
    void navigate(m.kind === 'series' ? { to: '/library/series/$id', params: { id: String(m.id) } } : { to: '/library/movie/$id', params: { id: String(m.id) } });
    setText('');
    finish();
  };

  const searchIndexers = () => {
    if (!q) return;
    void navigate({ to: '/search', search: { q } });
    finish();
  };

  // Enter: the highlighted entry, else the best library match, else an indexer search.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!q) return;
    const picked = active >= 0 && active < matches.length ? matches[active] : active === matches.length ? undefined : matches[0];
    if (picked) goToMatch(picked);
    else searchIndexers();
  };

  const showList = open && q.length > 0;

  return (
    <>
    <header className="topbar">
      <button
        type="button"
        className="icon-btn topbar-menu"
        aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={drawerOpen}
        aria-controls={sidebarId}
        onClick={onToggleDrawer}
      >
        ☰
      </button>
      <form className="topbar-search" role="search" onSubmit={onSubmit}>
        <label htmlFor="global-search" className="sr-only">
          Search
        </label>
        <input
          ref={inputRef}
          id="global-search"
          className="input topbar-search-input"
          type="search"
          placeholder="Search library or indexers…"
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              finish();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, matches.length));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, -1));
            }
          }}
        />
        <kbd className="topbar-search-hint" aria-hidden="true">
          /
        </kbd>
        {showList ? (
          <ul id={listId} className="topbar-search-results" role="listbox" aria-label="Search suggestions">
            {matches.map((m, i) => (
              <li
                key={`${m.kind}-${m.id}`}
                role="option"
                aria-selected={i === active}
                className={cx('topbar-search-option', i === active && 'topbar-search-active')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  goToMatch(m);
                }}
              >
                <span>{m.title}</span>
                <span className="muted">
                  {m.year ? `${m.year} · ` : ''}
                  {m.kind === 'series' ? 'TV' : 'Movie'}
                </span>
              </li>
            ))}
            <li
              role="option"
              aria-selected={active === matches.length}
              className={cx('topbar-search-option', 'topbar-search-indexers', active === matches.length && 'topbar-search-active')}
              onMouseDown={(e) => {
                e.preventDefault();
                searchIndexers();
              }}
            >
              Search indexers for “{q}”
            </li>
          </ul>
        ) : null}
      </form>
      <div className="topbar-right">
        <ConnectionIndicator />
        <UserMenu />
      </div>
    </header>
    <RestartBanner />
    </>
  );
}
