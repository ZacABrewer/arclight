import { Backup, BackupRestoreResponse, BackupSettings, RestartResponse } from '@arclight/shared';
import { API_BASE, request } from './client.js';

// Paths mirror apps/api/src/modules/backup/routes.ts and the system module's restart route.

export const backupApi = {
  list: () => request('/system/backup', Backup.array()),
  create: () => request('/system/backup', Backup, { method: 'POST' }),
  remove: (id: string) => request(`/system/backup/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
  downloadUrl: (id: string) => `${API_BASE}/system/backup/${encodeURIComponent(id)}/download`,
  restore: (id: string) => request(`/system/backup/restore/${encodeURIComponent(id)}`, BackupRestoreResponse, { method: 'POST' }),
  /** FormData body: fetch sets the multipart boundary. */
  restoreUpload: (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    return request('/system/backup/restore/upload', BackupRestoreResponse, { method: 'POST', body: form });
  },
  settings: () => request('/settings/backup', BackupSettings),
  saveSettings: (value: BackupSettings) => request('/settings/backup', BackupSettings, { method: 'PUT', json: value }),
  restart: () => request('/system/restart', RestartResponse, { method: 'POST' }),
};
