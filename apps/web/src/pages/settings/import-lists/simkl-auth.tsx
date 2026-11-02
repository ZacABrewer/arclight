import { useEffect, useRef, useState } from 'react';
import type { SimklPinResponse, SimklPollResponse } from '@arclight/shared';
import { importListsApi } from '../../../api/import-lists.js';
import { errorMessage } from '../../../api/client.js';
import { Button } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// Simkl PIN flow: get a code from the api, show it with the verification URL, then poll at the
// interval Simkl gave until it is authorized or the code expires. Styled like the Trakt flow.

export interface SimklAuthProps {
  clientId: string;
  /** Saved list being edited: the token is stored on it straight away. */
  importListId?: number | undefined;
  onAuthorized: (result: SimklPollResponse) => void;
}

type State =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; pin: SimklPinResponse }
  | { phase: 'authorized' }
  | { phase: 'failed'; message: string };

export function SimklAuth({ clientId, importListId, onAuthorized }: SimklAuthProps) {
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

  const start = async () => {
    const id = clientId.trim();
    if (!id) {
      setState({ phase: 'failed', message: t('settings.importLists.simklAuth.enterClientId') });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setState({ phase: 'starting' });
    let pin: SimklPinResponse;
    try {
      pin = await importListsApi.simklPin(id);
    } catch (err) {
      setState({ phase: 'failed', message: errorMessage(err) });
      return;
    }
    if (cancelled.current) return;
    setState({ phase: 'waiting', pin });
    const deadline = Date.now() + pin.expiresIn * 1000;
    const interval = Math.max(1, pin.interval) * 1000;

    const poll = async () => {
      if (cancelled.current) return;
      if (Date.now() > deadline) {
        setState({ phase: 'failed', message: t('settings.importLists.simklAuth.expired') });
        return;
      }
      try {
        const res = await importListsApi.simklPoll({ userCode: pin.userCode, clientId: id, ...(importListId !== undefined ? { importListId } : {}) });
        if (cancelled.current) return;
        if (res.status === 'authorized') {
          setState({ phase: 'authorized' });
          latest.current(res);
          return;
        }
        if (res.status === 'pending') {
          timer.current = setTimeout(() => void poll(), interval);
          return;
        }
        setState({ phase: 'failed', message: t('settings.importLists.simklAuth.expired') });
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
    <div className="al-trakt" aria-label={t('settings.importLists.simklAuth.title')} role="group">
      {state.phase === 'waiting' ? (
        <>
          <p className="al-trakt__step">
            {t('settings.importLists.simklAuth.openAndEnter')}{' '}
            <a className="al-trakt__url" href={state.pin.verificationUrl} target="_blank" rel="noreferrer">
              {state.pin.verificationUrl}
            </a>
          </p>
          <div className="al-trakt__code" data-testid="simkl-user-code" aria-label={t('settings.importLists.simklAuth.code')}>
            {state.pin.userCode}
          </div>
          <p className="al-trakt__status" role="status">
            {t('settings.importLists.simklAuth.waiting')}
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
            {state.phase === 'authorized' ? t('settings.importLists.simklAuth.reauthenticate') : t('settings.importLists.simklAuth.authenticate')}
          </Button>
        </div>
      )}
      {state.phase === 'authorized' ? (
        <p className="al-trakt__status" role="status">
          {t('settings.importLists.simklAuth.authorized')}
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
