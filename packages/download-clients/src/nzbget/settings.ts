import { z } from 'zod';
import {
  addPausedField,
  categoryField,
  hostField,
  passwordField,
  portField,
  postImportCategoryField,
  urlBaseField,
  useSslField,
} from '../http.js';

/** Normalized usenet priorities, in NZBGet order. */
export const NZBGET_PRIORITIES = ['veryLow', 'low', 'normal', 'high', 'veryHigh', 'force'] as const;

const priorityField = (when: string) =>
  z
    .enum(NZBGET_PRIORITIES)
    .default('normal')
    .describe(`NZBGet queue priority for ${when}: veryLow (-100), low (-50), normal (0), high (50), veryHigh (100) or force (900, ignores pause).`);

export const NzbgetSettings = z.object({
  host: hostField,
  port: portField(6789),
  useSsl: useSslField,
  urlBase: urlBaseField('/nzbget'),
  username: z.string().default('nzbget').describe('NZBGet ControlUsername (Settings > Security).'),
  password: passwordField,
  category: categoryField('arclight', 'NZBGet category'),
  postImportCategory: postImportCategoryField('NZBGet category'),
  recentPriority: priorityField('releases that aired or were released recently'),
  olderPriority: priorityField('older releases'),
  addPaused: addPausedField,
});
export type NzbgetSettings = z.infer<typeof NzbgetSettings>;
export type NzbgetSettingsInput = z.input<typeof NzbgetSettings>;
