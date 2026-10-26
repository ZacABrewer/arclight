import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { useHotkey } from '../hooks/use-hotkey.js';
import { LiveDot } from '../components/Progress.js';
import { t } from '../../i18n/index.js';

export interface TopBarProps {
  /** Opens the global search overlay. Bound to the search field click and the "/" key. */
  onSearch?: (() => void) | undefined;
  searchPlaceholder?: string | undefined;
  /** Live socket state: dot breathes + "Connected"; orange + label when down. */
  connected?: boolean | undefined;
  /** Text when down ("Reconnecting", "Offline"). */
  disconnectedLabel?: string | undefined;
  /** "Amsterdam" → "VPN Amsterdam"; null → "VPN off"; undefined → hidden. */
  vpnLocation?: string | null | undefined;
  /** Pending requests count; hidden when undefined. */
  requestCount?: number | undefined;
  /** Open issues; orange when > 0. Hidden when undefined. */
  issueCount?: number | undefined;
  onRequestsClick?: (() => void) | undefined;
  onIssuesClick?: (() => void) | undefined;
  /** Square avatar initials ("SK"). */
  initials?: string | undefined;
  /** Accessible name for the avatar button ("Account: sam"). */
  userLabel?: string | undefined;
  /**
   * User menu slot rendered in a popover under the avatar (pass a <Menu/>). Receives `close`.
   * Omit to make the avatar a plain button calling `onAvatarClick`.
   */
  userMenu?: ((close: () => void) => ReactNode) | undefined;
  onAvatarClick?: (() => void) | undefined;
  /** Extra items before the status cluster (e.g. a restart banner trigger). */
  children?: ReactNode;
  className?: string | undefined;
}

/** Top bar: 60px, wordmark, underline search with "/" hint, plain-text status, square avatar. */
export function TopBar({
  onSearch,
  searchPlaceholder = t('common.search'),
  connected = true,
  disconnectedLabel = t('arclight.chrome.topBar.reconnecting'),
  vpnLocation,
  requestCount,
  issueCount,
  onRequestsClick,
  onIssuesClick,
  initials = '?',
  userLabel = t('common.account'),
  userMenu,
  onAvatarClick,
  children,
  className,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  useHotkey('/', () => onSearch?.(), !!onSearch);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        userRef.current?.querySelector<HTMLButtonElement>('.al-avatar')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const issuesActive = (issueCount ?? 0) > 0;
  const Count = ({ n }: { n: number }) => <span className="al-topbar__count">{n}</span>;
  const statusText = (onClick: (() => void) | undefined, cls: string, body: ReactNode, extra?: Record<string, string | undefined>) =>
    onClick ? (
      <button type="button" className={cx('al-link', cls)} onClick={onClick} style={{ fontSize: 14, color: 'inherit' }} {...extra}>
        {body}
      </button>
    ) : (
      <span className={cls} {...extra}>
        {body}
      </span>
    );

  return (
    <header className={cx('al-topbar', className)}>
      {/* v1.1 ambient light: a runner travels along the bottom border (12 s loop). */}
      <span className="al-topbar__runner" aria-hidden="true">
        <i className="al-runner al-runner--h" />
      </span>
      <div className="al-wordmark">{t('common.arclight')}</div>
      {onSearch ? (
        <button type="button" className="al-topbar__search" onClick={onSearch} aria-label={t('arclight.chrome.topBar.searchPress')} aria-keyshortcuts="/">
          <span>{searchPlaceholder}</span>
          <kbd>/</kbd>
        </button>
      ) : null}
      <div className="al-topbar__spacer" />
      {children}
      <div className="al-topbar__status" role="status" aria-live="polite">
        <span className="al-topbar__conn" data-state={connected ? undefined : 'down'}>
          <LiveDot down={!connected} />
          <span className="al-topbar__conn-label">{connected ? t('common.connected') : disconnectedLabel}</span>
        </span>
        {vpnLocation !== undefined ? <span className="al-topbar__vpn">{vpnLocation === null ? t('common.vpnOff') : t('arclight.chrome.topBar.vpnVpnlocation', { vpnLocation })}</span> : null}
        {requestCount !== undefined
          ? statusText(
              onRequestsClick,
              'al-topbar__requests',
              <>
                <Count n={requestCount} /> {t('arclight.chrome.topBar.requests', { count: requestCount })}
              </>,
            )
          : null}
        {issueCount !== undefined
          ? statusText(
              onIssuesClick,
              'al-topbar__issues',
              <>
                <Count n={issueCount} /> {t('arclight.chrome.topBar.issues', { count: issueCount })}
              </>,
              { 'data-active': issuesActive ? 'true' : undefined },
            )
          : null}
      </div>
      <div className="al-topbar__user" ref={userRef}>
        <button
          type="button"
          className="al-avatar"
          aria-label={userLabel}
          aria-haspopup={userMenu ? 'menu' : undefined}
          aria-expanded={userMenu ? menuOpen : undefined}
          onClick={() => (userMenu ? setMenuOpen((o) => !o) : onAvatarClick?.())}
        >
          {initials.slice(0, 2).toUpperCase()}
        </button>
        {userMenu && menuOpen ? <div className="al-popover al-topbar__menu">{userMenu(() => setMenuOpen(false))}</div> : null}
      </div>
    </header>
  );
}
