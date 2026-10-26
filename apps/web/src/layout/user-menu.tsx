import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { displayNameOf, useAuth } from '../auth/auth-context.js';

/** Top-bar menu: who is signed in, Settings → Security (admins), Sign out. */
export function UserMenu() {
  const { session, user, isAdmin, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!session) return null;
  const name = displayNameOf(user, session);
  const canSignOut = session.via === 'session';

  const signOut = async () => {
    setOpen(false);
    await logout();
    await router.navigate({ to: '/login', replace: true });
  };

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-menu-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="user-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-menu-name">{name}</span>
      </button>
      {open ? (
        <div className="user-menu-popover" role="menu" aria-label="User menu">
          <div className="user-menu-header">
            <strong>{name}</strong>
            <span className="muted">{user ? user.role : session.via === 'bypass' ? 'no sign-in needed' : session.via}</span>
          </div>
          {user ? (
            <Link to="/profile" role="menuitem" className="user-menu-item" onClick={() => setOpen(false)}>
              Profile and notifications
            </Link>
          ) : null}
          {isAdmin ? (
            <Link to="/settings/security" role="menuitem" className="user-menu-item" onClick={() => setOpen(false)}>
              Settings → Security
            </Link>
          ) : null}
          {canSignOut ? (
            <button type="button" role="menuitem" className="user-menu-item" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
