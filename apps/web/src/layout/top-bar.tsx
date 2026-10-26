import { useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ConnectionIndicator } from './connection-indicator.js';
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

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = inputRef.current?.value.trim() ?? '';
    if (!q) return;
    void navigate({ to: '/search', search: { q } });
    inputRef.current?.blur();
  };

  return (
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
          placeholder="Search library…"
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <kbd className="topbar-search-hint" aria-hidden="true">
          /
        </kbd>
      </form>
      <div className="topbar-right">
        <ConnectionIndicator />
        <UserMenu />
      </div>
    </header>
  );
}
