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

/** rTorrent download priorities, sent as `d.priority.set` 0..3. */
export const RTorrentPriority = z.enum(['off', 'low', 'normal', 'high']);
export type RTorrentPriority = z.infer<typeof RTorrentPriority>;

export const RTORRENT_PRIORITY_VALUES: Record<RTorrentPriority, number> = { off: 0, low: 1, normal: 2, high: 3 };

export const RTorrentSettings = z.object({
  host: hostField,
  port: portField(8080),
  useSsl: useSslField,
  urlBase: z
    .string()
    .trim()
    .default('RPC2')
    .describe(
      'Path of the XML-RPC endpoint the web server (SCGI bridge) exposes, e.g. "RPC2", or "plugins/rpc/rpc.php" for ruTorrent\'s rpc plugin.',
    ),
  username: usernameField,
  password: passwordField,
  category: categoryField('arclight', 'Label (stored in d.custom1, the ruTorrent label)'),
  postImportCategory: postImportCategoryField('Label'),
  directory: z
    .string()
    .trim()
    .optional()
    .describe('Directory rTorrent saves Arclight downloads into. Leave empty to use rTorrent\'s default directory.'),
  addPaused: addPausedField,
  recentPriority: RTorrentPriority.default('normal').describe('rTorrent priority for content released recently.'),
  olderPriority: RTorrentPriority.default('normal').describe('rTorrent priority for older content.'),
});
export type RTorrentSettings = z.infer<typeof RTorrentSettings>;
export type RTorrentSettingsInput = z.input<typeof RTorrentSettings>;
