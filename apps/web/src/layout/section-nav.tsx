import { Link } from '@tanstack/react-router';
import { activeTab, sectionTabs } from '../nav.js';

/**
 * Route-driven tabs for the section the rail has active (Library: TV / Movies / Add new …).
 * Hidden when the section has a single page or draws its own sub-nav (Settings).
 */
export function SectionNav({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  const tabs = sectionTabs(pathname, isAdmin);
  if (tabs.length === 0) return null;
  const current = activeTab(pathname, tabs);
  return (
    <nav className="al-section-nav" aria-label="Section">
      <div className="al-tabs al-tabs--compact">
        {tabs.map((t) => (
          <Link key={t.to} to={t.to} aria-current={t === current ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
