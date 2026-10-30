import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, FloatBar, PageHeader, Pane, Select, Toggle, cx } from '../../arclight/index.js';
import './settings.css';
import { t } from '../../i18n/index.js';

// Page 06 shell shared by every settings page: a 240px sub-nav with mono CAPS group labels
// and a 2px active bar, one form Pane (title-m + "Show advanced" top right), and the sticky
// unsaved-changes FloatBar at the bottom of that pane.

export interface SettingsNavItem {
  label: string;
  to: string;
}

export interface SettingsNavGroup {
  label: string;
  items: readonly SettingsNavItem[];
}

export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    get label() {
      return t('settings.layout.media');
    },
    items: [
      { get label() { return t('common.mediaManagement'); }, to: '/settings/mediamanagement' },
      { get label() { return t('common.profiles'); }, to: '/settings/profiles' },
      { get label() { return t('common.quality'); }, to: '/settings/quality' },
      { get label() { return t('settings.layout.customFormats'); }, to: '/settings/customformats' },
      { get label() { return t('common.tags'); }, to: '/settings/tags' },
      { get label() { return t('common.guides'); }, to: '/settings/guides' },
    ],
  },
  {
    get label() {
      return t('common.indexers');
    },
    items: [
      { get label() { return t('common.indexers'); }, to: '/settings/indexers' },
      { get label() { return t('settings.layout.indexerProxies'); }, to: '/settings/indexerproxies' },
      { get label() { return t('settings.layout.indexerOptions'); }, to: '/settings/indexeroptions' },
      { get label() { return t('nav.indexerCatalogue'); }, to: '/settings/indexercatalogue' },
      { get label() { return t('common.challengeSolver'); }, to: '/settings/solver' },
    ],
  },
  {
    get label() {
      return t('settings.layout.downloads');
    },
    items: [
      { get label() { return t('common.downloadClients'); }, to: '/settings/downloadclients' },
      { get label() { return t('common.torrentEngine'); }, to: '/settings/torrent' },
      { get label() { return t('nav.crossSeed'); }, to: '/settings/crossseed' },
      { get label() { return t('common.vpn'); }, to: '/settings/vpn' },
    ],
  },
  {
    get label() {
      return t('settings.layout.automation');
    },
    items: [
      { get label() { return t('settings.layout.importLists'); }, to: '/settings/importlists' },
      { get label() { return t('common.notifications'); }, to: '/settings/notifications' },
      { get label() { return t('settings.layout.mediaServers'); }, to: '/settings/mediaservers' },
      { get label() { return t('common.subtitles'); }, to: '/settings/subtitles' },
      { get label() { return t('common.requests'); }, to: '/settings/requests' },
      { get label() { return t('nav.discordBot'); }, to: '/settings/discordbot' },
      { get label() { return t('nav.transcode'); }, to: '/settings/transcode' },
    ],
  },
  {
    get label() {
      return t('common.system');
    },
    items: [
      { get label() { return t('common.general'); }, to: '/settings/general' },
      { get label() { return t('common.security'); }, to: '/settings/security' },
      { get label() { return t('common.users'); }, to: '/settings/users' },
      { get label() { return t('common.updates'); }, to: '/settings/updates' },
    ],
  },
];

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

/** The settings sub-nav. Below 768px it collapses into a select so the page stays one column. */
export function SettingsNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const selectId = useId();
  const active = SETTINGS_NAV_ITEMS.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return (
    <nav className="al-settings-nav" aria-label={t('settings.layout.settingsSections')}>
      <div className="al-settings-nav__head">
        <span className="al-index" aria-hidden="true">
          09
        </span>
        <span className="al-title-l">{t('common.settings')}</span>
      </div>
      <div className="al-settings-nav__mobile">
        <label className="al-sr-only" htmlFor={selectId}>
          {t('settings.layout.settingsSection')}
        </label>
        <Select
          id={selectId}
          value={active?.to ?? ''}
          onChange={(e) => void navigate({ to: e.currentTarget.value })}
          options={SETTINGS_NAV_ITEMS.map((i) => ({ value: i.to, label: i.label }))}
        />
      </div>
      <div className="al-settings-nav__groups">
        {SETTINGS_NAV.map((group) => (
          <div key={group.label} className="al-settings-nav__group">
            <div className="al-label al-settings-nav__label">{group.label}</div>
            <ul>
              {group.items.map((item) => {
                const on = item === active;
                return (
                  <li key={item.to}>
                    <Link to={item.to} className={cx('al-settings-nav__item', on && 'is-active')} aria-current={on ? 'page' : undefined}>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

export interface SaveBarProps {
  /** Number of changed fields; the bar shows only while this is above 0. */
  count: number;
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean | undefined;
  /** Blocks Save (e.g. a field is invalid) — the bar stays so the user can Discard. */
  disabled?: boolean | undefined;
  /** Replaces the "n unsaved changes" text (e.g. an error after a failed save). */
  label?: ReactNode;
}

/** Sticky unsaved-changes bar: "2 unsaved changes" · Discard (ghost) · Save changes (primary). */
export function SaveBar({ count, onSave, onDiscard, saving, disabled, label }: SaveBarProps) {
  useEffect(() => {
    if (count === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [count]);
  if (count === 0) return null;
  return (
    <FloatBar variant="save" count={count} label={label} className="al-settings-savebar">
      <Button variant="ghost" onClick={onDiscard} disabled={saving}>
        {t('common.discard')}
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving ?? false} disabled={disabled}>
        {t('common.saveChanges')}
      </Button>
    </FloatBar>
  );
}

export interface SettingsPageProps {
  /** Sentence-case pane title ("Media management"); also the document title. */
  title: string;
  /** Controlled "Show advanced" toggle top right of the pane. Omit when the page has none. */
  advanced?: { value: boolean; onChange: (value: boolean) => void } | undefined;
  /** Buttons right of the title (before the advanced toggle): "Add indexer". */
  actions?: ReactNode;
  /** Short caption under the title. */
  description?: ReactNode;
  /** Unsaved-changes bar for form pages. */
  save?: SaveBarProps | undefined;
  /** Index + title used when the page is reached outside /settings (e.g. /indexers). */
  standalone?: { index: string; title: string } | undefined;
  /** Extra panes below the form pane (status panes, tables). */
  after?: ReactNode;
  /** Side pane (live status) drawn right of the form pane on wide screens. */
  aside?: ReactNode;
  children: ReactNode;
}

/** One settings page: sub-nav + one form pane + unsaved-changes bar. */
export function SettingsPage({ title, advanced, actions, description, save, standalone, after, aside, children }: SettingsPageProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = pathname.startsWith('/settings');
  useEffect(() => {
    document.title = t('settings.layout.valueArclight', { value: standalone && !inSettings ? standalone.title : title });
  }, [title, standalone, inSettings]);

  const head = (
    <div className="al-settings-pane__head">
      <div className="al-settings-pane__titles">
        <h2 className="al-title-m al-settings-pane__title">{title}</h2>
        {description ? <p className="al-caption al-settings-pane__desc">{description}</p> : null}
      </div>
      <div className="al-settings-pane__actions">
        {actions}
        {advanced ? (
          <Toggle label={t('settings.layout.showAdvanced')} checked={advanced.value} onChange={(e) => advanced.onChange(e.currentTarget.checked)} className="al-settings-advanced" />
        ) : null}
      </div>
    </div>
  );

  const pane = (
    <div className={cx('al-settings-main', aside !== undefined && 'al-settings-main--aside')}>
      <div className="al-settings-main__col">
        <Pane bare className="al-settings-pane" aria-label={title}>
          {head}
          <div className="al-settings-pane__body">{children}</div>
          {save ? <SaveBar {...save} /> : null}
        </Pane>
        {after}
      </div>
      {aside !== undefined ? <div className="al-settings-main__aside">{aside}</div> : null}
    </div>
  );

  if (!inSettings) {
    return (
      <div className="al-settings-standalone">
        <PageHeader index={standalone?.index} title={standalone?.title ?? title} />
        {pane}
      </div>
    );
  }
  return (
    <div className="al-settings">
      <SettingsNav pathname={pathname} />
      {pane}
    </div>
  );
}

// ---- unsaved changes ---------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Number of leaf values that differ between `a` and `b`. Objects are walked key by key;
 * arrays and scalars count as one value each (a reordered list is one change).
 */
export function countChanges(a: unknown, b: unknown): number {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let n = 0;
    for (const k of keys) n += countChanges(a[k], b[k]);
    return n;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    // One side is not an object: count the leaves of the side that is (at least one change).
    return Math.max(1, countChanges(isPlainObject(a) ? a : {}, isPlainObject(b) ? b : {}));
  }
  if (a === undefined && b === undefined) return 0;
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

export interface Draft<T> {
  /** Working copy the form edits. */
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  /** Changed leaf count against the saved value (0 = clean). */
  changes: number;
  dirty: boolean;
  /** Throw the edits away. */
  discard: () => void;
}

/**
 * Draft state for a settings form: a working copy of `saved` that resets whenever the saved
 * value changes (after a refetch or a successful save) and counts unsaved changes for the
 * SaveBar.
 */
export function useDraft<T>(saved: T): Draft<T> {
  const [value, setValue] = useState<T>(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setValue(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const changes = useMemo(() => countChanges(saved, value), [savedKey, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const discard = useCallback(() => setValue(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value, set: setValue, changes, dirty: changes > 0, discard };
}
