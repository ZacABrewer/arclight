import { z } from 'zod';
import {
  addPausedField,
  categoryField,
  hostField,
  passwordField,
  portField,
  postImportCategoryField,
  useSslField,
  usernameField,
} from '../http.js';

export const TransmissionPriority = z.enum(['last', 'first']);
export type TransmissionPriority = z.infer<typeof TransmissionPriority>;

/**
 * Settings for a Transmission daemon reached through its JSON RPC endpoint
 * (`<scheme>://<host>:<port><urlBase>rpc`).
 */
export const TransmissionSettings = z.object({
  host: hostField,
  port: portField(9091),
  useSsl: useSslField,
  urlBase: z
    .string()
    .trim()
    .default('/transmission/')
    .describe('RPC path prefix; "rpc" is appended. Transmission\'s default is "/transmission/". Change it only behind a reverse proxy or when rpc-url was customised.'),
  username: usernameField,
  password: passwordField,
  category: categoryField('media-tron', 'Label'),
  postImportCategory: postImportCategoryField('Label'),
  directory: z
    .string()
    .trim()
    .optional()
    .describe('Download directory as Transmission sees it. Leave empty to use Transmission\'s default download-dir.'),
  recentPriority: TransmissionPriority.default('last').describe(
    'Queue position for recently released content: "first" moves it to the top of the download queue.',
  ),
  olderPriority: TransmissionPriority.default('last').describe(
    'Queue position for older content: "first" moves it to the top of the download queue.',
  ),
  addPaused: addPausedField,
});
export type TransmissionSettings = z.infer<typeof TransmissionSettings>;
export type TransmissionSettingsInput = z.input<typeof TransmissionSettings>;
