import {
  ApiKeyResponse,
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

export const authApi = {
  status: () => request('/auth/status', AuthStatus),
  me: () => request('/auth/me', Session),
  login: (body: LoginRequest) => request('/auth/login', Session, { method: 'POST', json: body }),
  logout: () => request('/auth/logout', null, { method: 'POST' }),
  sessions: () => request('/auth/sessions', SessionRecord.array()),
  revokeSession: (id: number) => request(`/auth/sessions/${id}`, null, { method: 'DELETE' }),
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
