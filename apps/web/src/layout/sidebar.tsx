import { Link } from '@tanstack/react-router';
import { cx } from '../lib/cx.js';
import { useAuth } from '../auth/auth-context.js';
import { isSectionActive, visibleNav } from '../nav.js';

export function Sidebar({ id, pathname }: { id: string; pathname: string }) {
  const { isAdmin } = useAuth();
  return (
    <aside id={id} className="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <Link to="/" className="brand">
          MEDIA-TRON
        </Link>
      </div>
      <nav className="sidebar-nav">
        <ul className="nav-list">
          {visibleNav(isAdmin).map((section) => {
            const active = isSectionActive(section, pathname);
            return (
              <li key={section.label} className={cx('nav-section', active && 'nav-section-active')}>
                <Link
                  to={section.to}
                  className={cx('nav-link', active && 'nav-link-active')}
                  aria-current={active && !section.children ? 'page' : undefined}
                >
                  <span className="nav-glyph" aria-hidden="true">
                    {section.glyph}
                  </span>
                  {section.label}
                </Link>
                {section.children && active ? (
                  <ul className="nav-sublist">
                    {section.children.map((child) => {
                      const childActive = pathname === child.to;
                      return (
                        <li key={child.to}>
                          <Link
                            to={child.to}
                            className={cx('nav-sublink', childActive && 'nav-sublink-active')}
                            aria-current={childActive ? 'page' : undefined}
                          >
                            {child.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
