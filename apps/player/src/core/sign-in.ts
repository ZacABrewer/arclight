import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { APP_VERSION } from '../config';
import { ApiError, appApi, resetArtworkLink, SIGN_IN_ERRORS, type AppDeviceInfo, type AppSignInResponse } from './api';
import type { Account, AccountStore } from './accounts';
import { normalisePairCode, PAIR_CODE_PATTERN } from './qr';
import { getSession } from './session';

// Sign-in and pairing: both end with a device token stored for a new (or refreshed) account,
// which then becomes the active session.

export async function deviceInfo(): Promise<AppDeviceInfo> {
  let name = '';
  let model = '';
  try {
    const info = await Device.getInfo();
    name = info.name ?? '';
    model = info.model ?? '';
  } catch {
    /* web without the plugin */
  }
  const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  const deviceName = (name || model || (platform === 'ios' ? 'iPhone' : 'Android')).slice(0, 100);
  return { deviceName, platform, appVersion: APP_VERSION };
}

export type SignInOutcome = { ok: true; account: Account } | { ok: false; reason: SignInFailure; message: string };

export type SignInFailure =
  | 'totp-required'
  | 'totp-invalid'
  | 'credentials'
  | 'rate-limited'
  | 'pair-invalid'
  | 'pair-expired'
  | 'player-disabled'
  | 'player-not-allowed'
  | 'pairing-required'
  | 'two-factor-setup'
  | 'network'
  | 'unknown';

/** Maps an API error to what the sign-in screens show (`message` is the server's, for "unknown"). */
export function signInFailure(err: unknown): { reason: SignInFailure; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ApiError)) return { reason: 'unknown', message };
  if (err.status === 0) return { reason: 'network', message };
  switch (err.code) {
    case SIGN_IN_ERRORS.totpRequired:
      return { reason: 'totp-required', message };
    case SIGN_IN_ERRORS.invalidTotp:
      return { reason: 'totp-invalid', message };
    case SIGN_IN_ERRORS.invalidCredentials:
      return { reason: 'credentials', message };
    case SIGN_IN_ERRORS.rateLimited:
      return { reason: 'rate-limited', message };
    case SIGN_IN_ERRORS.pairInvalid:
      return { reason: 'pair-invalid', message };
    case SIGN_IN_ERRORS.pairExpired:
      return { reason: 'pair-expired', message };
    case SIGN_IN_ERRORS.playerDisabled:
      return { reason: 'player-disabled', message };
    case SIGN_IN_ERRORS.playerNotAllowed:
      return { reason: 'player-not-allowed', message };
    case SIGN_IN_ERRORS.pairingRequired:
      return { reason: 'pairing-required', message };
    case SIGN_IN_ERRORS.twoFactorSetupRequired:
      return { reason: 'two-factor-setup', message };
  }
  if (err.status === 429) return { reason: 'rate-limited', message };
  if (err.status === 401) return { reason: 'credentials', message };
  return { reason: 'unknown', message };
}

export async function remember(store: AccountStore, serverUrl: string, res: AppSignInResponse, method: Account['method']): Promise<Account> {
  const account = await store.add({ serverUrl, token: res.token, deviceId: res.deviceId, user: res.user, server: res.server, method });
  resetArtworkLink();
  await store.activate();
  return account;
}

export interface PasswordSignIn {
  serverUrl: string;
  username: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
}

export async function signInWithPassword(store: AccountStore, input: PasswordSignIn, device?: AppDeviceInfo): Promise<SignInOutcome> {
  try {
    const info = device ?? (await deviceInfo());
    const totp = input.totp?.replace(/\s+/g, '');
    const res = await appApi.signIn(input.serverUrl, {
      ...info,
      username: input.username.trim(),
      password: input.password,
      ...(totp ? { totp } : {}),
      ...(input.recoveryCode?.trim() ? { recoveryCode: input.recoveryCode.trim() } : {}),
    });
    return { ok: true, account: await remember(store, input.serverUrl, res, 'password') };
  } catch (err) {
    return { ok: false, ...signInFailure(err) };
  }
}

export async function signInWithPairCode(store: AccountStore, serverUrl: string, rawCode: string, device?: AppDeviceInfo): Promise<SignInOutcome> {
  const code = normalisePairCode(rawCode);
  if (!PAIR_CODE_PATTERN.test(code)) return { ok: false, reason: 'pair-invalid', message: 'Not a pair code' };
  try {
    const info = device ?? (await deviceInfo());
    const res = await appApi.pair(serverUrl, { ...info, code });
    return { ok: true, account: await remember(store, serverUrl, res, 'pairing') };
  } catch (err) {
    return { ok: false, ...signInFailure(err) };
  }
}

/**
 * Signs an account out: ends its token on the server (best effort: offline or an already-removed
 * device still forgets it locally), then removes it and activates the next one, if any.
 */
export async function signOut(store: AccountStore, accountId: string): Promise<void> {
  const account = store.list().find((a) => a.id === accountId);
  if (!account) return;
  const token = await store.token(accountId);
  if (token) {
    try {
      await appApi.signOut({ serverUrl: account.serverUrl, token });
    } catch {
      /* forget it locally anyway */
    }
  }
  const wasActive = getSession()?.accountId === accountId;
  await store.remove(accountId);
  if (wasActive) {
    resetArtworkLink();
    await store.activate();
  }
}
