import { useState, type MouseEvent } from 'react';
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import { Backdrop, Button, ContentInset, Drawer, Icon, MobileTabBar, Rail, TopBar, type RailItem, type TabBarItem } from '../arclight/index.js';
import { useAuth } from '../auth/auth-context.js';
import type { Access } from '../auth/access.js';
import { useLiveEvents } from '../live.js';
import { activeMobileTab, activeRailCode, mobileTabsFor, railFor, visibleNav, type NavSection } from '../nav.js';
import { useNav } from './use-nav.js';
import { RestartBanner } from './restart-banner.js';
import { SectionNav } from './section-nav.js';
import { ShellOptionsProvider, useResolvedBackdrop } from './shell-options.js';
import { ShellOverlays } from './shell-overlays.js';
import { useStatusCluster } from './status-cluster.js';
import { useUserMenu } from './user-menu.js';
import { t } from '../i18n/index.js';

/** Plain left clicks route client-side; modified clicks keep the browser's behaviour. */
function isPlainClick(e: MouseEvent<HTMLElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function ShellBackdrop() {
  const b = useResolvedBackdrop();
  return <Backdrop spire={b.spire} circuit={b.circuit} vx={b.vx} horizon={b.horizon} />;
}

/** Mobile "More": every section the role can open, as 44px rows. */
function MoreDrawer({ open, onClose, access, nav }: { open: boolean; onClose: () => void; access: Access; nav: readonly NavSection[] }) {
  return (
    <Drawer open={open} onClose={onClose} title={t('common.more')} width={320}>
      <ul className="al-more-list">
        {visibleNav(access, nav).map((s) => (
          <li key={s.label}>
            <Link to={s.to} className="al-more-list__item" onClick={onClose}>
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

function Shell() {
  useLiveEvents();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isAdmin, access } = useAuth();
  const cluster = useStatusCluster(isAdmin);
  const [search, setSearch] = useState(false);
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);
  const user = useUserMenu(() => setSheet(true));
  const nav = useNav();

  const go = (href: string | undefined, e: MouseEvent<HTMLElement>) => {
    if (!href || !isPlainClick(e)) return;
    e.preventDefault();
    void router.navigate({ to: href as never });
  };

  const rail: RailItem[] = railFor(access, nav).map((r) => ({ code: r.code, label: r.label, title: r.title, href: r.href }));
  const tabs: TabBarItem[] = mobileTabsFor(access).map((mobileTab) => ({ id: mobileTab.id, label: mobileTab.label, icon: mobileTab.icon, href: mobileTab.href ?? undefined }));

  return (
    <div className="al-app">
      <a className="al-skip-link" href="#main">
        {t('layout.appShell.skipToContent')}
      </a>
      <ShellBackdrop />
      <Rail
        active={activeRailCode(pathname)}
        items={rail}
        homeHref="/"
        onSelect={(code, e) => go(code === 'DB' ? '/' : rail.find((r) => r.code === code)?.href, e)}
      />
      <TopBar
        onSearch={() => setSearch(true)}
        connected={cluster.connected}
        disconnectedLabel={cluster.disconnectedLabel}
        vpnLocation={cluster.vpnLocation}
        requestCount={cluster.requestCount}
        issueCount={cluster.issueCount}
        onRequestsClick={() => void router.navigate({ to: '/requests' })}
        onIssuesClick={() => void router.navigate({ to: cluster.issuesHref })}
        initials={user.initials}
        userLabel={user.label}
        userMenu={user.menu}
      >
        <Button variant="ghost" size="sm" className="al-topbar__search-icon" icon={<Icon name="search" size={20} />} aria-label={t('common.search')} onClick={() => setSearch(true)} />
      </TopBar>
      <ContentInset id="main">
        <RestartBanner />
        <SectionNav pathname={pathname} access={access} nav={nav} />
        <Outlet />
      </ContentInset>
      <MobileTabBar
        active={activeMobileTab(pathname, access)}
        items={tabs}
        onSelect={(id, e) => {
          if (id === 'more') {
            e.preventDefault();
            setMore(true);
            return;
          }
          go(tabs.find((tabBar) => tabBar.id === id)?.href, e);
        }}
      />
      <MoreDrawer open={more} onClose={() => setMore(false)} access={access} nav={nav} />
      <ShellOverlays isAdmin={isAdmin} search={search} setSearch={setSearch} sheet={sheet} setSheet={setSheet} />
    </div>
  );
}

/** The frame every signed-in page lives in: backdrop, rail, top bar, content, overlays. */
export function AppShell() {
  return (
    <ShellOptionsProvider>
      <Shell />
    </ShellOptionsProvider>
  );
}
