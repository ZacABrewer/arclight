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

/** Characters Deluge's Label plugin accepts in a label id (after lowercasing). */
export const DELUGE_LABEL_PATTERN = /^[a-z0-9_.-]*$/;

/** Deluge labels are always lowercase; Media-Tron lowercases categories before using them. */
export function normalizeLabel(category: string): string {
  return category.trim().toLowerCase();
}

function isValidLabel(value: string | undefined): boolean {
  return value === undefined || DELUGE_LABEL_PATTERN.test(normalizeLabel(value));
}

const LABEL_RULE = 'Deluge labels may only contain letters, digits, "_", "-" and "." (they are stored lowercase).';

export const DelugePriority = z.enum(['last', 'first']);

export const DelugeSettings = z.object({
  host: hostField,
  port: portField(8112),
  useSsl: useSslField,
  urlBase: urlBaseField('/deluge'),
  password: passwordField.describe(
    'Deluge Web UI password (Deluge has no username). A fresh Deluge install uses "deluge" until it is changed. Write-only: never returned by the API.',
  ),
  category: categoryField('media-tron', 'Label')
    .describe(
      'Label Media-Tron assigns to its downloads via Deluge\'s Label plugin (enabled automatically when needed), keeping them apart from everything else. Converted to lowercase. Leave empty to not use one.',
    )
    .refine(isValidLabel, LABEL_RULE),
  postImportCategory: postImportCategoryField('Label').refine(isValidLabel, LABEL_RULE),
  recentPriority: DelugePriority.default('last').describe(
    'Queue position for recently released content: "first" moves it to the top of Deluge\'s queue.',
  ),
  olderPriority: DelugePriority.default('last').describe(
    'Queue position for older content: "first" moves it to the top of Deluge\'s queue.',
  ),
  addPaused: addPausedField,
});
export type DelugeSettings = z.infer<typeof DelugeSettings>;
export type DelugeSettingsInput = z.input<typeof DelugeSettings>;
