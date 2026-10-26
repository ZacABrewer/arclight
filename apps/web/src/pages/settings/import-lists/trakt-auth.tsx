import { useEffect, useRef, useState } from 'react';
import { SECRET_MASK, type TraktDeviceResponse, type TraktPollResponse } from '@arclight/shared';
import { importListsApi } from '../../../api/import-lists.js';
import { errorMessage } from '../../../api/client.js';
import { Button } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// Trakt device-code flow: ask the api for a device code, show the user code and verification
// URL, then poll at the interval Trakt gave until it is authorized, denied or expired.

export interface TraktAuthProps {
  clientId: string;
  clientSecret: string | undefined;
  /** Saved list being edited: lets the api reuse its stored client secret. */
  importListId?: number | undefined;
  onAuthorized: (result: TraktPollResponse) => void;
}

type State =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; device: TraktDeviceResponse }
  | { phase: 'authorized' }
  | { phase: 'failed'; message: string };

const FAILURES: Record<string, string> = {
  get denied() {
    return t('settings.importLists.traktAuth.authorizationWasDeniedOnTrakt');
  },
  get expired() {
    return t('settings.importLists.traktAuth.theCodeExpiredBeforeIt');
  },
  get invalid() {
    return t('settings.importLists.traktAuth.traktRejectedTheDeviceCode');
  },
};

export function TraktAuth({ clientId, clientSecret, importListId, onAuthorized }: TraktAuthProps) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const latest = useRef(onAuthorized);
  latest.current = onAuthorized;

  useEffect(
    () => () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const secret = clientSecret && clientSecret !== SECRET_MASK ? clientSecret : undefined;
  const canUseStored = importListId !== undefined;

  const start = async () => {
    if (!clientId.trim()) {
      setState({ phase: 'failed', message: t('settings.importLists.traktAuth.enterTheTraktClientId') });
      return;
    }
    if (!secret && !canUseStored) {
      setState({ phase: 'failed', message: t('settings.importLists.traktAuth.enterTheTraktClientSecret') });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setState({ phase: 'starting' });
    let device: TraktDeviceResponse;
    try {
      device = await importListsApi.traktDevice(clientId.trim());
    } catch (err) {
      setState({ phase: 'failed', message: errorMessage(err) });
      return;
    }
    if (cancelled.current) return;
    setState({ phase: 'waiting', device });
    const deadline = Date.now() + device.expiresIn * 1000;
    let interval = Math.max(1, device.interval) * 1000;

    const poll = async () => {
      if (cancelled.current) return;
      if (Date.now() > deadline) {
        setState({ phase: 'failed', message: FAILURES.expired! });
        return;
      }
      try {
        const res = await importListsApi.traktPoll({
          deviceCode: device.deviceCode,
          clientId: clientId.trim(),
          ...(secret ? { clientSecret: secret } : {}),
          // Without a secret in the form the api needs the saved list to find the stored one.
          ...(!secret && importListId !== undefined ? { importListId } : {}),
        });
        if (cancelled.current) return;
        if (res.status === 'authorized') {
          setState({ phase: 'authorized' });
          latest.current(res);
          return;
        }
        if (res.status === 'pending' || res.status === 'slowDown') {
          if (res.status === 'slowDown') interval += 5000;
          timer.current = setTimeout(() => void poll(), interval);
          return;
        }
        setState({ phase: 'failed', message: FAILURES[res.status] ?? t('settings.importLists.traktAuth.traktAnsweredStatus', { status: res.status }) });
      } catch (err) {
        if (!cancelled.current) setState({ phase: 'failed', message: errorMessage(err) });
      }
    };
    timer.current = setTimeout(() => void poll(), interval);
  };

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    setState({ phase: 'idle' });
  };

  return (
    <div className="al-trakt" aria-label={t('settings.importLists.traktAuth.traktAuthentication')} role="group">
      {state.phase === 'waiting' ? (
        <>
          <p className="al-trakt__step">
            {t('common.open')}
            <a className="al-trakt__url" href={state.device.verificationUrl} target="_blank" rel="noreferrer">
              {state.device.verificationUrl}
            </a>{' '}
            and enter this code:
          </p>
          <div className="al-trakt__code" data-testid="trakt-user-code" aria-label={t('settings.importLists.traktAuth.traktUserCode')}>
            {state.device.userCode}
          </div>
          <p className="al-trakt__status" role="status">
            {t('settings.importLists.traktAuth.waitingForTraktToConfirm')} <span className="al-num">{t('settings.importLists.traktAuth.valueS', { value: Math.max(1, state.device.interval) })}</span>.
          </p>
          <div className="al-trakt__actions">
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <div className="al-trakt__actions">
          <Button variant="secondary" loading={state.phase === 'starting'} onClick={() => void start()}>
            {state.phase === 'authorized' ? t('settings.importLists.traktAuth.reAuthenticateWithTrakt') : t('settings.importLists.traktAuth.authenticateWithTrakt')}
          </Button>
        </div>
      )}
      {state.phase === 'authorized' ? (
        <p className="al-trakt__status" role="status">
          {t('settings.importLists.traktAuth.authorizedWithTraktSaveThe')}
        </p>
      ) : null}
      {state.phase === 'failed' ? (
        <p className="al-inline-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
