import {
  TorrentActionResult,
  TorrentDetail,
  TorrentSessionStatus,
  TorrentSettingsResponse,
  type TorrentLimitsRequest,
  type TorrentListQuery,
  type TorrentMoveRequest,
  type TorrentPriorityRequest,
  type TorrentSettingsUpdate,
  type TorrentSuperSeedRequest,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/torrent/routes.ts (the built-in torrent engine).

export type TorrentAction = 'pause' | 'resume' | 'recheck';

const enc = (id: string) => encodeURIComponent(id);

export const torrentApi = {
  status: () => request('/torrent/status', TorrentSessionStatus),
  list: (query: TorrentListQuery = {}) =>
    request('/torrent/torrents', TorrentDetail.array(), { query: { id: query.id, category: query.category } }),
  action: (id: string, action: TorrentAction) => request(`/torrent/${enc(id)}/${action}`, TorrentActionResult, { method: 'POST' }),
  move: (id: string, body: TorrentMoveRequest) => request(`/torrent/${enc(id)}/move`, TorrentActionResult, { method: 'POST', json: body }),
  priority: (id: string, body: TorrentPriorityRequest) =>
    request(`/torrent/${enc(id)}/priority`, TorrentActionResult, { method: 'POST', json: body }),
  /** Per-torrent and per-peer rate limits in bytes/s (0 = unlimited); omitted keys keep their value. */
  limits: (id: string, body: TorrentLimitsRequest) =>
    request(`/torrent/${enc(id)}/limits`, TorrentActionResult, { method: 'POST', json: body }),
  /** BEP 16 super-seeding on or off. */
  superSeed: (id: string, body: TorrentSuperSeedRequest) =>
    request(`/torrent/${enc(id)}/superseed`, TorrentActionResult, { method: 'POST', json: body }),
  settings: {
    get: () => request('/settings/torrent', TorrentSettingsResponse),
    update: (body: TorrentSettingsUpdate) => request('/settings/torrent', TorrentSettingsResponse, { method: 'PUT', json: body }),
  },
};
