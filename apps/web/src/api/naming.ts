import { NamingConfig, NamingSamples, type NamingConfigInput } from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// TODO(contract): /settings/naming and /settings/naming/samples are being built in parallel.
// Samples are requested with the *draft* config in the query string so the preview follows
// unsaved edits; if the api settles on a POST body instead, change `samples` only.

export const namingApi = {
  get: () => request('/settings/naming', NamingConfig),
  update: (body: NamingConfigInput) => request('/settings/naming', NamingConfig, { method: 'PUT', json: body }),
  samples: (draft?: NamingConfigInput) =>
    request('/settings/naming/samples', NamingSamples, { query: draft as QueryParams | undefined }),
};
