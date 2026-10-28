import { ThemeCatalog, ThemeSettings, ThemeStatus, ThemeSyncResult } from '@arclight/shared';
import { API_BASE, request } from './client.js';

// Paths mirror docs/API.md § themes (apps/api/src/modules/themes).

export const themesApi = {
  /** Public: the themes, the server default and whether users may choose. */
  catalog: () => request('/theme', ThemeCatalog),
  status: () => request('/theme/status', ThemeStatus),
  sync: () => request('/theme/sync', ThemeSyncResult, { method: 'POST' }),
  settings: {
    get: () => request('/settings/themes', ThemeSettings),
    save: (body: ThemeSettings) => request('/settings/themes', ThemeSettings, { method: 'PUT', json: body }),
  },
};

/** Absolute URL of a pack stylesheet path from the catalogue (`theme/<id>/theme.css?v=…`). */
export function themeCssUrl(path: string): string {
  return `${API_BASE}/${path.replace(/^\/+/, '')}`;
}
