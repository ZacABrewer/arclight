import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mobileApi } from '../../api/mobile.js';
import { Banner, FormRow, Skeleton, Toggle } from '../../arclight/index.js';
import { PushEventToggles } from '../push/browser-notifications.js';
import { shell, shellErrorCode, shellErrorMessage, type ArclightShellPlugin, type ShellInfo } from '../../lib/native-app.js';
import { t } from '../../i18n/index.js';
import { mobileKeys } from './mobile-app-section.js';

// Profile → Notifications on this device (inside the Arclight Admin app, in place of the web push
// toggle). On: ArclightShell.registerPush() → POST /mobile/devices. Off: DELETE the device →
// ArclightShell.unregisterPush(). The relay device id of this phone is remembered locally
// (it is not secret) so the toggle knows which listed device is this one.

export const DEVICE_ID_KEY = 'arclight.mobile.relayDeviceId';

function readDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

function writeDeviceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEVICE_ID_KEY, id);
    else localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    // Storage blocked: the toggle just shows off after a reload.
  }
}

export interface DeviceNotificationsProps {
  /** Test seam: the plugin (default: window.Capacitor.Plugins.ArclightShell). */
  plugin?: ArclightShellPlugin | null;
}

export function DeviceNotifications({ plugin = shell() }: DeviceNotificationsProps) {
  const qc = useQueryClient();
  const ids = useId();
  const [info, setInfo] = useState<ShellInfo | null | undefined>(undefined);
  const [deviceId, setDeviceId] = useState<string | null>(() => readDeviceId());
  const [error, setError] = useState<string | null>(null);
  const devices = useQuery({ queryKey: mobileKeys.devices(false), queryFn: mobileApi.devices, retry: false, enabled: plugin !== null });
  const pairing = useQuery({ queryKey: mobileKeys.pairing, queryFn: mobileApi.pairing, retry: false, enabled: plugin !== null });

  useEffect(() => {
    if (!plugin) return;
    let live = true;
    plugin
      .info()
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [plugin]);

  const thisDevice = deviceId ? devices.data?.find((d) => d.relayDeviceId === deviceId) : undefined;
  const enabled = thisDevice !== undefined;

  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (!plugin) return;
      if (on) {
        const reg = await plugin.registerPush();
        await mobileApi.register({ ...reg, ...(info?.appVersion ? { appVersion: info.appVersion } : {}) });
        writeDeviceId(reg.relayDeviceId);
        setDeviceId(reg.relayDeviceId);
      } else {
        if (thisDevice) await mobileApi.remove(thisDevice.id);
        await plugin.unregisterPush();
        writeDeviceId(null);
        setDeviceId(null);
      }
    },
    meta: { silent: true },
    onMutate: () => setError(null),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['mobile', 'devices'] }),
    onError: (err) => {
      const code = shellErrorCode(err);
      setError(code === 'denied' ? t('features.mobile.permissionDenied') : code === 'unavailable' ? t('features.mobile.pushUnavailable') : shellErrorMessage(err));
    },
  });

  // No plugin: a plain browser or an app build without the shell; nothing to show.
  if (!plugin) return null;
  if (info === undefined || devices.isPending) return <Skeleton lines={2} />;
  if (pairing.data && !pairing.data.pushEnabled) return <Banner tone="info">{t('features.mobile.pushDisabled')}</Banner>;
  if (info && !info.pushAvailable) return <Banner tone="info">{t('features.mobile.pushUnavailable')}</Banner>;

  return (
    <div className="mk-stack-sm" style={{ gap: 16 }}>
      <FormRow label={t('features.mobile.thisDevice')} htmlFor={`${ids}-on`} captionInline>
        <Toggle
          id={`${ids}-on`}
          checked={enabled}
          disabled={toggle.isPending}
          label={enabled ? t('features.mobile.notificationsOn') : t('features.mobile.notificationsOnThisDevice')}
          onChange={(e) => toggle.mutate(e.currentTarget.checked)}
        />
      </FormRow>
      {error ? (
        <p className="al-field__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <PushEventToggles />
    </div>
  );
}
