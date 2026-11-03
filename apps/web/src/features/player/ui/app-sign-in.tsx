import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPairCode, type AppDevice } from '@arclight/shared';
import { appAuthApi, appAuthKeys } from '../../../api/app-auth.js';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Modal, Skeleton } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { relativeTime } from '../../../lib/format.js';
import { t } from '../../../i18n/index.js';
import { QrCode } from '../../mobile/mobile-app-section.js';
import '../../mobile/mobile.css';

// "Sign in to the Arclight app" (player account menu): a one-time code as a QR code and as text
// for the standalone player app, a countdown until it expires, and the devices signed in with
// this account. The app scans the code (arclight://pair?server=…&code=…) or takes both by hand.

/** Seconds until `expiresAt`, never below zero, ticking once a second. */
function useSecondsLeft(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : 0;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function platformLabel(p: AppDevice['platform']): string {
  return p === 'ios' ? t('features.mobile.platformIos') : t('features.mobile.platformAndroid');
}

export function AppDeviceList() {
  const qc = useQueryClient();
  // Polled while open, so a phone that just paired shows up here.
  const devices = useQuery({ queryKey: appAuthKeys.devices, queryFn: appAuthApi.devices, retry: false, refetchInterval: 5000 });
  const [removing, setRemoving] = useState<AppDevice | null>(null);

  let body;
  if (devices.isPending) body = <Skeleton lines={2} />;
  else if (devices.isError) {
    body = (
      <ErrorBlock title={t('player.appSignIn.couldNotLoadDevices')} onRetry={() => void devices.refetch()}>
        {errorMessage(devices.error)}
      </ErrorBlock>
    );
  } else if (devices.data.length === 0) {
    body = (
      <p className="al-caption" style={{ margin: 0 }}>
        {t('player.appSignIn.noDevices')}
      </p>
    );
  } else {
    body = (
      <ul className="mobile-devices" aria-label={t('player.appSignIn.devices')}>
        {devices.data.map((d) => (
          <li key={d.id} className="mobile-device">
            <div className="mobile-device__main">
              <strong className="mobile-device__name">{d.name}</strong>
              <span className="al-caption">
                {[platformLabel(d.platform), t('features.mobile.appVersion', { version: d.appVersion }), t('player.appSignIn.lastUsed', { when: relativeTime(d.lastSeenAt) })].join(' · ')}
              </span>
            </div>
            <div className="mobile-device__actions">
              <Button size="sm" variant="ghost" onClick={() => setRemoving(d)}>
                {t('common.remove')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="mk-stack-sm" aria-labelledby="app-devices-title">
      <h3 id="app-devices-title" className="al-label" style={{ margin: 0 }}>
        {t('player.appSignIn.devices')}
      </h3>
      {body}
      <ConfirmDialog
        open={removing !== null}
        title={t('player.appSignIn.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('common.remove')}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await appAuthApi.remove(removing.id);
          setRemoving(null);
          await qc.invalidateQueries({ queryKey: appAuthKeys.devices });
        }}
      >
        {t('player.appSignIn.removeBody')}
      </ConfirmDialog>
    </section>
  );
}

export function AppSignInPanel() {
  const code = useQuery({ queryKey: appAuthKeys.pairCode, queryFn: appAuthApi.pairCode, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false });
  const left = useSecondsLeft(code.data?.expiresAt);
  const expired = code.isSuccess && left === 0;

  return (
    <div className="mk-stack">
      <p className="al-body" style={{ margin: 0 }}>
        {t('player.appSignIn.help')}
      </p>
      {code.isError ? (
        <ErrorBlock title={t('player.appSignIn.couldNotCreate')} onRetry={() => void code.refetch()}>
          {errorMessage(code.error)}
        </ErrorBlock>
      ) : (
        <div className="mobile-app__pair">
          {code.isPending ? (
            <Skeleton lines={4} />
          ) : (
            <div style={expired ? { opacity: 0.25 } : undefined} aria-hidden={expired || undefined}>
              <QrCode value={code.data.qr} label={t('player.appSignIn.qrLabel', { url: code.data.serverUrl })} size={180} />
            </div>
          )}
          {code.data ? (
            <dl className="mk-stack-sm mobile-app__help" style={{ margin: 0 }}>
              <div>
                <dt className="al-caption">{t('player.appSignIn.server')}</dt>
                <dd style={{ margin: 0 }}>
                  <code className="al-num" data-testid="app-server-url">
                    {code.data.serverUrl}
                  </code>
                </dd>
              </div>
              <div>
                <dt className="al-caption">{t('player.appSignIn.code')}</dt>
                <dd style={{ margin: 0 }}>
                  <code className="al-num" data-testid="app-pair-code" style={{ fontSize: '1.5em', letterSpacing: '0.08em' }}>
                    {formatPairCode(code.data.code)}
                  </code>
                </dd>
              </div>
              <p className="al-caption" role="status" aria-live="polite" style={{ margin: 0 }} data-testid="app-pair-countdown">
                {expired ? t('player.appSignIn.expired') : t('player.appSignIn.expiresIn', { time: mmss(left) })}
              </p>
              <div>
                <Button size="sm" variant={expired ? 'primary' : 'ghost'} loading={code.isFetching} onClick={() => void code.refetch()}>
                  {t('player.appSignIn.newCode')}
                </Button>
              </div>
            </dl>
          ) : null}
        </div>
      )}
      <AppDeviceList />
    </div>
  );
}

export function AppSignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={t('player.appSignIn.title')} size={560}>
      {open ? <AppSignInPanel /> : null}
    </Modal>
  );
}
