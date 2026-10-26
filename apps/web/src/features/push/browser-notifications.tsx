import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PushPreferences } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { pushApi } from '../../api/push.js';
import { Banner, Button, Chip, FormRow, Skeleton, Toggle } from '../../arclight/index.js';
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from '../../lib/web-push.js';
import { t } from '../../i18n/index.js';

// Profile → Browser notifications: subscribe this browser to web push and choose which
// events reach it. Preferences are per user (all browsers), the subscription per browser.

const prefKeys = ['push', 'preferences'] as const;

const EVENTS: Array<{ key: keyof PushPreferences; label: string; caption: string }> = [
  { key: 'requests', get label() { return t('common.requests'); }, get caption() { return t('features.push.browserNotifications.yourRequestsAreApprovedDeclined'); } },
  { key: 'availability', get label() { return t('features.push.browserNotifications.availability'); }, get caption() { return t('features.push.browserNotifications.somethingYouRequestedIsReady'); } },
  { key: 'issues', get label() { return t('common.issues'); }, get caption() { return t('features.push.browserNotifications.updatesOnIssuesYouReported'); } },
];

export interface BrowserNotificationsProps {
  /** Test seam: support detection. */
  support?: PushSupport;
}

export function BrowserNotifications({ support = pushSupport() }: BrowserNotificationsProps) {
  const qc = useQueryClient();
  const ids = useId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefs = useQuery({ queryKey: prefKeys, queryFn: pushApi.preferences, retry: false, enabled: support === 'supported' });
  const savePrefs = useMutation({
    mutationFn: pushApi.setPreferences,
    meta: { errorTitle: t('features.push.browserNotifications.couldNotSaveNotificationPreferences') },
    onSuccess: (p) => qc.setQueryData(prefKeys, p),
  });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await enablePush();
      else await disablePush();
      return on;
    },
    meta: { silent: true },
    onMutate: () => setError(null),
    onSuccess: (on) => setEnabled(on),
    onError: (err) => setError(errorMessage(err)),
  });
  const test = useMutation({ mutationFn: pushApi.test, meta: { errorTitle: t('features.push.browserNotifications.testNotificationFailed') } });

  useEffect(() => {
    if (support !== 'supported') return;
    let live = true;
    currentSubscription()
      .then((sub) => live && setEnabled(sub !== null && Notification.permission === 'granted'))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, [support]);

  if (support === 'unsupported') {
    return <Banner tone="info">{t('features.push.browserNotifications.thisBrowserDoesNotSupport')}</Banner>;
  }
  if (support === 'insecure') {
    return <Banner tone="warn">{t('features.push.browserNotifications.browserNotificationsNeedHttpsOr')}</Banner>;
  }

  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  return (
    <div className="mk-stack-sm" style={{ gap: 16 }}>
      <FormRow label={t('features.push.browserNotifications.thisBrowser')} htmlFor={`${ids}-on`} captionInline>
        {enabled === null ? (
          <Skeleton lines={1} />
        ) : (
          <span className="mk-row" style={{ gap: 12 }}>
            <Toggle
              id={`${ids}-on`}
              checked={enabled}
              disabled={toggle.isPending || (denied && !enabled)}
              label={enabled ? t('features.push.browserNotifications.notificationsAreOn') : t('features.push.browserNotifications.showNotificationsInThisBrowser')}
              onChange={(e) => toggle.mutate(e.currentTarget.checked)}
            />
            {enabled ? (
              <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>
                {t('features.push.browserNotifications.sendTest')}
              </Button>
            ) : null}
            {test.data ? (
              <Chip tone={test.data.sent > 0 ? 'accent' : 'warn'}>{test.data.sent > 0 ? t('features.push.browserNotifications.sentToBrowsers', { sent: test.data.sent }) : t('features.push.browserNotifications.noBrowserReceivedIt')}</Chip>
            ) : null}
          </span>
        )}
      </FormRow>
      {denied && !enabled ? <Banner tone="warn">{t('features.push.browserNotifications.notificationsAreBlockedForThis')}</Banner> : null}
      {error ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {prefs.data
        ? EVENTS.map((ev) => (
            <FormRow key={ev.key} label={ev.label} htmlFor={`${ids}-${ev.key}`} captionInline>
              <Toggle
                id={`${ids}-${ev.key}`}
                checked={prefs.data[ev.key]}
                disabled={savePrefs.isPending}
                label={ev.caption}
                onChange={(e) => savePrefs.mutate({ ...prefs.data, [ev.key]: e.currentTarget.checked })}
              />
            </FormRow>
          ))
        : prefs.isPending
          ? <Skeleton lines={3} />
          : null}
    </div>
  );
}
