import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlexPin } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { t } from '../../i18n/index.js';

// Plex PIN flow: create a PIN, open its authUrl in a popup, then poll until the user approves.
// Shared by the login page (/auth/plex/pin + /auth/plex/poll: signs in) and Profile → Media
// server account (/user/me/mediaserver/plex/pin + poll: links the signed-in user).

export const PLEX_POLL_MS = 2000;
/** Give up after ten minutes; Plex PINs expire long before that. */
export const PLEX_POLL_LIMIT = 300;

export type PlexPinState =
  | { phase: 'idle' }
  | { phase: 'waiting'; pin: PlexPin }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export interface PlexPinFlowOptions<T> {
  createPin: () => Promise<PlexPin>;
  /** Resolves `null` while the PIN is still pending. */
  poll: (pin: PlexPin) => Promise<T | null>;
  onDone: (result: T) => void | Promise<void>;
  intervalMs?: number;
  /** Test seam for the popup. */
  openWindow?: (url: string) => void;
}

function defaultOpen(url: string) {
  window.open(url, 'plex-auth', 'width=600,height=720,noopener=no');
}

/** Drives the PIN flow; polling stops on unmount, cancel, success or failure. */
export function usePlexPinFlow<T>({ createPin, poll, onDone, intervalMs = PLEX_POLL_MS, openWindow = defaultOpen }: PlexPinFlowOptions<T>) {
  const [state, setState] = useState<PlexPinState>({ phase: 'idle' });
  const run = useRef(0);
  const opts = useRef({ createPin, poll, onDone, openWindow, intervalMs });
  opts.current = { createPin, poll, onDone, openWindow, intervalMs };

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const cancel = useCallback(() => {
    run.current += 1;
    setState({ phase: 'idle' });
  }, []);

  const start = useCallback(async () => {
    const id = ++run.current;
    const live = () => run.current === id;
    try {
      const pin = await opts.current.createPin();
      if (!live()) return;
      opts.current.openWindow(pin.authUrl);
      setState({ phase: 'waiting', pin });
      for (let i = 0; i < PLEX_POLL_LIMIT; i++) {
        await new Promise((r) => setTimeout(r, opts.current.intervalMs));
        if (!live()) return;
        const result = await opts.current.poll(pin);
        if (!live()) return;
        if (result !== null) {
          setState({ phase: 'done' });
          await opts.current.onDone(result);
          return;
        }
      }
      setState({ phase: 'error', message: t('features.requests.plexPin.thePlexSignInTimed') });
    } catch (err) {
      if (live()) setState({ phase: 'error', message: errorMessage(err) });
    }
  }, []);

  return { state, start: () => void start(), cancel };
}
