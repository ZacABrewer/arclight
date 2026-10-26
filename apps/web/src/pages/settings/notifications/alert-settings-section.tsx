import { useId } from 'react';
import { LocalTime, type AlertSettings, type AlertSettingsResponse, type Weekday } from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { Button, Checkbox, ErrorBlock, FormRow, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useAlertSettings, useSaveAlertSettings } from '../../../hooks/alerts.js';
import { useUiPreferences } from '../../../hooks/ui-preferences.js';
import { t, weekdayNames } from '../../../i18n/index.js';
import { useDraft } from '../settings-layout.js';
import { PendingApiNotice, SettingsSection } from '../shared.js';

// Quiet hours and the daily summary (settings section `alerts`), with their own Save so the
// connection list above keeps its per-connection editor. Times are server local "HH:MM".

/** The PUT body from a GET response: the settings without the live status fields. */
export function toAlertSettings(res: AlertSettingsResponse): AlertSettings {
  return {
    quietHours: { ...res.quietHours, days: [...res.quietHours.days].sort((a, b) => a - b) },
    dailySummary: { ...res.dailySummary },
  };
}

/** `days` with `day` switched on or off, sorted Sunday first. */
export function toggleDay(days: readonly Weekday[], day: Weekday, on: boolean): Weekday[] {
  const next = new Set(days);
  if (on) next.add(day);
  else next.delete(day);
  return [...next].sort((a, b) => a - b);
}

export const isLocalTime = (value: string) => LocalTime.safeParse(value).success;

/** Whether every time in the draft is a valid "HH:MM". */
export function alertSettingsValid(s: AlertSettings): boolean {
  return isLocalTime(s.quietHours.start) && isLocalTime(s.quietHours.end) && isLocalTime(s.dailySummary.time);
}

/** "Quiet hours are in effect now" · "3 alerts held"; empty when neither applies. */
export function alertStatusLines(res: Pick<AlertSettingsResponse, 'quietNow' | 'heldAlerts'>): string[] {
  const lines: string[] = [];
  if (res.quietNow) lines.push(t('settings.notifications.alerts.quietNow'));
  if (res.heldAlerts > 0) lines.push(t('settings.notifications.alerts.heldAlerts', { count: res.heldAlerts }));
  return lines;
}

/** Weekdays in the user's week order, labelled in the active locale. */
function useWeekdays(): Array<{ day: Weekday; label: string }> {
  const { firstDayOfWeek } = useUiPreferences();
  const names = weekdayNames(firstDayOfWeek, 'short');
  return names.map((label, i) => ({ day: ((firstDayOfWeek + i) % 7) as Weekday, label }));
}

function TimeRow({ label, caption, value, onChange }: { label: string; caption?: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const invalid = !isLocalTime(value);
  return (
    <FormRow label={label} htmlFor={id} caption={caption} error={invalid ? t('settings.notifications.alerts.useHhMm') : undefined}>
      <Input id={id} type="time" mono className="al-input--num" value={value} invalid={invalid} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function AlertForm({ data }: { data: AlertSettingsResponse }) {
  const draft = useDraft(toAlertSettings(data));
  const save = useSaveAlertSettings();
  const toast = useToast();
  const weekdays = useWeekdays();
  const d = draft.value;
  const valid = alertSettingsValid(d);
  const setQuiet = (patch: Partial<AlertSettings['quietHours']>) => draft.set((p) => ({ ...p, quietHours: { ...p.quietHours, ...patch } }));
  const setSummary = (patch: Partial<AlertSettings['dailySummary']>) => draft.set((p) => ({ ...p, dailySummary: { ...p.dailySummary, ...patch } }));
  const status = alertStatusLines(data);

  const onSave = () =>
    save.mutate(d, {
      onSuccess: () => toast.push({ tone: 'ok', title: t('settings.notifications.alerts.saved') }),
    });

  return (
    <SettingsSection
      label={t('settings.notifications.alerts.label')}
      action={
        <div className="mk-row">
          {draft.dirty ? (
            <Button size="sm" variant="ghost" onClick={draft.discard}>
              {t('common.discard')}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={!draft.dirty || !valid} loading={save.isPending} onClick={onSave}>
            {t('settings.notifications.alerts.save')}
          </Button>
        </div>
      }
    >
      {status.length ? (
        <p className="al-notice" role="status">
          {status.join(' · ')}
        </p>
      ) : null}
      <FormRow label={t('settings.notifications.alerts.quietHours')} caption={t('settings.notifications.alerts.quietHoursCaption')} captionInline>
        <Toggle aria-label={t('settings.notifications.alerts.quietHours')} checked={d.quietHours.enabled} onChange={(e) => setQuiet({ enabled: e.currentTarget.checked })} />
      </FormRow>
      {d.quietHours.enabled ? (
        <>
          <TimeRow label={t('settings.notifications.alerts.start')} value={d.quietHours.start} onChange={(start) => setQuiet({ start })} />
          <TimeRow
            label={t('settings.notifications.alerts.end')}
            caption={t('settings.notifications.alerts.endCaption')}
            value={d.quietHours.end}
            onChange={(end) => setQuiet({ end })}
          />
          <FormRow label={t('settings.notifications.alerts.days')} caption={t('settings.notifications.alerts.daysCaption')}>
            <div className="al-check-grid al-quiet-days" role="group" aria-label={t('settings.notifications.alerts.days')}>
              {weekdays.map(({ day, label }) => (
                <Checkbox
                  key={day}
                  label={label}
                  checked={d.quietHours.days.includes(day)}
                  onChange={(e) => setQuiet({ days: toggleDay(d.quietHours.days, day, e.currentTarget.checked) })}
                />
              ))}
            </div>
          </FormRow>
        </>
      ) : null}
      <FormRow label={t('settings.notifications.alerts.dailySummary')} caption={t('settings.notifications.alerts.dailySummaryCaption')} captionInline>
        <Toggle
          aria-label={t('settings.notifications.alerts.dailySummary')}
          checked={d.dailySummary.enabled}
          onChange={(e) => setSummary({ enabled: e.currentTarget.checked })}
        />
      </FormRow>
      {d.dailySummary.enabled ? (
        <TimeRow label={t('settings.notifications.alerts.summaryTime')} value={d.dailySummary.time} onChange={(time) => setSummary({ time })} />
      ) : null}
    </SettingsSection>
  );
}

/** Quiet hours and daily summary settings for Settings -> Notifications. */
export function AlertSettingsSection() {
  const settings = useAlertSettings();
  if (settings.data) return <AlertForm data={settings.data} />;
  return (
    <SettingsSection label={t('settings.notifications.alerts.label')}>
      {settings.isPending ? (
        <Skeleton lines={3} />
      ) : settings.error instanceof ApiError && settings.error.status === 404 ? (
        <PendingApiNotice what={t('settings.notifications.alerts.label')} />
      ) : (
        <ErrorBlock title={t('settings.notifications.alerts.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      )}
    </SettingsSection>
  );
}
