import { FileSystemEntry, FileSystemListing, type FileSystemMkdirRequest } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror the filesystem block of apps/api/src/modules/imports/routes.ts.

export const filesystemApi = {
  /** Empty path: the roots (drives on Windows, `/` elsewhere). */
  list: (path: string, includeFiles = false) =>
    request('/filesystem', FileSystemListing, {
      query: { path, includeFiles, allowFoldersWithoutTrailingSlashes: true },
    }),
  mkdir: (body: FileSystemMkdirRequest) => request('/filesystem/mkdir', FileSystemEntry, { method: 'POST', json: body }),
};
