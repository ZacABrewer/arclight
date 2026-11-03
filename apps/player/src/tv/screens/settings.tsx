import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ThemeCatalog, type ProfileSettings, type ProfileSettingsPatch, type VideoQuality } from '@arclight/shared';
import { useLocale, useT } from '@web/i18n/index';
import { useAccounts } from '../../app/context';
import { APP_VERSION } from '../../config';
import { request } from '../../core/api';
import { useActiveProfile, useProfileSettings, useSaveProfileSettings } from '../../households/api';
import { playIntroOnLaunch, setPlayIntroOnLaunch } from '../../intro/launch';
import { DEVICE_SETTINGS_PATH } from '../../ui/phone-pages';
import { DEFAULT_PLAYER_THEME } from '../../ui/profile-theme';
import { readVideoQuality, VIDEO_QUALITIES, writeVideoQuality } from '../../video/quality';
import { PROFILES_PATH } from '../tv-runtime';
import type { Translate } from '../format';

// Settings (template "settings"): the category list on the left (focusing one selects it) and its
// option rows on the right. Toggles flip on OK, choices cycle to the next value, actions open a
// screen, info rows only show a value. Profile settings save to the active profile; Streaming
// quality and Play intro on launch stay on this device (§4.3, §6, §9 Q16, Q18, Q19).

export const SETTINGS_CATEGORIES = ['library', 'playback', 'subtitles', 'display', 'profiles', 'about'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** Subtitle languages offered (null: off). Names come from Intl in the UI language. */
export const SUBTITLE_LANGUAGES: readonly (string | null)[] = [null, 'en', 'es', 'fr', 'de', 'nl', 'it', 'pt'];

export const MANAGE_PROFILES_PATH = '/player/settings/profiles';

export type SettingsOption =
  | { kind: 'toggle'; key: string; label: string; desc?: string | undefined; on: boolean; flip: () => void }
  | { kind: 'choice'; key: string; label: string; desc?: string | undefined; value: string; next: () => void }
  | { kind: 'info'; key: string; label: string; value: string }
  | { kind: 'action'; key: string; label: string; value: string; run: () => void };

/** The value after `current` in `list`, wrapping (the template's choice rows). */
export function cycle<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length] as T;
}

export function languageName(code: string | null, locale: string, t: Translate): string {
  if (!code) return t('app.tv.settings.off');
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code;
  } catch {
    return code;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function OptionRow({ o }: { o: SettingsOption }) {
  const onClick = o.kind === 'toggle' ? o.flip : o.kind === 'choice' ? o.next : o.kind === 'action' ? o.run : undefined;
  return (
    <button
      type="button"
      className="tv-opt"
      data-tv-key={`opt-${o.key}`}
      onClick={onClick}
      aria-pressed={o.kind === 'toggle' ? o.on : undefined}
      style={o.kind === 'info' ? { cursor: 'default' } : undefined}
    >
      <span className="tv-opt__text">
        <span className="tv-opt__label">{o.label}</span>
        {'desc' in o && o.desc ? <span className="tv-opt__desc">{o.desc}</span> : null}
      </span>
      {o.kind === 'toggle' ? (
        <span className={`tv-toggle${o.on ? ' tv-toggle--on' : ''}`} aria-hidden="true">
          <span className="tv-toggle__knob" />
        </span>
      ) : null}
      {o.kind === 'choice' ? (
        <span className="tv-opt__choice">
          {o.value}
          <span className="tv-chev" aria-hidden="true">
            ›
          </span>
        </span>
      ) : null}
      {o.kind === 'info' ? <span className="tv-opt__info">{o.value}</span> : null}
      {o.kind === 'action' ? (
        <span className="tv-opt__action">
          {o.value}
          <span className="tv-chev" aria-hidden="true">
            ›
          </span>
        </span>
      ) : null}
    </button>
  );
}

export function TvSettingsScreen() {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const settings = useProfileSettings();
  const save = useSaveProfileSettings();
  const { profile, canManage } = useActiveProfile();
  const { active } = useAccounts();
  const [cat, setCat] = useState<SettingsCategory>('library');
  const [quality, setQuality] = useState<VideoQuality>(() => readVideoQuality(profile?.id));
  const [intro, setIntro] = useState(playIntroOnLaunch);
  const themes = useQuery({ queryKey: ['theme', 'catalog'], queryFn: () => request('/theme', ThemeCatalog), staleTime: 5 * 60_000, retry: false, meta: { silent: true } });

  // The quality shown follows the profile once it is known.
  const profileId = profile?.id ?? null;
  const [qualityFor, setQualityFor] = useState(profileId);
  if (qualityFor !== profileId) {
    setQualityFor(profileId);
    setQuality(readVideoQuality(profileId));
  }

  const set = (patch: ProfileSettingsPatch) => save.mutate(patch);
  const flip = (key: keyof ProfileSettings & keyof ProfileSettingsPatch) => () => set({ [key]: !settings[key] } as ProfileSettingsPatch);

  const options = useMemo<SettingsOption[]>(() => {
    const qualityLabel = (q: VideoQuality) => (q === 'auto' ? t('app.tv.settings.auto') : q === 'original' ? t('app.tv.settings.original') : q);
    switch (cat) {
      case 'library':
        return [
          { kind: 'toggle', key: 'showMusic', label: t('app.tv.tab.music'), desc: t('app.tv.settings.musicDesc'), on: settings.showMusic, flip: flip('showMusic') },
          { kind: 'toggle', key: 'showAudiobooks', label: t('app.tv.tab.books'), desc: t('app.tv.settings.audiobooksDesc'), on: settings.showAudiobooks, flip: flip('showAudiobooks') },
        ];
      case 'playback':
        return [
          {
            kind: 'choice',
            key: 'quality',
            label: t('app.tv.settings.quality'),
            desc: t('app.tv.settings.qualityDesc'),
            value: qualityLabel(quality),
            next: () => {
              const q = cycle(VIDEO_QUALITIES, quality);
              writeVideoQuality(profileId, q);
              setQuality(q);
            },
          },
          { kind: 'toggle', key: 'autoplayNext', label: t('app.tv.settings.autoplayNext'), desc: t('app.tv.settings.autoplayNextDesc'), on: settings.autoplayNext, flip: flip('autoplayNext') },
          { kind: 'toggle', key: 'skipIntros', label: t('app.tv.settings.skipIntros'), on: settings.skipIntros, flip: flip('skipIntros') },
        ];
      case 'subtitles': {
        const sizes = ['small', 'medium', 'large'] as const;
        return [
          {
            kind: 'choice',
            key: 'subtitleLanguage',
            label: t('app.tv.settings.subtitleLanguage'),
            desc: t('app.tv.settings.subtitleLanguageDesc'),
            value: languageName(settings.subtitleLanguage, locale, t),
            next: () => set({ subtitleLanguage: cycle(SUBTITLE_LANGUAGES, SUBTITLE_LANGUAGES.includes(settings.subtitleLanguage) ? settings.subtitleLanguage : null) }),
          },
          {
            kind: 'choice',
            key: 'subtitleSize',
            label: t('app.tv.settings.textSize'),
            value: t(`app.tv.settings.size.${settings.subtitleSize}`),
            next: () => set({ subtitleSize: cycle(sizes, settings.subtitleSize) }),
          },
        ];
      }
      case 'display': {
        const out: SettingsOption[] = [
          { kind: 'toggle', key: 'heroRotate', label: t('app.tv.settings.heroRotate'), desc: t('app.tv.settings.heroRotateDesc'), on: settings.heroRotate, flip: flip('heroRotate') },
          { kind: 'toggle', key: 'reduceMotion', label: t('app.tv.settings.reduceMotion'), desc: t('app.tv.settings.reduceMotionDesc'), on: settings.reduceMotion, flip: flip('reduceMotion') },
          {
            kind: 'choice',
            key: 'focusStyle',
            label: t('app.tv.settings.focusStyle'),
            value: t(settings.focusStyle === 'cyan-glow' ? 'app.tv.settings.cyanGlow' : 'app.tv.settings.whiteFrame'),
            next: () => set({ focusStyle: settings.focusStyle === 'cyan-glow' ? 'white-frame' : 'cyan-glow' }),
          },
        ];
        const list = themes.data?.themes ?? [];
        if (list.length > 1) {
          const ids = list.map((x) => x.id);
          const current = settings.theme && ids.includes(settings.theme) ? settings.theme : DEFAULT_PLAYER_THEME;
          out.push({
            kind: 'choice',
            key: 'theme',
            label: t('app.tv.settings.theme'),
            value: list.find((x) => x.id === current)?.name ?? current,
            next: () => {
              const id = cycle(ids, current);
              set({ theme: id === DEFAULT_PLAYER_THEME ? null : id });
            },
          });
        }
        out.push({
          kind: 'toggle',
          key: 'playIntro',
          label: t('app.tv.settings.playIntro'),
          on: intro,
          flip: () => {
            setPlayIntroOnLaunch(!intro);
            setIntro(!intro);
          },
        });
        return out;
      }
      case 'profiles': {
        const out: SettingsOption[] = [{ kind: 'action', key: 'switchProfile', label: t('app.tv.switchProfile'), value: profile?.name ?? '', run: () => void navigate({ to: PROFILES_PATH }) }];
        if (canManage) out.push({ kind: 'action', key: 'manageProfiles', label: t('app.tv.settings.manageProfiles'), value: '', run: () => void navigate({ to: MANAGE_PROFILES_PATH }) });
        return out;
      }
      case 'about':
        return [
          { kind: 'info', key: 'server', label: t('app.tv.settings.server'), value: active ? `${active.serverName} · ${hostOf(active.serverUrl)}` : '' },
          { kind: 'info', key: 'version', label: t('app.tv.settings.appVersion'), value: APP_VERSION },
          { kind: 'info', key: 'account', label: t('app.tv.settings.signedInAs'), value: [active?.displayName || active?.username, profile?.name].filter(Boolean).join(' · ') },
          // Accounts (sign out, another server), streaming, downloads and language: the phone's "This device" page.
          { kind: 'action', key: 'device', label: t('app.settings.device'), value: '', run: () => void navigate({ to: DEVICE_SETTINGS_PATH }) },
        ];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, settings, quality, intro, themes.data, profile, canManage, active, locale, t, profileId]);

  const intros: Partial<Record<SettingsCategory, string>> = {
    library: t('app.tv.settings.libraryIntro'),
    playback: t('app.tv.settings.playbackIntro'),
  };

  return (
    <div className="tv-settings">
      <div className="tv-settings__cats">
        <h1 className="tv-h1">{t('app.tv.tab.settings')}</h1>
        {SETTINGS_CATEGORIES.map((c, i) => (
          <button
            key={c}
            type="button"
            className="tv-cat"
            data-tv-key={`cat-${c}`}
            data-tv-autofocus={i === 0 ? '' : undefined}
            aria-current={c === cat ? 'true' : undefined}
            onFocus={() => setCat(c)}
            onClick={() => setCat(c)}
          >
            <span className="tv-cat__dot" aria-hidden="true" />
            {t(`app.tv.settings.cat.${c}`)}
          </button>
        ))}
      </div>
      <div className="tv-settings__pane">
        <h2 className="tv-settings__title">{t(`app.tv.settings.cat.${cat}`)}</h2>
        {intros[cat] ? <p className="tv-settings__intro">{intros[cat]}</p> : null}
        {options.map((o) => (
          <OptionRow key={o.key} o={o} />
        ))}
      </div>
    </div>
  );
}
