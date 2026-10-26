import { useEffect, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { cx } from '../lib/cx.js';
import { useLiveEvents } from '../live.js';
import { Sidebar } from './sidebar.js';
import { TopBar } from './top-bar.js';

/** The frame every page lives in: sidebar, top bar, live event feed, routed content. */
export function AppShell() {
  useLiveEvents();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Navigating from the drawer closes it.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className={cx('shell', drawerOpen && 'shell-drawer-open')}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar id="app-sidebar" pathname={pathname} />
      <div className="shell-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      <div className="shell-content">
        <TopBar drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} sidebarId="app-sidebar" />
        <main id="main" className="shell-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
