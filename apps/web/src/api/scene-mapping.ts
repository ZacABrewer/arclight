import { SceneMapping, SceneMappingApplyResult, SceneMappingFeedStatus, type SceneMappingInput } from '@arclight/shared';
import { request } from './client.js';

// Scene numbering rules: paths mirror apps/api/src/modules/scene-mapping (docs/API.md "scene-mapping").

export const sceneMappingApi = {
  list: (seriesId: number) => request(`/series/${seriesId}/scenemapping`, SceneMapping.array()),
  create: (seriesId: number, body: SceneMappingInput) => request(`/series/${seriesId}/scenemapping`, SceneMapping, { method: 'POST', json: body }),
  update: (seriesId: number, mappingId: number, body: SceneMappingInput) =>
    request(`/series/${seriesId}/scenemapping/${mappingId}`, SceneMapping, { method: 'PUT', json: body }),
  remove: (seriesId: number, mappingId: number) => request(`/series/${seriesId}/scenemapping/${mappingId}`, null, { method: 'DELETE' }),
  apply: (seriesId: number) => request(`/series/${seriesId}/scenemapping/apply`, SceneMappingApplyResult, { method: 'POST' }),
  feed: {
    status: () => request('/scenemapping/feed', SceneMappingFeedStatus),
    sync: () => request('/scenemapping/feed/sync', SceneMappingFeedStatus, { method: 'POST' }),
  },
};
