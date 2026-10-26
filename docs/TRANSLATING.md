# Translating Arclight

The web app (`apps/web`) is translated with a small built-in i18n layer (`src/i18n/`, no
dependencies). This page explains the message format, how to add or improve a language, and
the checks a translation must pass.

## Where the text lives

```
apps/web/src/i18n/locales/
  en.json   source of truth: every user-facing string, written by developers
  de.json   German      (generated placeholders until translated)
  fr.json   French
  es.json   Spanish
  nl.json   Dutch
```

Each file is a flat JSON object of `key: message`. Keys are namespaced by the page or
component that uses them, so you can see where a string appears:

```json
{
  "library.index.addSeries": "Add series",
  "settings.general.uiPreferencesSection.timeFormat": "Time format",
  "common.save": "Save",
  "status.downloaded": "Downloaded"
}
```

- `common.*` holds short strings used on many pages (Save, Cancel, Delete, Series, Movies).
- `status.*` is the status vocabulary (Downloaded, Missing, Cutoff unmet, ...). The English
  labels are fixed by the design handoff; other languages translate them like any string.
- Only English is bundled with the app. Other languages are loaded on demand, and any key a
  language lacks falls back to English.

## Message format

Messages use a small subset of ICU MessageFormat.

| Syntax | Meaning | Example |
|---|---|---|
| `{name}` | a value inserted as-is | `"Delete {name}?"` |
| `{n, number}` | a number in the reader's locale (1,234 / 1.234) | `"{n, number} files"` |
| `{count, plural, ...}` | pick by number | `"{count, plural, one {# item} other {# items}}"` |
| `{kind, select, ...}` | pick by value | `"{kind, select, movie {Movie} other {Series}}"` |
| `#` | inside a plural branch: the number | `one {# season}` |
| `'{'` `'}'` `'#'` | a literal brace or hash | `"Tokens look like '{'Series Title'}'"` |
| `<b>...</b>`, `<link>...</link>` | rich text, only in messages rendered with `<Trans>` | `"Open <link>Settings</link>"` |

Plural categories follow `Intl.PluralRules` for the language: English and German use `one`
and `other`; French treats 0 and 1 as `one`; other languages may need `few` or `many`. You
can also match exact numbers with `=0`, `=1`, ... Every plural and select needs an `other`
branch.

Rules for translators:

1. Keep every `{placeholder}` the English message uses, spelled exactly the same. You may
   move them and you may add plural branches, but `i18n:check` fails if the set of names
   differs from English.
2. Keep rich-text tags (`<link>...</link>`) and translate the text between them.
3. Apostrophes are ordinary text (`"Don't"`), except right before and after a brace or `#`
   (`'{'`), which is how a literal brace is written.
4. Follow the copy rules in `design/arclight-kit/handoff/README.md`: sentence case (page
   titles in title case where your language has it), plain words, buttons are verbs, numbers
   keep their units. Product and protocol names (Arclight, TMDB, Plex, Torznab, VPN) stay as
   they are.

## Adding or updating a language

From the repository root:

```sh
# 1. Create or refresh the placeholder file(s) from en.json
pnpm --filter @arclight/web i18n:locales          # every shipped locale
pnpm --filter @arclight/web i18n:locales it       # a new one: creates it.json

# 2. Translate: replace "[it] Add series" with "Aggiungi serie", and so on.
#    Untranslated strings keep their "[it] " prefix so they stand out in the UI.

# 3. Check
pnpm --filter @arclight/web i18n:check
```

`i18n:locales` keeps your translations, refreshes placeholders whose English changed and drops
keys that no longer exist. It never overwrites a translated message, so when the English of a
translated string changes, review it by hand (git diff on `en.json` shows what changed).

For a new language, also add it to `LOCALES` in `src/i18n/locales-meta.ts` (code, English
name, native name) so it appears in the language picker. Right-to-left scripts (Arabic,
Hebrew, Persian, Urdu) get `dir="rtl"` on the document automatically.

To see your work, run the app (`pnpm dev`) and pick the language in **Settings → General →
UI → Language**, or on the first step of the setup wizard.

## The check

`pnpm --filter @arclight/web i18n:check` fails when:

- a locale file is missing a key from `en.json`, or has a key `en.json` does not
- a message does not parse, or uses different `{placeholders}` than English
- code calls `t('some.key')` with a key that is not in `en.json`
- `en.json` has a key that no code uses

## For developers

```tsx
import { t, useT, Trans } from '../i18n/index.js';

t('library.index.addSeries');                          // "Add series"
t('activity.queue.removeItems', { count: 3 });         // plural/select params
const t = useT();                                      // in components, re-renders on change
<Trans k="docs.fixIn" components={{ link: <Link to="/settings/general" /> }} />;
```

- Add the English text to `en.json` under a key named after the page or component, then run
  `i18n:locales`. Prefer one message with placeholders over joining fragments, so translators
  can reorder words.
- Do not call `t()` at module scope: the result would stay in the language active when the
  module loaded. Use a getter (`get label() { return t('...'); }`) or a function instead.
- Format numbers, sizes, durations and dates with the helpers in `src/i18n/format.ts`
  (`formatNumber`, `formatBytes`, `formatDuration`, `formatRelative`, `formatDate`,
  `weekdayNames`): they follow the UI language and the user's date format, 12/24-hour clock
  and first day of the week.
- `scripts/i18n-extract.mjs` is the codemod that moved the original strings into `en.json`.
  It can be re-run on new files (`node scripts/i18n-extract.mjs --dry src/pages/foo.tsx`
  reports what it would change); review its output by hand.
