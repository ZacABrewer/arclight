import { HealthResponse } from '@arclight/shared';
import { request } from './client.js';

export const healthApi = {
  get: () => request('/health', HealthResponse),
};
