import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { ApiError, errorMessage } from '../../api/client.js';
import { t } from '../../i18n/index.js';

// Passkeys (WebAuthn) through @simplewebauthn/browser. The api hands out the options JSON
// (PasskeyOptions.options) and verifies the answer; this file only runs the browser ceremony.

/** The browser can create and use passkeys (window.PublicKeyCredential exists). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === 'function';
}

/** Ask the authenticator to sign in (options from POST /auth/passkey/options). */
export function passkeyAssertion(options: Record<string, unknown>): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
}

/** Ask the authenticator to create a passkey (options from POST /user/me/passkeys/options). */
export function passkeyAttestation(options: Record<string, unknown>): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
}

/** Message for a failed passkey ceremony: cancelled in the browser, refused by the api, or other. */
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'CHALLENGE_EXPIRED') return t('identity.passkey.expired');
    if (err.status === 401) return t('identity.passkey.notAccepted');
    if (err.status === 429) return t('login.tooManyFailedAttemptsWait');
    return errorMessage(err);
  }
  const name = err instanceof Error ? err.name : '';
  const code = (err as { code?: unknown } | null)?.code;
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return t('identity.passkey.cancelled');
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return t('identity.passkey.alreadyRegistered');
  return t('identity.passkey.failed');
}
