import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Icon } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { encodeQr, qrPath } from '@web/lib/qr';
import { useServices } from '../app/context';
import type { Account } from '../core/accounts';
import { startDeviceCodeSignIn, type DeviceCodeFlow, type DeviceCodeState } from '../core/device-code';
import { isTvMode } from './tv-mode';

// "Sign in with a code" (TV first, works on phones too): shows the code, the address to confirm it
// at and a QR code that opens that address with the code filled in; polls until it is confirmed.

function Qr({ value, label }: { value: string; label: string }) {
  const { path, dim } = useMemo(() => {
    const m = encodeQr(value, 'M');
    return { path: qrPath(m, 2), dim: m.size + 4 };
  }, [value]);
  return (
    <div className="tv-code__qr">
      <svg role="img" aria-label={label} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" data-value={value}>
        <rect width={dim} height={dim} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}

/** Where the user confirms the code, without the scheme ("arclight.example.com/player/link"). */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export function DeviceCodeSignIn({ server, onSignedIn, onPassword }: { server: string; onSignedIn: (account: Account) => void; onPassword: () => void }) {
  const t = useT();
  const services = useServices();
  const [state, setState] = useState<DeviceCodeState>({ status: 'starting' });
  const flow = useRef<DeviceCodeFlow | null>(null);
  const done = useRef(onSignedIn);
  done.current = onSignedIn;

  useEffect(() => {
    const f = startDeviceCodeSignIn(services.accounts, server, setState, isTvMode() ? { platform: 'android-tv' } : {});
    flow.current = f;
    return () => f.cancel();
  }, [services, server]);

  useEffect(() => {
    if (state.status === 'approved') done.current(state.account);
  }, [state]);

  return (
    <div className="app-stack">
      {state.status === 'waiting' ? (
        <div className="tv-code">
          <div className="app-stack">
            <ol className="tv-code__steps">
              <li>
                {t('app.tv.code.open')} <span className="tv-code__url">{shortUrl(state.code.verifyUrl)}</span>
              </li>
              <li>{t('app.tv.code.enter')}</li>
            </ol>
            <p className="tv-code__value" aria-label={t('app.tv.code.label')}>
              {state.display}
            </p>
            <p className="tv-code__status" role="status">
              {t('app.tv.code.waiting')}
            </p>
          </div>
          <Qr value={state.qrUrl} label={t('app.tv.code.qr')} />
        </div>
      ) : state.status === 'starting' || state.status === 'approved' ? (
        <p className="tv-code__status" role="status">
          {state.status === 'approved' ? t('app.tv.code.approved') : t('app.tv.code.starting')}
        </p>
      ) : state.status === 'expired' ? (
        <Banner tone="warn">{t('app.tv.code.expired')}</Banner>
      ) : (
        <Banner tone="warn">{t(`app.signIn.error.${state.reason}`, { message: state.message })}</Banner>
      )}
      {state.status === 'expired' || state.status === 'error' ? (
        <Button variant="primary" block data-tv-autofocus icon={<Icon name="refresh" size={20} />} onClick={() => flow.current?.restart()}>
          {t('app.tv.code.newCode')}
        </Button>
      ) : null}
      {/* Always marked: the page's first focus can land while the code is still being fetched. */}
      <Button variant="ghost" block data-tv-autofocus onClick={onPassword}>
        {t('app.signIn.passwordInstead')}
      </Button>
    </div>
  );
}
