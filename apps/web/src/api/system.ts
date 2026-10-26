import { SystemStatus } from '@media-tron/shared';
import { request } from './client.js';

export const systemApi = {
  status: () => request('/system/status', SystemStatus),
};
