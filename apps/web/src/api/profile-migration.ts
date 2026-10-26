import { z } from 'zod';
import {
  Job,
  ProfileItemStatus,
  ProfileMigrationApplyResult,
  ProfileMigrationPreview,
  ProfileMigrationProgress,
  ProfileMigrationSearchResult,
  ProfileMigrationSettings,
  ProfileMismatchPage,
  type ProfileFileStatus,
  type ProfileMigrationProfileUpdate,
  type ProfileMigrationRequest,
  type MediaType,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/profile-migration/routes.ts.

export interface MismatchListQuery {
  page: number;
  pageSize: number;
  mediaType?: MediaType | undefined;
  status?: readonly ProfileFileStatus[] | undefined;
  qualityProfileId?: number | undefined;
}

export const profileMigrationApi = {
  settings: () => request('/profilemigration/settings', ProfileMigrationSettings),
  saveSettings: (body: Partial<ProfileMigrationSettings>) =>
    request('/profilemigration/settings', ProfileMigrationSettings, { method: 'PUT', json: body }),
  profiles: () => request('/profilemigration/profiles', z.array(ProfileMigrationProgress)),
  profile: (id: number) => request(`/profilemigration/profiles/${id}`, ProfileMigrationProgress),
  updateProfile: (id: number, body: ProfileMigrationProfileUpdate) =>
    request(`/profilemigration/profiles/${id}`, ProfileMigrationProgress, { method: 'PUT', json: body }),
  searchAll: (id: number) => request(`/profilemigration/profiles/${id}/search`, ProfileMigrationSearchResult, { method: 'POST' }),
  retryFailed: (id: number) => request(`/profilemigration/profiles/${id}/retry`, ProfileMigrationProgress, { method: 'POST' }),
  preview: (body: ProfileMigrationRequest) => request('/profilemigration/preview', ProfileMigrationPreview, { method: 'POST', json: body }),
  apply: (body: ProfileMigrationRequest) => request('/profilemigration/apply', ProfileMigrationApplyResult, { method: 'POST', json: body }),
  mismatch: (query: MismatchListQuery) =>
    request('/profilemigration/mismatch', ProfileMismatchPage, {
      query: {
        page: query.page,
        pageSize: query.pageSize,
        mediaType: query.mediaType,
        status: query.status && query.status.length > 0 ? query.status.join(',') : undefined,
        qualityProfileId: query.qualityProfileId,
      },
    }),
  items: () => request('/profilemigration/items', z.array(ProfileItemStatus)),
  reevaluate: () => request('/profilemigration/reevaluate', Job.nullable(), { method: 'POST' }),
};
