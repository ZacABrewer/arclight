import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ProfileSettings, VideoQuality } from '@arclight/shared';
import { systemApi } from '../../../../api/system.js';
import { useAuth } from '../../../../auth/auth-context.js';
import { cx } from '../../../../arclight/cx.js';
import { useT } from '../../../../i18n/index.js';
import { useThemeCatalog } from '../../../themes/use-themes.js';
import { QUALITIES } from '../../video/playback.js';
import { languageName } from '../../video/format.js';
import { useIsOwnerProfile, useProfileSettings, useSaveProfileSettings } from '../api.js';
import { RdIcon } from '../icons.js';
import { useLayout } from '../layout.js';
import { PLAYER_DEFAULT_THEME } from '../player-theme.js';
import { readStoredQuality, writeStoredQuality } from '../quality.js';
import { redesignPaths } from '../paths.js';
import { ActionRow, ChoiceRow, InfoRow, ToggleRow, type ChoiceOption } from '../settings-rows.js';
import { useProfilesView } from '../shell.js';
import { RdPage } from './common.js';

// Settings (the template's Settings screen; spec §4.4 portrait, §4.5 wide): the six categories.
// Everything follows the profile except Streaming quality, which is kept for this browser
// (§9 Q18, Q19). Wide: categories on the left, options on the right. Portrait: a category list
// whose entries open pushed pages; choices open a bottom sheet.

export const SETTINGS_CATEGORIES = ['library', 'playback', 'subtitles', 'display', 'profiles', 'about'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** Subtitle languages offered (ISO 639-1), after "Off". */
const SUBTITLE_LANGUAGES = ['en', 'de', 'es', 'fr', 'nl', 'it', 'pt', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'tr', 'ru', 'ja', 'ko', 'zh', 'ar', 'hi'];

export interface RdSettingsPageProps {
  /** Extra device rows per category (the app adds "Play intro on launch" under Display, §9 Q16). */
  deviceRows?: Partial<Record<SettingsCategory, ReactNode>> | undefined;
}

export function RdSettingsPage({ deviceRows }: RdSettingsPageProps = {}) {
  const t = useT();
  const layout = useLayout();
  const [cat, setCat] = useState<SettingsCategory | null>(layout === 'portrait' ? null : 'library');
  useEffect(() => {
    document.title = `${t('player.redesign.nav.settings')} · ${t('player.documentTitle')}`;
  }, [t]);
  const label = (c: SettingsCategory) => t(`player.redesign.settings.cat.${c}`);

  if (layout === 'portrait') {
    if (!cat) {
      return (
        <RdPage className="rd-settings rd-settings--portrait">
          <h1 className="rd-settings__title">{t('player.redesign.nav.settings')}</h1>
          <div className="rd-settings__opts">
            {SETTINGS_CATEGORIES.map((c) => (
              <ActionRow key={c} label={label(c)} onClick={() => setCat(c)} />
            ))}
          </div>
        </RdPage>
      );
    }
    return (
      <RdPage className="rd-settings rd-settings--portrait">
        <div className="rd-settings__push">
          <button type="button" className="rd-iconbtn" aria-label={t('player.redesign.back')} onClick={() => setCat(null)}>
            <RdIcon name="back" />
          </button>
          <h1 className="rd-settings__pane-title">{label(cat)}</h1>
        </div>
        <CategoryPane cat={cat} portrait extra={deviceRows?.[cat]} />
      </RdPage>
    );
  }

  const current = cat ?? 'library';
  return (
    <RdPage className="rd-settings rd-settings--wide">
      <nav className="rd-settings__cats" aria-label={t('player.redesign.nav.settings')}>
        <h1 className="rd-settings__title">{t('player.redesign.nav.settings')}</h1>
        {SETTINGS_CATEGORIES.map((c) => (
          <button key={c} type="button" className={cx('rd-settings__cat', c === current && 'is-on')} aria-current={c === current ? 'true' : undefined} onClick={() => setCat(c)}>
            <span className="rd-settings__dot" aria-hidden="true" />
            {label(c)}
          </button>
        ))}
      </nav>
      <section className="rd-settings__pane" aria-labelledby="rd-settings-pane">
        <h2 className="rd-settings__pane-title" id="rd-settings-pane">
          {label(current)}
        </h2>
        <CategoryPane cat={current} portrait={false} extra={deviceRows?.[current]} />
      </section>
    </RdPage>
  );
}

function CategoryPane({ cat, portrait, extra }: { cat: SettingsCategory; portrait: boolean; extra?: ReactNode }) {
  const t = useT();
  const s = useProfileSettings();
  const save = useSaveProfileSettings();
  const set = (patch: Partial<ProfileSettings>) => save.mutate(patch);
  const mode = portrait ? 'sheet' : 'cycle';
  const intro = (key: string) => <p className="rd-settings__intro">{t(key)}</p>;

  switch (cat) {
    case 'library':
      return (
        <div className="rd-settings__opts">
          {intro('player.redesign.settings.library.intro')}
          <ToggleRow label={t('player.redesign.nav.music')} desc={t('player.redesign.settings.library.musicDesc')} checked={s.showMusic} onChange={(v) => set({ showMusic: v })} />
          <ToggleRow label={t('player.redesign.nav.books')} desc={t('player.redesign.settings.library.booksDesc')} checked={s.showAudiobooks} onChange={(v) => set({ showAudiobooks: v })} />
          {extra}
        </div>
      );
    case 'playback':
      return (
        <div className="rd-settings__opts">
          {intro('player.redesign.settings.playback.intro')}
          <QualityRow mode={mode} />
          <ToggleRow label={t('player.redesign.settings.playback.autoplay')} desc={t('player.redesign.settings.playback.autoplayDesc')} checked={s.autoplayNext} onChange={(v) => set({ autoplayNext: v })} />
          <ToggleRow label={t('player.redesign.settings.playback.skipIntros')} checked={s.skipIntros} onChange={(v) => set({ skipIntros: v })} />
          {extra}
        </div>
      );
    case 'subtitles': {
      const langs: ChoiceOption<string>[] = [{ value: 'off', label: t('player.redesign.settings.subtitles.off') }, ...SUBTITLE_LANGUAGES.map((c) => ({ value: c, label: languageName(c) ?? c.toUpperCase() }))];
      if (s.subtitleLanguage && !SUBTITLE_LANGUAGES.includes(s.subtitleLanguage)) langs.push({ value: s.subtitleLanguage, label: languageName(s.subtitleLanguage) ?? s.subtitleLanguage });
      return (
        <div className="rd-settings__opts">
          <ChoiceRow
            label={t('player.redesign.settings.subtitles.language')}
            desc={t('player.redesign.settings.subtitles.languageDesc')}
            value={s.subtitleLanguage ?? 'off'}
            options={langs}
            mode="sheet"
            onChange={(v) => set({ subtitleLanguage: v === 'off' ? null : v })}
          />
          <ChoiceRow
            label={t('player.redesign.settings.subtitles.size')}
            value={s.subtitleSize}
            options={[
              { value: 'small', label: t('player.redesign.settings.subtitles.small') },
              { value: 'medium', label: t('player.redesign.settings.subtitles.medium') },
              { value: 'large', label: t('player.redesign.settings.subtitles.large') },
            ]}
            mode={mode}
            onChange={(v) => set({ subtitleSize: v })}
          />
          {extra}
        </div>
      );
    }
    case 'display':
      return (
        <div className="rd-settings__opts">
          <ToggleRow label={t('player.redesign.settings.display.heroRotate')} desc={t('player.redesign.settings.display.heroRotateDesc')} checked={s.heroRotate} onChange={(v) => set({ heroRotate: v })} />
          <ToggleRow label={t('player.redesign.settings.display.reduceMotion')} desc={t('player.redesign.settings.display.reduceMotionDesc')} checked={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
          <ChoiceRow
            label={t('player.redesign.settings.display.focus')}
            value={s.focusStyle}
            options={[
              { value: 'white-frame', label: t('player.redesign.settings.display.whiteFrame') },
              { value: 'cyan-glow', label: t('player.redesign.settings.display.cyanGlow') },
            ]}
            mode={mode}
            onChange={(v) => set({ focusStyle: v })}
          />
          <ThemeRow value={s.theme} onChange={(v) => set({ theme: v })} />
          {extra}
        </div>
      );
    case 'profiles':
      return <ProfilesPane extra={extra} />;
    case 'about':
      return <AboutPane extra={extra} />;
  }
}

/** Streaming quality, kept per browser and profile (§9 Q18: Auto / Original / 1080p / 720p / 480p). */
function QualityRow({ mode }: { mode: 'cycle' | 'sheet' }) {
  const t = useT();
  const { activeId } = useProfilesView();
  const [q, setQ] = useState<VideoQuality>(() => readStoredQuality(activeId));
  useEffect(() => setQ(readStoredQuality(activeId)), [activeId]);
  return (
    <ChoiceRow
      label={t('player.redesign.settings.playback.quality')}
      desc={t('player.redesign.settings.playback.qualityDesc')}
      value={q}
      options={QUALITIES.map((v) => ({ value: v, label: t(`player.video.qualityOption.${v}`) }))}
      mode={mode}
      onChange={(v) => {
        setQ(v);
        writeStoredQuality(activeId, v);
      }}
    />
  );
}

/** The player theme (§9 Q7): Cinema unless the profile picked another pack. */
function ThemeRow({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  const catalog = useThemeCatalog().data;
  if (!catalog || catalog.themes.length < 2) return null;
  const options = catalog.themes.map((x) => ({ value: x.id, label: x.name }));
  const current = value && options.some((o) => o.value === value) ? value : options.some((o) => o.value === PLAYER_DEFAULT_THEME) ? PLAYER_DEFAULT_THEME : options[0]!.value;
  return (
    <ChoiceRow
      label={t('player.redesign.settings.display.theme')}
      desc={t('player.redesign.settings.display.themeDesc')}
      value={current}
      options={options}
      mode="sheet"
      onChange={(v) => onChange(v === PLAYER_DEFAULT_THEME ? null : v)}
    />
  );
}

function ProfilesPane({ extra }: { extra?: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const { me, canManage } = useProfilesView();
  const owner = useIsOwnerProfile();
  return (
    <div className="rd-settings__opts">
      <ActionRow label={t('player.redesign.settings.profiles.switch')} value={me.name} onClick={() => void navigate({ to: redesignPaths.profiles as '/player' })} />
      {owner && canManage ? (
        <ActionRow
          label={t('player.redesign.profiles.manage')}
          desc={t('player.redesign.settings.profiles.manageDesc')}
          onClick={() => void navigate({ to: redesignPaths.profiles as '/player', search: { manage: 1 } as never })}
        />
      ) : null}
      {extra}
    </div>
  );
}

function AboutPane({ extra }: { extra?: ReactNode }) {
  const t = useT();
  const { isAdmin } = useAuth();
  const { me } = useProfilesView();
  const status = useQuery({ queryKey: ['player-redesign', 'about-status'], queryFn: systemApi.status, enabled: isAdmin, retry: false, staleTime: 5 * 60_000, meta: { silent: true } });
  const version = (status.data as { version?: string } | undefined)?.version;
  return (
    <div className="rd-settings__opts">
      <InfoRow label={t('player.redesign.settings.about.server')} value={typeof window === 'undefined' ? '' : window.location.host} />
      {version ? <InfoRow label={t('player.redesign.settings.about.version')} value={version} /> : null}
      <InfoRow label={t('player.redesign.settings.about.signedInAs')} value={me.name} />
      {extra}
    </div>
  );
}
