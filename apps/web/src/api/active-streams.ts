import { ActiveStreamsResponse } from '@arclight/shared';
import { request } from './client.js';

// Activity -> Now playing (contract: packages/shared/src/active-streams.ts). Admins only.

export const activeStreamsApi = {
  list: () => request('/activity/streams', ActiveStreamsResponse),
};
