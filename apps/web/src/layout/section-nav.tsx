import { Link } from '@tanstack/react-router';
import { activeTab, sectionTabs } from '../nav.js';
import { t } from '../i18n/index.js';

/**
 * Route-driven tabs for the section the rail has active (Library: TV / Movies / Add new …).
 * Hidden when the section has a single page or draws its own sub-nav (Settings).
 */
export function SectionNav({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  const tabs = sectionTabs(pathname, isAdmin);
  if (tabs.length === 0) return null;
  const current = activeTab(pathname, tabs);
  return (
    <nav className="al-section-nav" aria-label={t('layout.sectionNav.section')}>
      <div className="al-tabs al-tabs--compact">
        {tabs.map((navLeaf) => (
          <Link key={navLeaf.to} to={navLeaf.to} aria-current={navLeaf === current ? 'page' : undefined}>
            {navLeaf.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
