import { z } from 'zod';
import {
  categoryField,
  hostField,
  passwordField,
  portField,
  postImportCategoryField,
  urlBaseField,
  usernameField,
  useSslField,
} from '../http.js';

/**
 * SABnzbd queue priorities as offered in its UI. SAB's numeric values:
 * default = -100 (use the category's priority), paused = -2, low = -1, normal = 0,
 * high = 1, force = 2 (starts even while the queue is paused).
 */
export const SabnzbdPriority = z.enum(['default', 'paused', 'low', 'normal', 'high', 'force']);
export type SabnzbdPriority = z.infer<typeof SabnzbdPriority>;

export const SabnzbdSettings = z.object({
  host: hostField,
  port: portField(8080),
  useSsl: useSslField,
  urlBase: urlBaseField('/sabnzbd'),
  apiKey: z
    .string()
    .trim()
    .default('')
    .describe('Full API key from SABnzbd Config > General (not the NZB key). Preferred over username and password.'),
  username: usernameField.describe(
    'Legacy: SABnzbd web login username, sent as ma_username. Only needed when no API key is set.',
  ),
  password: passwordField.describe(
    'Legacy: SABnzbd web login password, sent as ma_password. Write-only: never returned by the API.',
  ),
  category: categoryField('arclight', 'SABnzbd category'),
  postImportCategory: postImportCategoryField('SABnzbd category'),
  recentPriority: SabnzbdPriority.default('default').describe(
    'Queue priority for releases that aired or were released recently. "default" uses the category\'s priority.',
  ),
  olderPriority: SabnzbdPriority.default('default').describe(
    'Queue priority for older releases. "default" uses the category\'s priority.',
  ),
});
export type SabnzbdSettings = z.infer<typeof SabnzbdSettings>;
export type SabnzbdSettingsInput = z.input<typeof SabnzbdSettings>;
