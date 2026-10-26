import { AdditionalLanguageResult, ItemLanguages, type AdditionalLanguageRequestInput, type ItemLanguagesQuery } from '@arclight/shared';
import { request } from './client.js';

// "Add additional…" (contract: packages/shared/src/additional-languages.ts). Preview plans the
// action per item without saving anything; apply saves the languages and starts the searches.

export const additionalLanguagesApi = {
  item: (query: ItemLanguagesQuery) => request('/additional-language', ItemLanguages, { query: { ...query } }),
  preview: (body: AdditionalLanguageRequestInput) => request('/additional-language/preview', AdditionalLanguageResult, { method: 'POST', json: body }),
  apply: (body: AdditionalLanguageRequestInput) => request('/additional-language', AdditionalLanguageResult, { method: 'POST', json: body }),
  remove: (id: number) => request(`/additional-language/${id}`, null, { method: 'DELETE' }),
};
