import { ContainerUpdateRun, ContainerUpdatesInfo, UpdateInfo, UpdateSettings, type UpdateSettingsUpdate } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/updates/routes.ts.

export const updatesApi = {
  info: () => request('/system/update', UpdateInfo),
  check: () => request('/system/update/check', UpdateInfo, { method: 'POST' }),
  settings: {
    get: () => request('/settings/updates', UpdateSettings),
    update: (body: UpdateSettingsUpdate) => request('/settings/updates', UpdateSettings, { method: 'PUT', json: body }),
  },
  containers: {
    info: () => request('/system/update/containers', ContainerUpdatesInfo),
    check: () => request('/system/update/containers/check', ContainerUpdatesInfo, { method: 'POST' }),
    updateAll: () => request('/system/update/containers/update', ContainerUpdateRun, { method: 'POST' }),
    update: (name: string) => request(`/system/update/containers/${encodeURIComponent(name)}/update`, ContainerUpdateRun, { method: 'POST' }),
  },
};
