import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MOBILE_APP_URL, mobilePairingUri, type MobileDeviceResource, type MobileTestResult } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { mobileApi } from '../../api/mobile.js';
import { Banner, Button, Chip, ErrorBlock, Skeleton } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { copyText } from '../../lib/clipboard.js';
import { relativeTime } from '../../lib/format.js';
import { encodeQr, qrPath } from '../../lib/qr.js';
import { t } from '../../i18n/index.js';
import './mobile.css';

// "Mobile app": pair the Arclight companion app with this server by QR code, and manage the
// phones that receive notifications. On Profile for everyone (request-portal users too), and
// under Settings → Notifications for admins, who see every user's devices.

export const mobileKeys = {
  pairing: ['mobile', 'pairing'] as const,
  devices: (all: boolean) => ['mobile', 'devices', all ? 'all' : 'mine'] as const,
};

/** The base URL the app should connect to: the Application URL when set, else this page's origin. */
export function pairingServerUrl(serverUrl: string | null | undefined, origin: string = window.location.origin): string {
  return (serverUrl?.trim() || origin).replace(/\/+$/, '');
}

export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const { path, dim } = useMemo(() => {
    const m = encodeQr(value, 'M');
    return { path: qrPath(m, 4), dim: m.size + 8 };
  }, [value]);
  return (
    <svg className="mobile-qr" role="img" aria-label={label} viewBox={`0 0 ${dim} ${dim}`} width={size} height={size} shapeRendering="crispEdges" data-value={value}>
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function testOutcomeText(r: MobileTestResult): string {
  switch (r.outcome) {
    case 'sent':
      return t('features.mobile.testSent');
    case 'removed':
      return t('features.mobile.testRemoved');
    case 'rate_limited':
      return t('features.mobile.testRateLimited');
    case 'disabled':
      return t('features.mobile.pushDisabled');
    default:
      return r.message ?? t('features.mobile.testFailed');
  }
}

function platformLabel(p: MobileDeviceResource['platform']): string {
  return p === 'ios' ? t('features.mobile.platformIos') : t('features.mobile.platformAndroid');
}

export function MobileDeviceList({ all = false }: { all?: boolean }) {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: mobileKeys.devices(all), queryFn: all ? mobileApi.allDevices : mobileApi.devices, retry: false });
  const [removing, setRemoving] = useState<MobileDeviceResource | null>(null);
  const [results, setResults] = useState<Record<number, MobileTestResult>>({});
  const test = useMutation({
    mutationFn: async (id: number) => ({ id, result: await mobileApi.test(id) }),
    meta: { errorTitle: t('features.mobile.testFailed') },
    onSuccess: ({ id, result }) => {
      setResults((r) => ({ ...r, [id]: result }));
      if (result.outcome === 'removed') void qc.invalidateQueries({ queryKey: ['mobile', 'devices'] });
    },
  });

  if (devices.isPending) return <Skeleton lines={2} />;
  if (devices.isError) {
    return (
      <ErrorBlock title={t('features.mobile.couldNotLoadDevices')} onRetry={() => void devices.refetch()}>
        {errorMessage(devices.error)}
      </ErrorBlock>
    );
  }
  if (devices.data.length === 0) {
    return (
      <p className="al-caption" style={{ margin: 0 }}>
        {all ? t('features.mobile.noDevicesAll') : t('features.mobile.noDevices')}
      </p>
    );
  }
  return (
    <>
      <ul className="mobile-devices" aria-label={t('features.mobile.pairedDevices')}>
        {devices.data.map((d) => {
          const result = results[d.id];
          return (
            <li key={d.id} className="mobile-device">
              <div className="mobile-device__main">
                <strong className="mobile-device__name">{d.deviceName || platformLabel(d.platform)}</strong>
                <span className="al-caption">
                  {[all && d.userName ? d.userName : null, platformLabel(d.platform), d.appVersion ? t('features.mobile.appVersion', { version: d.appVersion }) : null, t('features.mobile.lastSeen', { when: relativeTime(d.lastSeenAt) })]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {d.lastError ? <span className="al-inline-warning">{d.lastError}</span> : null}
              </div>
              <div className="mobile-device__actions">
                {result ? <Chip tone={result.ok ? 'accent' : 'warn'}>{testOutcomeText(result)}</Chip> : null}
                <Button size="sm" variant="ghost" loading={test.isPending && test.variables === d.id} onClick={() => test.mutate(d.id)}>
                  {t('features.mobile.sendTest')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(d)}>
                  {t('common.remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title={t('features.mobile.removeTitle', { name: removing?.deviceName || (removing ? platformLabel(removing.platform) : '') })}
        confirmLabel={t('common.remove')}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await mobileApi.remove(removing.id);
          setRemoving(null);
          await qc.invalidateQueries({ queryKey: ['mobile', 'devices'] });
        }}
      >
        {t('features.mobile.removeBody')}
      </ConfirmDialog>
    </>
  );
}

export function MobileAppSection({ all = false }: { all?: boolean }) {
  const pairing = useQuery({ queryKey: mobileKeys.pairing, queryFn: mobileApi.pairing, retry: false });
  const [copied, setCopied] = useState(false);
  const serverUrl = pairingServerUrl(pairing.data?.serverUrl);
  const uri = mobilePairingUri(serverUrl);

  return (
    <div className="mobile-app">
      <div className="mobile-app__pair">
        {pairing.isPending ? (
          <Skeleton lines={4} />
        ) : (
          <QrCode value={uri} label={t('features.mobile.qrLabel', { url: serverUrl })} />
        )}
        <div className="mk-stack-sm mobile-app__help">
          <p className="al-body" style={{ margin: 0 }}>
            {t('features.mobile.pairHelp')}
          </p>
          <div className="mobile-app__url">
            <code className="al-num" data-testid="mobile-server-url">
              {serverUrl}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void copyText(serverUrl).then((ok) => {
                  setCopied(ok);
                  if (ok) setTimeout(() => setCopied(false), 2000);
                })
              }
            >
              {copied ? t('features.mobile.copied') : t('common.copy')}
            </Button>
          </div>
          {!pairing.data?.serverUrl && !pairing.isPending ? <p className="al-caption" style={{ margin: 0 }}>{t('features.mobile.originHint')}</p> : null}
          <div className="mobile-app__stores">
            <a href={MOBILE_APP_URL} target="_blank" rel="noopener noreferrer">
              {t('features.mobile.getIos')}
            </a>
            <a href={MOBILE_APP_URL} target="_blank" rel="noopener noreferrer">
              {t('features.mobile.getAndroid')}
            </a>
          </div>
        </div>
      </div>
      {pairing.data && !pairing.data.pushEnabled ? <Banner tone="info">{t('features.mobile.pushDisabled')}</Banner> : null}
      <MobileDeviceList all={all} />
    </div>
  );
}
