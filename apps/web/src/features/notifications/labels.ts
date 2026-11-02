import type { NotificationDeliveryState, NotificationDeliveryStatus, NotificationMediaType, PersonalNotificationEvent } from '@arclight/shared';
import type { NotificationTestResult } from '../../api/notifications.js';
import type { ChipTone } from '../../arclight/index.js';
import type { TestOutcome } from '../../components/forms/test-result.js';
import { hasKey, t } from '../../i18n/index.js';

// Labels shared by the connection editor (Settings > Notifications) and the personal
// destinations panel (Profile, request portal account page).

/** A /test answer as the Test button shows it (`{ok, message, code}` from the api). */
export function notificationTestOutcome(r: NotificationTestResult): TestOutcome {
  const errors = r.error ? [r.error.message] : !r.ok && r.message ? [r.code ? `${r.message} (${r.code})` : r.message] : [];
  return { ok: r.ok, warnings: r.warnings ?? [], errors };
}

/** `requestApproved` -> "Request approved" for keys without a translation. */
function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A template key or delivery event type (`default`, `grab`, `requestApproved`, ...). */
export function eventTypeLabel(key: string): string {
  return hasKey(`notify.event.${key}`) ? t(`notify.event.${key}`) : humanize(key);
}

export function personalEventLabel(event: PersonalNotificationEvent): string {
  return t(`notify.personalEvent.${event}`);
}

export function personalEventHint(event: PersonalNotificationEvent): string | undefined {
  return hasKey(`notify.personalEventHint.${event}`) ? t(`notify.personalEventHint.${event}`) : undefined;
}

export const MEDIA_TYPES: readonly NotificationMediaType[] = ['series', 'movie', 'music', 'audiobook'];

export function mediaTypeLabel(type: NotificationMediaType): string {
  switch (type) {
    case 'series':
      return t('common.series');
    case 'movie':
      return t('common.movies');
    case 'music':
      return t('common.music');
    case 'audiobook':
      return t('common.audiobooks');
  }
}

export function deliveryStateLabel(state: NotificationDeliveryState): string {
  return t(`notify.state.${state}`);
}

const STATE_TONE: Record<NotificationDeliveryState, ChipTone> = {
  sent: 'accent',
  failed: 'danger',
  held: 'neutral',
  rateLimited: 'warn',
  skipped: 'muted',
};

export function deliveryStateTone(state: NotificationDeliveryState): ChipTone {
  return STATE_TONE[state];
}

/** "3 consecutive failures · last error: 401 Unauthorized"; null while deliveries succeed. */
export function deliveryStatusSummary(status: NotificationDeliveryStatus | undefined | null): string | null {
  if (!status || status.consecutiveFailures <= 0) return null;
  const head = t('notify.status.failures', { count: status.consecutiveFailures });
  return status.lastError ? `${head} · ${t('notify.status.lastError', { error: status.lastError })}` : head;
}
