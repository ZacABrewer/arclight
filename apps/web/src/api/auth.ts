import { z } from 'zod';
import {
  ApiKeyResponse,
  MediaServerKind,
  PlexPin,
  PlexPollPending,
  type PlexPollRequest,
  AuthStatus,
  RootFolder,
  SecuritySettingsResponse,
  Session,
  SessionRecord,
  SetupStatus,
  User,
  type AuthSettings,
  type LoginRequest,
  type PasswordChange,
  type SetupAdminRequest,
  type SetupRequest,
  type SetupRootFolderRequest,
  type UserCreate,
  type UserSelfUpdate,
  type UserUpdate,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/auth/routes.ts.

/**
 * /auth/status as the login page reads it. TODO(contract): `AuthStatus` does not yet say
 * whether media-server sign-in is on; the page reads an optional `mediaServerLogin`
 * `{kind, name?}` (null/absent = local sign-in only) until the shared contract carries it.
 */
export const LoginOptions = AuthStatus.extend({
  mediaServerLogin: z.object({ kind: MediaServerKind, name: z.string().optional() }).nullish(),
});
export type LoginOptions = z.infer<typeof LoginOptions>;

/** POST /auth/plex/poll answers 202 `{pending: true}` until the PIN is approved. */
export const PlexPollResponse = z.union([PlexPollPending, Session]);
export type PlexPollResponse = z.infer<typeof PlexPollResponse>;

export const authApi = {
  status: () => request('/auth/status', AuthStatus),
  me: () => request('/auth/me', Session),
  login: (body: LoginRequest) => request('/auth/login', Session, { method: 'POST', json: body }),
  logout: () => request('/auth/logout', null, { method: 'POST' }),
  sessions: () => request('/auth/sessions', SessionRecord.array()),
  revokeSession: (id: number) => request(`/auth/sessions/${id}`, null, { method: 'DELETE' }),
  loginOptions: () => request('/auth/status', LoginOptions),
  plexPin: () => request('/auth/plex/pin', PlexPin, { method: 'POST', json: {} }),
  plexPoll: (body: PlexPollRequest) => request('/auth/plex/poll', PlexPollResponse, { method: 'POST', json: body }),
};

export const usersApi = {
  list: () => request('/user', User.array()),
  create: (body: UserCreate) => request('/user', User, { method: 'POST', json: body }),
  update: (id: number, body: UserUpdate) => request(`/user/${id}`, User, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/user/${id}`, null, { method: 'DELETE' }),
  me: () => request('/user/me', User),
  updateMe: (body: UserSelfUpdate) => request('/user/me', User, { method: 'PUT', json: body }),
  changePassword: (body: PasswordChange) => request('/user/me/password', null, { method: 'PUT', json: body }),
};

export const securityApi = {
  get: () => request('/settings/security', SecuritySettingsResponse),
  update: (body: AuthSettings) => request('/settings/security', SecuritySettingsResponse, { method: 'PUT', json: body }),
  regenerateApiKey: () => request('/settings/security/apikey', ApiKeyResponse, { method: 'POST' }),
};

export const setupApi = {
  status: () => request('/setup/status', SetupStatus),
  createAdmin: (body: SetupAdminRequest) => request('/setup/admin', Session, { method: 'POST', json: body }),
  addRootFolder: (body: SetupRootFolderRequest) => request('/setup/rootfolder', RootFolder, { method: 'POST', json: body }),
  complete: (body: SetupRequest) => request('/setup/complete', SetupStatus, { method: 'POST', json: body }),
};
