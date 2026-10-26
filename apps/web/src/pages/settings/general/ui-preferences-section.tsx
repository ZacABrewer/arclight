import { useEffect, useState } from 'react';
import { Button, FormRow, Segmented, Select } from '../../../arclight/index.js';
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

const WEEK_STARTS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
] as const;

const TIME_FORMATS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: '24h', label: '24-hour' },
  { value: '12h', label: '12-hour' },
];

const COLUMN_OPTIONS = Array.from({ length: POSTER_COLUMNS_MAX - POSTER_COLUMNS_MIN + 1 }, (_, i) => {
  const n = POSTER_COLUMNS_MIN + i;
  const note = n === POSTER_COLUMNS_MIN ? ' (largest posters)' : n === POSTER_COLUMNS_MAX ? ' (smallest posters)' : '';
  return { value: String(n), label: `${n} columns${note}` };
});

/** A fixed sample instant for the format previews: 6 Oct 2026, 21:05 local. */
const SAMPLE = new Date(2026, 9, 6, 21, 5);

const samePrefs = (a: UiPreferences, b: UiPreferences) =>
  a.firstDayOfWeek === b.firstDayOfWeek && a.timeFormat === b.timeFormat && a.dateFormat === b.dateFormat && a.posterColumns === b.posterColumns;

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

  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.push({ tone: 'ok', title: 'UI preferences saved' }),
    });

  return (
    <SettingsSection
      label="UI"
      action={
        user ? (
          <div className="mk-row">
            {dirty ? (
              <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
                Discard
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={onSave}>
              Save preferences
            </Button>
          </div>
        ) : undefined
      }
    >
      <FormRow label="Theme" htmlFor="ui-theme" caption="Arclight is the only theme for now.">
        <Select id="ui-theme" value="arclight" disabled options={[{ value: 'arclight', label: 'Arclight' }]} />
      </FormRow>
      {user ? (
        <>
          <FormRow label="First day of week" caption="Where weeks start in the calendar.">
            <Segmented
              variant="soft"
              aria-label="First day of week"
              options={WEEK_STARTS}
              value={String(draft.firstDayOfWeek) as '0' | '1'}
              onChange={(v) => set({ firstDayOfWeek: v === '0' ? 0 : 1 })}
            />
          </FormRow>
          <FormRow label="Time format" caption={`Example: ${formatTime(SAMPLE, draft)}`} captionMono>
            <Segmented variant="soft" aria-label="Time format" options={TIME_FORMATS} value={draft.timeFormat} onChange={(v) => set({ timeFormat: v })} />
          </FormRow>
          <FormRow label="Date format" htmlFor="ui-date-format" caption={`Example: ${formatDate(SAMPLE, draft)}`} captionMono>
            <Select id="ui-date-format" value={draft.dateFormat} options={DATE_FORMATS} onChange={(e) => set({ dateFormat: e.currentTarget.value as DateFormat })} />
          </FormRow>
          <FormRow label="Poster size" htmlFor="ui-poster-columns" caption="Default for the library poster grid. The size slider there still changes it for a visit.">
            <Select
              id="ui-poster-columns"
              value={String(draft.posterColumns)}
              options={COLUMN_OPTIONS}
              onChange={(e) => set({ posterColumns: Number(e.currentTarget.value) })}
            />
          </FormRow>
        </>
      ) : (
        <p className="al-caption">UI preferences belong to a user account. Sign in with one to change them.</p>
      )}
    </SettingsSection>
  );
}
