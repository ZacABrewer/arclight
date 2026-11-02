import { z } from 'zod';
import {
  SoulseekAutoResult,
  SoulseekDownload,
  SoulseekSearchResult,
  SoulseekSettingsResponse,
  SoulseekTestResult,
  type SoulseekGrabRequest,
  type SoulseekSearchRequest,
  type SoulseekSettingsUpdate,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/music/soulseek (an optional music source through the user's
// own slskd instance). Admin-only; 404 MUSIC_DISABLED while music is off.

export const soulseekApi = {
  settings: () => request('/settings/soulseek', SoulseekSettingsResponse),
  updateSettings: (body: SoulseekSettingsUpdate) => request('/settings/soulseek', SoulseekSettingsResponse, { method: 'PUT', json: body }),
  test: (body: SoulseekSettingsUpdate) => request('/soulseek/test', SoulseekTestResult, { method: 'POST', json: body }),
  search: (body: SoulseekSearchRequest) => request('/soulseek/search', SoulseekSearchResult, { method: 'POST', json: body }),
  grab: (body: SoulseekGrabRequest) => request('/soulseek/grab', SoulseekDownload, { method: 'POST', json: body }),
  auto: (albumId: number) => request(`/soulseek/album/${albumId}/auto`, SoulseekAutoResult, { method: 'POST' }),
  downloads: () => request('/soulseek/downloads', z.array(SoulseekDownload)),
  remove: (id: number) => request(`/soulseek/downloads/${id}`, null, { method: 'DELETE' }),
};
