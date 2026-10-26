import {
  CustomFormat,
  CustomFormatTestResponse,
  DelayProfile,
  QualityDefinitionItem,
  QualityProfile,
  QualityProfileInput,
  ReleaseProfile,
  SpecImplementationDefinition,
  type CustomFormatInput,
  type CustomFormatTestRequest,
  type DelayProfileInput,
  type ReleaseProfileInput,
} from '@media-tron/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/profiles/routes.ts.
// TODO(contract): the profiles module is not registered in apps/api/src/app.ts yet; re-check the
// custom-format test and quality-definition update routes when it is.

export const profilesApi = {
  quality: {
    list: () => request('/qualityprofile', QualityProfile.array()),
    schema: () => request('/qualityprofile/schema', QualityProfileInput),
    get: (id: number) => request(`/qualityprofile/${id}`, QualityProfile),
    create: (body: QualityProfileInput) => request('/qualityprofile', QualityProfile, { method: 'POST', json: body }),
    update: (id: number, body: QualityProfileInput) =>
      request(`/qualityprofile/${id}`, QualityProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/qualityprofile/${id}`, null, { method: 'DELETE' }),
  },
  customFormats: {
    list: () => request('/customformat', CustomFormat.array()),
    schema: () => request('/customformat/schema', SpecImplementationDefinition.array()),
    get: (id: number) => request(`/customformat/${id}`, CustomFormat),
    create: (body: CustomFormatInput) => request('/customformat', CustomFormat, { method: 'POST', json: body }),
    update: (id: number, body: CustomFormatInput) =>
      request(`/customformat/${id}`, CustomFormat, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/customformat/${id}`, null, { method: 'DELETE' }),
    test: (body: CustomFormatTestRequest) =>
      request('/customformat/test', CustomFormatTestResponse, { method: 'POST', json: body }),
  },
  delay: {
    list: () => request('/delayprofile', DelayProfile.array()),
    create: (body: DelayProfileInput) => request('/delayprofile', DelayProfile, { method: 'POST', json: body }),
    update: (id: number, body: DelayProfileInput) =>
      request(`/delayprofile/${id}`, DelayProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/delayprofile/${id}`, null, { method: 'DELETE' }),
  },
  release: {
    list: () => request('/releaseprofile', ReleaseProfile.array()),
    create: (body: ReleaseProfileInput) => request('/releaseprofile', ReleaseProfile, { method: 'POST', json: body }),
    update: (id: number, body: ReleaseProfileInput) =>
      request(`/releaseprofile/${id}`, ReleaseProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/releaseprofile/${id}`, null, { method: 'DELETE' }),
  },
  qualityDefinitions: {
    list: () => request('/qualitydefinition', QualityDefinitionItem.array()),
    update: (items: QualityDefinitionItem[]) =>
      request('/qualitydefinition', QualityDefinitionItem.array(), { method: 'PUT', json: items }),
  },
};
