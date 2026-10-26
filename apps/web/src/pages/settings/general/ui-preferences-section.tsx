import { useEffect, useState } from 'react';
import { Button, FormRow, Segmented, Select, type ReduceMotionSetting } from '../../../arclight/index.js';
import { useAuth } from '../../../auth/auth-context.js';
import { useToast } from '../../../components/toast.js';
import { useSaveUiPreferences, useUiPreferences } from '../../../hooks/ui-preferences.js';
import {
  DATE_FORMATS,
  POSTER_COLUMNS_MAX,
  POSTER_COLUMNS_MIN,
  formatDate,
  formatTime,
  type DateFormat,
  type TimeFormat,
  type UiPreferences,
} from '../../../lib/ui-preferences.js';
import { SettingsSection } from '../shared.js';
import { LanguageSelect } from '../../../components/language-select.js';
import { t, chooseLocale, deviceLocale, type LocaleSetting } from '../../../i18n/index.js';

const WEEK_STARTS = [
  { value: '0', get label() { return t('settings.general.uiPreferencesSection.sunday'); } },
  { value: '1', get label() { return t('settings.general.uiPreferencesSection.monday'); } },
] as const;

const TIME_FORMATS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: '24h', get label() { return t('settings.general.uiPreferencesSection.hour24'); } },
  { value: '12h', get label() { return t('settings.general.uiPreferencesSection.hour12'); } },
];

const REDUCE_MOTION: ReadonlyArray<{ value: ReduceMotionSetting; label: string }> = [
  { value: 'system', get label() { return t('settings.general.uiPreferencesSection.reduceMotionSystem'); } },
  { value: 'on', get label() { return t('settings.general.uiPreferencesSection.reduceMotionOn'); } },
  { value: 'off', get label() { return t('settings.general.uiPreferencesSection.reduceMotionOff'); } },
];

const columnOptions = () =>
  Array.from({ length: POSTER_COLUMNS_MAX - POSTER_COLUMNS_MIN + 1 }, (_, i) => {
    const n = POSTER_COLUMNS_MIN + i;
    const size = n === POSTER_COLUMNS_MIN ? 'largest' : n === POSTER_COLUMNS_MAX ? 'smallest' : 'none';
    return { value: String(n), label: t('settings.general.uiPreferencesSection.columnsOption', { count: n, size }) };
  });

/** A fixed sample instant for the format previews: 6 Oct 2026, 21:05 local. */
const SAMPLE = new Date(2026, 9, 6, 21, 5);

const samePrefs = (a: UiPreferences, b: UiPreferences) =>
  a.firstDayOfWeek === b.firstDayOfWeek &&
  a.timeFormat === b.timeFormat &&
  a.dateFormat === b.dateFormat &&
  a.posterColumns === b.posterColumns &&
  a.locale === b.locale &&
  a.reduceMotion === b.reduceMotion;

/**
 * Per-user UI preferences (stored in the signed-in user's settings, not the server-wide
 * settings), with their own Save so the page's float bar stays about the server settings.
 */
export function UiPreferencesSection() {
  const { user } = useAuth();
  const saved = useUiPreferences();
  const save = useSaveUiPreferences();
  const toast = useToast();
  const [draft, setDraft] = useState<UiPreferences>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = !samePrefs(draft, saved);
  const set = (patch: Partial<UiPreferences>) => setDraft((d) => ({ ...d, ...patch }));
  // Without a user account (API key / no-auth access) the language is a device choice.
  const [deviceChoice, setDeviceChoice] = useState<LocaleSetting>(() => deviceLocale() ?? 'auto');

  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.push({ tone: 'ok', title: t('settings.general.uiPreferencesSection.uiPreferencesSaved') }),
    });

  return (
    <SettingsSection
      label={t('settings.general.uiPreferencesSection.ui')}
      action={
        user ? (
          <div className="mk-row">
            {dirty ? (
              <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
                {t('common.discard')}
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={onSave}>
              {t('settings.general.uiPreferencesSection.savePreferences')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <FormRow label={t('settings.general.uiPreferencesSection.theme')} htmlFor="ui-theme" caption={t('settings.general.uiPreferencesSection.arclightIsTheOnlyTheme')}>
        <Select id="ui-theme" value="arclight" disabled options={[{ value: 'arclight', label: t('settings.general.uiPreferencesSection.arclight') }]} />
      </FormRow>
      {user ? (
        <FormRow label={t('settings.general.uiPreferencesSection.language')} htmlFor="ui-language" caption={t('settings.general.uiPreferencesSection.languageCaption')}>
          <LanguageSelect id="ui-language" value={draft.locale} onChange={(locale) => set({ locale })} />
        </FormRow>
      ) : (
        <FormRow label={t('settings.general.uiPreferencesSection.language')} htmlFor="ui-language" caption={t('settings.general.uiPreferencesSection.languageDeviceCaption')}>
          <LanguageSelect
            id="ui-language"
            value={deviceChoice}
            onChange={(locale) => {
              setDeviceChoice(locale);
              void chooseLocale(locale);
            }}
          />
        </FormRow>
      )}
      {user ? (
        <>
          <FormRow label={t('settings.general.uiPreferencesSection.firstDayOfWeek')} caption={t('settings.general.uiPreferencesSection.whereWeeksStartInThe')}>
            <Segmented
              variant="soft"
              aria-label={t('settings.general.uiPreferencesSection.firstDayOfWeek')}
              options={WEEK_STARTS}
              value={String(draft.firstDayOfWeek) as '0' | '1'}
              onChange={(v) => set({ firstDayOfWeek: v === '0' ? 0 : 1 })}
            />
          </FormRow>
          <FormRow label={t('settings.general.uiPreferencesSection.timeFormat')} caption={t('settings.general.uiPreferencesSection.exampleTime', { time: formatTime(SAMPLE, draft) })} captionMono>
            <Segmented variant="soft" aria-label={t('settings.general.uiPreferencesSection.timeFormat')} options={TIME_FORMATS} value={draft.timeFormat} onChange={(v) => set({ timeFormat: v })} />
          </FormRow>
          <FormRow label={t('settings.general.uiPreferencesSection.dateFormat')} htmlFor="ui-date-format" caption={t('settings.general.uiPreferencesSection.exampleDate', { date: formatDate(SAMPLE, draft) })} captionMono>
            <Select id="ui-date-format" value={draft.dateFormat} options={DATE_FORMATS} onChange={(e) => set({ dateFormat: e.currentTarget.value as DateFormat })} />
          </FormRow>
          <FormRow label={t('settings.general.uiPreferencesSection.posterSize')} htmlFor="ui-poster-columns" caption={t('settings.general.uiPreferencesSection.defaultForTheLibraryPoster')}>
            <Select
              id="ui-poster-columns"
              value={String(draft.posterColumns)}
              options={columnOptions()}
              onChange={(e) => set({ posterColumns: Number(e.currentTarget.value) })}
            />
          </FormRow>
          <FormRow label={t('settings.general.uiPreferencesSection.reduceMotion')} caption={t('settings.general.uiPreferencesSection.reduceMotionCaption')}>
            <Segmented
              variant="soft"
              aria-label={t('settings.general.uiPreferencesSection.reduceMotion')}
              options={REDUCE_MOTION}
              value={draft.reduceMotion}
              onChange={(v) => set({ reduceMotion: v })}
            />
          </FormRow>
        </>
      ) : (
        <p className="al-caption">{t('settings.general.uiPreferencesSection.uiPreferencesBelongToA')}</p>
      )}
    </SettingsSection>
  );
}
