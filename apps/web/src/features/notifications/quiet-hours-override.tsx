import { QuietHoursSettings } from '@arclight/shared';
import { Checkbox, FormRow, RadioGroup, Toggle } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';
import { TimeRow, toggleDay, useWeekdays } from '../../pages/settings/notifications/alert-settings-section.js';

// A destination's own quiet hours: null follows the global window (Settings > Notifications),
// otherwise the same controls as the global section.

export const DEFAULT_CUSTOM_QUIET_HOURS: QuietHoursSettings = QuietHoursSettings.parse({ enabled: true });

export function QuietHoursOverride({
  value,
  onChange,
  followLabel,
}: {
  value: QuietHoursSettings | null;
  onChange: (next: QuietHoursSettings | null) => void;
  /** Label of the "inherit" choice (default: follow the global quiet hours). */
  followLabel?: string | undefined;
}) {
  const weekdays = useWeekdays();
  const set = (patch: Partial<QuietHoursSettings>) => value && onChange({ ...value, ...patch });
  return (
    <div className="al-quiet-override">
      <RadioGroup
        legend={t('notify.quiet.legend')}
        value={value ? 'custom' : 'follow'}
        onChange={(mode) => onChange(mode === 'custom' ? (value ?? DEFAULT_CUSTOM_QUIET_HOURS) : null)}
        options={[
          { value: 'follow', label: followLabel ?? t('notify.quiet.follow') },
          { value: 'custom', label: t('notify.quiet.custom') },
        ]}
      />
      {value ? (
        <>
          <FormRow label={t('settings.notifications.alerts.quietHours')} caption={t('notify.quiet.enabledCaption')} captionInline>
            <Toggle aria-label={t('settings.notifications.alerts.quietHours')} checked={value.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
          </FormRow>
          {value.enabled ? (
            <>
              <TimeRow label={t('settings.notifications.alerts.start')} value={value.start} onChange={(start) => set({ start })} />
              <TimeRow label={t('settings.notifications.alerts.end')} caption={t('settings.notifications.alerts.endCaption')} value={value.end} onChange={(end) => set({ end })} />
              <FormRow label={t('settings.notifications.alerts.days')}>
                <div className="al-check-grid al-quiet-days" role="group" aria-label={t('settings.notifications.alerts.days')}>
                  {weekdays.map(({ day, label }) => (
                    <Checkbox
                      key={day}
                      label={label}
                      checked={value.days.includes(day)}
                      onChange={(e) => set({ days: toggleDay(value.days, day, e.currentTarget.checked) })}
                    />
                  ))}
                </div>
              </FormRow>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
