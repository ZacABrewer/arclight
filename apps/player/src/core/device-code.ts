import { formatPairCode, type AppDeviceCode, type AppDeviceCodePollResponse, type AppDeviceCodeRequest } from '@arclight/shared';
import type { Account, AccountStore } from './accounts';
import { ApiError, appApi, type AppDeviceInfo } from './api';
import { deviceInfo, remember, signInFailure, type SignInFailure } from './sign-in';

// TV sign-in with a code (no typing a password with a remote): the TV asks the server for a code,
// shows it with the address to confirm it at (and a QR code of that address with the code filled
// in), and polls until someone signed in on a phone or computer confirms it on /player/link. The
// poll then carries the device token, stored like any other sign-in. A code lives ten minutes;
// an expired one is replaced by a fresh one on its own a few times before the screen asks.

export type DeviceCodeState =
  | { status: 'starting' }
  | { status: 'waiting'; code: AppDeviceCode; display: string; qrUrl: string }
  | { status: 'expired' }
  | { status: 'approved'; account: Account }
  | { status: 'error'; reason: SignInFailure; message: string };

export interface DeviceCodeApi {
  create: (serverUrl: string, body: AppDeviceCodeRequest) => Promise<AppDeviceCode>;
  poll: (serverUrl: string, pollToken: string) => Promise<AppDeviceCodePollResponse>;
}

export interface DeviceCodeOptions {
  /** 'android-tv' on a TV. */
  platform?: AppDeviceCodeRequest['platform'];
  api?: DeviceCodeApi;
  device?: AppDeviceInfo;
  /** How many expired codes are replaced automatically before giving up. */
  maxRenewals?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** `verifyUrl?code=ABCD-EFGH`: what the QR code opens (the link page fills the code in). */
export function verifyLink(verifyUrl: string, userCode: string): string {
  const code = formatPairCode(userCode);
  try {
    const u = new URL(verifyUrl);
    u.searchParams.set('code', code);
    return u.toString();
  } catch {
    return `${verifyUrl}${verifyUrl.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
  }
}

/** Slowest poll interval after "too many requests" answers. */
const MAX_INTERVAL_MS = 30_000;

export interface DeviceCodeFlow {
  /** Stop polling (screen left). */
  cancel(): void;
  /** Ask for a new code (after it expired, or the "new code" button). */
  restart(): void;
}

/** Runs the device-code sign-in; `onState` gets every step. */
export function startDeviceCodeSignIn(store: AccountStore, serverUrl: string, onState: (s: DeviceCodeState) => void, opts: DeviceCodeOptions = {}): DeviceCodeFlow {
  const api: DeviceCodeApi = opts.api ?? { create: appApi.deviceCode, poll: appApi.deviceCodePoll };
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const maxRenewals = opts.maxRenewals ?? 5;
  let timer: unknown = null;
  let generation = 0;
  let renewals = 0;
  let done = false;

  const schedule = (fn: () => void, ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      fn();
    }, ms);
  };

  const begin = async () => {
    const gen = ++generation;
    onState({ status: 'starting' });
    let code: AppDeviceCode;
    try {
      const info = opts.device ?? (await deviceInfo());
      code = await api.create(serverUrl, {
        deviceName: info.deviceName,
        platform: opts.platform ?? info.platform,
        appVersion: info.appVersion,
        serverUrl,
      });
    } catch (err) {
      if (gen === generation && !done) onState({ status: 'error', ...signInFailure(err) });
      return;
    }
    if (gen !== generation || done) return;
    onState({ status: 'waiting', code, display: formatPairCode(code.userCode), qrUrl: verifyLink(code.verifyUrl, code.userCode) });
    let interval = Math.max(2, code.intervalSec || 5) * 1000;
    const expiresAt = Date.parse(code.expiresAt) || now() + 10 * 60_000;

    const expired = () => {
      if (renewals < maxRenewals) {
        renewals += 1;
        void begin();
      } else onState({ status: 'expired' });
    };

    const tick = async () => {
      if (gen !== generation || done) return;
      if (now() >= expiresAt) return expired();
      let res: AppDeviceCodePollResponse;
      try {
        res = await api.poll(serverUrl, code.pollToken);
      } catch (err) {
        if (gen !== generation || done) return;
        if (err instanceof ApiError && err.status === 429) interval = Math.min(MAX_INTERVAL_MS, interval + 5000);
        else if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return expired();
        else if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
          onState({ status: 'error', ...signInFailure(err) });
          return;
        }
        // Network trouble or a server hiccup: keep trying.
        schedule(() => void tick(), interval);
        return;
      }
      if (gen !== generation || done) return;
      if (res.status === 'pending') {
        schedule(() => void tick(), interval);
        return;
      }
      if (res.status === 'expired') return expired();
      done = true;
      const { status: _status, ...signIn } = res;
      try {
        const account = await remember(store, serverUrl, signIn, 'device-code');
        onState({ status: 'approved', account });
      } catch (err) {
        done = false; // "New code" may try again
        onState({ status: 'error', ...signInFailure(err) });
      }
    };
    schedule(() => void tick(), interval);
  };

  void begin();
  return {
    cancel() {
      done = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    restart() {
      if (done) return;
      renewals = 0;
      void begin();
    },
  };
}
