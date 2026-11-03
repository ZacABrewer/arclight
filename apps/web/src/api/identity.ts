import { z } from 'zod';
import {
  IdentitySettingsResponse,
  LinkedIdentity,
  OidcLinkStart,
  OidcTestResult,
  PasskeyOptions,
  PasskeyRecord,
  RecoveryCodes,
  Session,
  TotpSetup,
  TwoFactorStatus,
  UserApiKey,
  UserApiKeyAdminRecord,
  UserApiKeyCreated,
  type IdentitySettings,
  type PasskeyLogin,
  type PasskeyRegister,
  type TwoFactorLogin,
  type TwoFactorProof,
  type UserApiKeyCreate,
} from '@arclight/shared';
import { withBase } from '../lib/base-path.js';
import { request } from './client.js';

// Sign-in hardening: identity providers (OpenID Connect), two-factor, passkeys and per-user
// API keys. Paths mirror apps/api/src/modules/auth/. Behaviour: docs/using/single-sign-on.md.

/**
 * Where the browser goes to sign in with provider `id` (a full page load: the api answers with
 * a redirect to the provider). `returnTo` is an app path such as "/portal" or "/".
 */
export function oidcStartHref(id: string, returnTo: string, rememberMe = true): string {
  const qs = new URLSearchParams({ returnTo, rememberMe: String(rememberMe) });
  return withBase(`/api/v1/auth/oidc/${encodeURIComponent(id)}/start?${qs.toString()}`);
}

/** Second step of a password sign-in, and passwordless passkey sign-in. */
export const loginApi = {
  twoFactor: (body: TwoFactorLogin) => request('/auth/login/2fa', Session, { method: 'POST', json: body }),
  passkeyOptions: (challenge?: string) =>
    request('/auth/passkey/options', PasskeyOptions, { method: 'POST', json: challenge ? { challenge } : {} }),
  passkeyLogin: (body: PasskeyLogin) => request('/auth/passkey/login', Session, { method: 'POST', json: body }),
};

/** The signed-in user's own second factors, passkeys, linked sign-ins and API keys. */
export const myIdentityApi = {
  twoFactor: () => request('/user/me/2fa', TwoFactorStatus),
  /** `currentPassword`: the re-authentication of an older session (ReauthRequest). */
  totpSetup: (currentPassword?: string) => request('/user/me/2fa/totp/setup', TotpSetup, { method: 'POST', json: currentPassword ? { currentPassword } : {} }),
  totpEnable: (code: string) => request('/user/me/2fa/totp/enable', RecoveryCodes, { method: 'POST', json: { code } }),
  totpDisable: (proof: TwoFactorProof) => request('/user/me/2fa/totp', null, { method: 'DELETE', json: proof }),
  regenerateRecovery: (proof: TwoFactorProof) => request('/user/me/2fa/recovery', RecoveryCodes, { method: 'POST', json: proof }),

  passkeys: () => request('/user/me/passkeys', PasskeyRecord.array()),
  passkeyOptions: (currentPassword?: string) => request('/user/me/passkeys/options', PasskeyOptions, { method: 'POST', json: currentPassword ? { currentPassword } : {} }),
  addPasskey: (body: PasskeyRegister) => request('/user/me/passkeys', PasskeyRecord, { method: 'POST', json: body }),
  renamePasskey: (id: number, name: string) => request(`/user/me/passkeys/${id}`, z.unknown(), { method: 'PUT', json: { name } }),
  removePasskey: (id: number) => request(`/user/me/passkeys/${id}`, null, { method: 'DELETE' }),

  identities: () => request('/user/me/identities', LinkedIdentity.array()),
  /** Starts linking provider `id`; the caller sends the browser to the returned url. */
  linkStart: (id: string, returnTo: string) =>
    request(`/auth/oidc/${encodeURIComponent(id)}/link`, OidcLinkStart, { method: 'POST', json: { returnTo } }),
  unlink: (identityId: number) => request(`/user/me/identities/${identityId}`, null, { method: 'DELETE' }),

  apiKeys: () => request('/user/me/apikeys', UserApiKey.array()),
  createApiKey: (body: UserApiKeyCreate) => request('/user/me/apikeys', UserApiKeyCreated, { method: 'POST', json: body }),
  revokeApiKey: (id: number) => request(`/user/me/apikeys/${id}`, null, { method: 'DELETE' }),
};

/** Admin: Settings > Security identity section, other users' factors and links, every API key. */
export const identityAdminApi = {
  settings: () => request('/settings/identity', IdentitySettingsResponse),
  updateSettings: (body: IdentitySettings) => request('/settings/identity', IdentitySettingsResponse, { method: 'PUT', json: body }),
  testProvider: (issuer: string) => request('/settings/identity/test', OidcTestResult, { method: 'POST', json: { issuer } }),

  userTwoFactor: (userId: number) => request(`/user/${userId}/2fa`, TwoFactorStatus),
  resetUserTwoFactor: (userId: number) => request(`/user/${userId}/2fa`, null, { method: 'DELETE' }),
  userIdentities: (userId: number) => request(`/user/${userId}/identities`, LinkedIdentity.array()),
  unlinkUserIdentity: (userId: number, identityId: number) => request(`/user/${userId}/identities/${identityId}`, null, { method: 'DELETE' }),

  apiKeys: () => request('/apikeys', UserApiKeyAdminRecord.array()),
  revokeApiKey: (id: number) => request(`/apikeys/${id}`, null, { method: 'DELETE' }),
};
