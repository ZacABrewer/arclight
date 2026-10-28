import { z } from 'zod';
import {
  VIDEO_QUALITIES,
  CustomFormat,
  CustomFormatTestResponse,
  DelayProfile,
  QualityDefinitionItem,
  QualityProfile,
  QualityProfileInput,
  ReleaseProfile,
  SpecImplementationDefinition,
  type CustomFormatInput,
  type MediaDomain,
  type CustomFormatTestRequest,
  type DelayProfileInput,
  type DelayProfileReorderRequest,
  type QualityDefinitionLimits,
  type ReleaseProfileInput,
} from '@arclight/shared';
import { request } from './client.js';

// Paths mirror apps/api/src/modules/profiles/routes.ts.

/** The blank template has an empty name, which the strict input schema rejects. */
const QualityProfileTemplate = QualityProfileInput.extend({ name: z.string() });

/**
 * Local blank profile (every quality listed worst -> best, none allowed). Used when
 * /qualityprofile/schema fails: the api currently answers 500 because its own response
 * schema rejects the template's empty name.
 */
export function fallbackQualityProfileTemplate(): QualityProfileInput {
  const items = [...VIDEO_QUALITIES]
    .filter((q) => q.id !== 0)
    .sort((a, b) => a.weight - b.weight)
    .map((q) => ({ kind: 'quality' as const, qualityId: q.id, allowed: false }));
  return {
    name: '',
    upgradeAllowed: true,
    cutoff: 0,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
  };
}

export const profilesApi = {
  quality: {
    /** Every profile, or one domain's (`video` for series/movies, `music`, `audiobook`). */
    list: (mediaDomain?: MediaDomain) =>
      request('/qualityprofile', QualityProfile.array(), mediaDomain ? { query: { mediaDomain } } : undefined),
    schema: async (): Promise<QualityProfileInput> => {
      try {
        return await request('/qualityprofile/schema', QualityProfileTemplate);
      } catch {
        return fallbackQualityProfileTemplate();
      }
    },
    get: (id: number) => request(`/qualityprofile/${id}`, QualityProfile),
    create: (body: QualityProfileInput) => request('/qualityprofile', QualityProfile, { method: 'POST', json: body }),
    update: (id: number, body: QualityProfileInput) =>
      request(`/qualityprofile/${id}`, QualityProfile, { method: 'PUT', json: body }),
    /** 409 IN_USE when a series/movie still uses the profile. */
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
    get: (id: number) => request(`/delayprofile/${id}`, DelayProfile),
    create: (body: DelayProfileInput) => request('/delayprofile', DelayProfile, { method: 'POST', json: body }),
    update: (id: number, body: DelayProfileInput) =>
      request(`/delayprofile/${id}`, DelayProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/delayprofile/${id}`, null, { method: 'DELETE' }),
    /** Moves `id` after `afterId` (or to the front); returns the full, reordered list. */
    reorder: (body: DelayProfileReorderRequest) =>
      request('/delayprofile/reorder', DelayProfile.array(), { method: 'PUT', json: body }),
  },
  release: {
    list: () => request('/releaseprofile', ReleaseProfile.array()),
    get: (id: number) => request(`/releaseprofile/${id}`, ReleaseProfile),
    create: (body: ReleaseProfileInput) => request('/releaseprofile', ReleaseProfile, { method: 'POST', json: body }),
    update: (id: number, body: ReleaseProfileInput) =>
      request(`/releaseprofile/${id}`, ReleaseProfile, { method: 'PUT', json: body }),
    remove: (id: number) => request(`/releaseprofile/${id}`, null, { method: 'DELETE' }),
  },
  qualityDefinitions: {
    list: () => request('/qualitydefinition', QualityDefinitionItem.array()),
    /** One quality at a time: PUT /qualitydefinition/:qualityId with the limits. */
    update: (qualityId: number, limits: QualityDefinitionLimits) =>
      request(`/qualitydefinition/${qualityId}`, QualityDefinitionItem, { method: 'PUT', json: limits }),
  },
};
