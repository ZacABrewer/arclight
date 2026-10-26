import {
  MediaServerAccountResource,
  MediaServerImportResult,
  MediaServerProbeResult,
  MediaServerResource,
  MediaServerSettings,
  MediaServerTestResult,
  MediaServerUser,
  PlexPin,
  PlexPollPending,
  UserRequestSettings,
  type MediaServerImportRequest,
  type MediaServerInputRaw,
  type MediaServerLinkRequest,
} from '@arclight/shared';
import { z } from 'zod';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/media-servers/routes.ts (the server list) and the
// requests module's single sign-in server, user links and user import (docs/API.md).

export type MediaServerTestBody = MediaServerInputRaw & { id?: string };

export const mediaServersApi = {
  list: () => request('/mediaserver', MediaServerResource.array()),
  get: (id: string) => request(`/mediaserver/${encodeURIComponent(id)}`, MediaServerResource),
  create: (body: MediaServerInputRaw) => request('/mediaserver', MediaServerResource, { method: 'POST', json: body }),
  update: (id: string, body: MediaServerInputRaw) => request(`/mediaserver/${encodeURIComponent(id)}`, MediaServerResource, { method: 'PUT', json: body }),
  remove: (id: string) => request(`/mediaserver/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
  test: (body: MediaServerTestBody) => request('/mediaserver/test', MediaServerProbeResult, { method: 'POST', json: body }),
  testSaved: (id: string) => request(`/mediaserver/${encodeURIComponent(id)}/test`, MediaServerProbeResult, { method: 'POST', json: {} }),
  users: (id: string) => request(`/mediaserver/${encodeURIComponent(id)}/users`, MediaServerAccountResource.array()),
};

/** The single `mediaServer` section (sign-in server) and the user import it feeds. */
export const signInServerApi = {
  get: () => request('/settings/mediaserver', MediaServerSettings),
  update: (body: MediaServerSettings) => request('/settings/mediaserver', MediaServerSettings, { method: 'PUT', json: body }),
  test: (body?: MediaServerSettings) => request('/settings/mediaserver/test', MediaServerTestResult, { method: 'POST', json: body ?? {} }),
  importable: () => request('/user/import/mediaserver', MediaServerUser.array()),
  importUsers: (body: MediaServerImportRequest) => request('/user/import/mediaserver', MediaServerImportResult, { method: 'POST', json: body }),
};

export const mediaServerLinkApi = {
  link: (userId: number, body: MediaServerLinkRequest) => request(`/user/${userId}/mediaserver/link`, UserRequestSettings, { method: 'POST', json: body }),
  unlink: (userId: number) => request(`/user/${userId}/mediaserver/link`, UserRequestSettings, { method: 'DELETE' }),
  /** Start a Plex PIN that links the signed-in user's Plex account (no new session). */
  plexPin: () => request('/user/me/mediaserver/plex/pin', PlexPin, { method: 'POST', json: {} }),
  /** 202 `{pending: true}` until the PIN is approved, then the caller's settings with the link. */
  plexPoll: (id: number) => request('/user/me/mediaserver/plex/poll', PlexLinkPollResponse, { method: 'POST', json: { id } }),
};

/** POST /user/me/mediaserver/plex/poll: pending first, so `{pending: true}` never parses as settings. */
export const PlexLinkPollResponse = z.union([PlexPollPending, UserRequestSettings]);
export type PlexLinkPollResponse = z.infer<typeof PlexLinkPollResponse>;
