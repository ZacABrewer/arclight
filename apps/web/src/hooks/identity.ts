import { useQuery } from '@tanstack/react-query';
import { identityAdminApi, myIdentityApi } from '../api/identity.js';

// Query keys and reads for sign-in hardening. Everything sits under ['auth'] so signing in or
// out (which invalidates / clears authKeys.all) refreshes it.
export const identityKeys = {
  twoFactor: ['auth', 'me', '2fa'] as const,
  passkeys: ['auth', 'me', 'passkeys'] as const,
  identities: ['auth', 'me', 'identities'] as const,
  apiKeys: ['auth', 'me', 'apikeys'] as const,
  settings: ['auth', 'identity-settings'] as const,
  allApiKeys: ['auth', 'apikeys'] as const,
  userTwoFactor: (userId: number) => ['auth', 'users', userId, '2fa'] as const,
  userIdentities: (userId: number) => ['auth', 'users', userId, 'identities'] as const,
};

export function useMyTwoFactor() {
  return useQuery({ queryKey: identityKeys.twoFactor, queryFn: myIdentityApi.twoFactor, retry: false });
}

export function useMyPasskeys() {
  return useQuery({ queryKey: identityKeys.passkeys, queryFn: myIdentityApi.passkeys, retry: false });
}

export function useMyIdentities(enabled = true) {
  return useQuery({ queryKey: identityKeys.identities, queryFn: myIdentityApi.identities, retry: false, enabled });
}

export function useMyApiKeys(enabled = true) {
  return useQuery({ queryKey: identityKeys.apiKeys, queryFn: myIdentityApi.apiKeys, retry: false, enabled });
}

export function useIdentitySettings() {
  return useQuery({ queryKey: identityKeys.settings, queryFn: identityAdminApi.settings });
}

export function useAllApiKeys() {
  return useQuery({ queryKey: identityKeys.allApiKeys, queryFn: identityAdminApi.apiKeys });
}

export function useUserTwoFactor(userId: number) {
  return useQuery({ queryKey: identityKeys.userTwoFactor(userId), queryFn: () => identityAdminApi.userTwoFactor(userId), retry: false });
}

export function useUserIdentities(userId: number) {
  return useQuery({ queryKey: identityKeys.userIdentities(userId), queryFn: () => identityAdminApi.userIdentities(userId), retry: false });
}
