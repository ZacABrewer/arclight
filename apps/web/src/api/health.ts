import { HealthResponse } from '@media-tron/shared';
import { request } from './client.js';

export const healthApi = {
  get: () => request('/health', HealthResponse),
};
