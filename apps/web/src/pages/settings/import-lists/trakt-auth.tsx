import { useEffect, useRef, useState } from 'react';
import { SECRET_MASK, type TraktDeviceResponse, type TraktPollResponse } from '@media-tron/shared';
import { importListsApi } from '../../../api/import-lists.js';
import { errorMessage } from '../../../api/client.js';
import { Button } from '../../../components/button.js';

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
  denied: 'Authorization was denied on Trakt.',
  expired: 'The code expired before it was entered. Try again.',
  invalid: 'Trakt rejected the device code. Check the client id and secret.',
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
      setState({ phase: 'failed', message: 'Enter the Trakt client id first.' });
      return;
    }
    if (!secret && !canUseStored) {
      setState({ phase: 'failed', message: 'Enter the Trakt client secret first.' });
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
        setState({ phase: 'failed', message: FAILURES[res.status] ?? `Trakt answered ${res.status}.` });
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
    <div className="trakt-auth" aria-label="Trakt authentication" role="group">
      {state.phase === 'waiting' ? (
        <div className="notice" role="status">
          <p>
            Go to{' '}
            <a href={state.device.verificationUrl} target="_blank" rel="noreferrer">
              {state.device.verificationUrl}
            </a>{' '}
            and enter the code <strong data-testid="trakt-user-code">{state.device.userCode}</strong>.
          </p>
          <p className="muted">Waiting for authorization…</p>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button loading={state.phase === 'starting'} onClick={() => void start()}>
          {state.phase === 'authorized' ? 'Re-authenticate with Trakt' : 'Authenticate with Trakt'}
        </Button>
      )}
      {state.phase === 'authorized' ? (
        <p className="muted" role="status">
          Authorized with Trakt. Save the list to keep the tokens.
        </p>
      ) : null}
      {state.phase === 'failed' ? (
        <p className="inline-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
