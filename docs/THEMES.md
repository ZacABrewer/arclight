# Themes

Arclight ships with one look, **Tron** (dark glass, cyan light, a grid horizon). Theme packs let
anyone re-skin the whole web app with a stylesheet: new colours, corners, shadows, fonts and
background. This page covers choosing a theme, how packs reach your server, and how to make and
publish your own.

## What a pack is

A pack is a small folder: a manifest, one stylesheet and optional fonts. It changes the app by
overriding the `--al-*` CSS variables (and, if it wants, any `.al-*` rule), always under
`[data-theme="<id>"]`, so it only applies while it is the active theme. A pack contains no
JavaScript and cannot load anything from the internet.

Packs live in the repository under `themes/<id>/`. A copy is bundled in the Docker image
(`/app/themes`) and newer versions are synced into `<config>/themes` (see
[How sync works](#how-sync-works)). Tron is built in and is not a pack.

## Choosing a theme

**Users**: Settings → General → UI → **Theme**. Pick a card; it saves to your account and
follows you to every device you sign in on. **Default** means "whatever the admin set". On the
request portal, the palette button in the top bar opens the same cards. The button is hidden
when there is only Tron, or when the admin turned user choice off.

Without an account (API key, signed out) the choice is remembered on that device only. The
sign-in page uses the theme this device used last, then the server default.

**Admins**: Settings → General → **Themes**.

| Setting | What it does |
|---|---|
| Default theme | Shown to everyone who has not picked one, and on the sign-in page |
| Let users pick a theme | Off: everyone sees the default theme and the picker is read-only. Admins can still pick their own |
| Sync theme packs | Download new and updated packs from the source (on by default) |
| Check for packs | Hours between syncs: 6, 12, 24 (default), 48 or 168 |
| Source | The raw-content URL packs are fetched from (see below) |
| Installed / **Sync now** | Lists installed packs and versions, shows when the last sync ran, and syncs immediately |

If a user's pick, or the default, names a pack that is no longer installed, Arclight falls back
to the default, then to Tron.

## How sync works

1. The server downloads `index.json` from the **Source** URL. It lists every pack with the size
   and SHA-256 of each file.
2. For each pack that is new, or has a higher `version` than the installed copy (bundled or
   synced), it downloads the files into a temporary folder, checks the size and checksum of
   every file, then runs the same validation as for a local pack (see
   [What the validator checks](#what-the-validator-checks)).
3. Only if everything passes is the folder swapped into `<config>/themes/<id>` in one step. A
   pack that fails is skipped (the reason is shown after **Sync now** and logged) and the old
   copy stays.

When a pack exists both bundled and synced, the **newer version wins**; on equal versions the
synced copy wins.

Syncs run on a schedule (job `ThemesSync`, also listed as "Theme packs" under System → Feeds),
and once about 90 seconds after start when the last sync is older than the interval or never
happened. **Sync now** runs one on demand.

**To turn it off**, switch off **Sync theme packs**. The server then makes no requests for
themes and uses only the packs in the image plus anything already synced. To remove a synced
pack, delete its folder from `<config>/themes` and restart.

Self-hosted fork: set **Source** to the raw URL of your fork's `themes/` folder, with a
trailing slash, so `<Source>index.json` and `<Source><id>/theme.css` resolve.

## Making a pack

### Folder layout

```
themes/
  my-theme/
    theme.json
    theme.css
    fonts/            optional
      MyFont.woff2
```

The folder name is the theme id: lowercase letters, digits and dashes, starting with a letter or
digit, at most 32 characters. `tron` is reserved.

### theme.json

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "version": "1.0.0",
  "description": "One line shown on the picker card.",
  "author": "Your name or handle",
  "colorScheme": "light",
  "backdrop": "shapes",
  "swatches": ["#f6efe6", "#e8743b"]
}
```

| Field | Rules |
|---|---|
| `id` | Same as the folder name |
| `name` | 1 to 40 characters |
| `version` | `major.minor.patch` digits, e.g. `1.2.0`. Bump it whenever any file changes |
| `description` | Up to 200 characters, optional |
| `author` | Up to 80 characters, optional |
| `colorScheme` | `dark` or `light`. Sets the browser's `color-scheme` (form controls, scrollbars) |
| `backdrop` | `tron`, `shapes` or `none` (default `none`), see [Backdrops](#backdrops) |
| `swatches` | 2 to 6 colours as `#rrggbb`. The picker previews them; the **first** is the background and also becomes the browser theme colour, the second is the accent |

### theme.css

Every rule must be scoped to your theme:

```css
[data-theme="my-theme"] {
  --al-void: #f6efe6;
  --al-cyan: #e8743b;
  --al-radius-card: 14px;
}

[data-theme="my-theme"] .al-pane { backdrop-filter: none; }
```

The scope may appear anywhere in a selector (`html[data-theme="my-theme"] .x`), and every
selector in a comma list must include it. Plain `:root { ... }` or `body { ... }` is rejected.
`@media`, `@supports` and `@container` blocks are fine, with scoped rules inside.
`@font-face` and `@keyframes` are the only rules allowed unscoped.

**Which tokens to override.** The full list is the `:root` block of
`apps/web/src/styles/arclight/arclight.css`, whose values are the Tron look. It is still
growing, so read the file rather than this page for the exact names. The groups:

- **Surfaces and text**: `--al-void`, `--al-deep`, `--al-horizon`, the glass and surface
  tokens, `--al-text-1` and the lower text levels.
- **Accent and signals**: `--al-cyan*` (the accent, despite the name), `--al-warn*`,
  `--al-danger*`, and their alpha tints (`--al-cyan-a20` is the accent at 20%). Tron's tints are
  all cyan, so a pack with a different accent must override the tints too.
- **Lines**: `--al-line-1` to `-4` and the `--al-line-aNN` dividers.
- **Light effects**: glow, focus rings, sheen, scrim, scanline and vignette.
- **Type**: `--al-font` (body), `--al-display` (headings, defaults to `--al-font`), `--al-mono`.
- **Shape**: corners and elevation, below.

Check contrast: text on the glass surfaces and the accent button's ink (`--al-cyan-ink`) must
stay readable. A light pack usually has to flip the surfaces, text, lines, scrim and the alpha
tints together.

**Shape tokens.** Tron is square and flat. Give a pack rounded, soft corners with:

| Token | Used for |
|---|---|
| `--al-radius-card` | Panes and cards |
| `--al-radius-inner` | Things inside cards |
| `--al-radius-control` | Buttons, segmented controls, toggles |
| `--al-radius-field` | Inputs and selects |
| `--al-radius-check` | Checkboxes |
| `--al-shadow-card`, `--al-shadow-pop` | Elevation on cards and popovers |
| `--al-blur` | Glass blur radius |

Tron cuts corners ("chamfers") with `clip-path`, which would clip rounded corners and shadows. A
pack that drops them sets `--al-chamfer: 0px;` and `--al-chamfer-clip: none;`. The modal and
float-bar cuts have their own sizes, `--al-chamfer-modal` and `--al-chamfer-bar`.

### Backdrops

`backdrop` in `theme.json` picks what is drawn behind the app:

| Kind | You get |
|---|---|
| `tron` | The animated grid floor and spire, tinted by your tokens |
| `none` | A plain `.al-backdrop` layer (background, scanline and vignette from your tokens) |
| `shapes` | The plain layer plus three decorative elements you style yourself |

For `shapes` the app renders:

```html
<div class="al-backdrop al-backdrop--shapes" aria-hidden="true">
  <i class="al-backdrop__shape" data-shape="1"></i>
  <i class="al-backdrop__shape" data-shape="2"></i>
  <i class="al-backdrop__shape" data-shape="3"></i>
</div>
```

The shapes are empty and unstyled, so give them size, position, colour and (optionally) motion:

```css
[data-theme="my-theme"] .al-backdrop__shape { position: absolute; border-radius: 50%; filter: blur(40px); }
[data-theme="my-theme"] .al-backdrop__shape[data-shape="1"] { width: 40vmax; height: 40vmax; top: -10%; left: -8%; background: var(--al-cyan-a20); }
[data-theme="my-theme"] .al-backdrop__shape[data-shape="2"] { width: 30vmax; height: 30vmax; right: -6%; bottom: 5%; background: var(--al-warn-a35); }
[data-theme="my-theme"] .al-backdrop__shape[data-shape="3"] { width: 18vmax; height: 18vmax; top: 40%; left: 45%; background: var(--al-cyan-a10); }
```

The backdrop is fixed, behind everything and ignores the pointer. If you animate the shapes,
respect reduced motion:

```css
@media (prefers-reduced-motion: reduce) {
  [data-theme="my-theme"] .al-backdrop__shape { animation: none; }
}
```

### Fonts

Fonts must be **self-hosted** `.woff2` files in `fonts/`, referenced relatively. Remote fonts
(Google Fonts and similar) are not allowed.

```css
@font-face {
  font-family: "My Font";
  src: url(fonts/MyFont.woff2) format("woff2");
  font-weight: 100 900;
  font-display: swap;
}

[data-theme="my-theme"] { --al-font: "My Font", system-ui, sans-serif; }
```

File names use letters, digits, `.`, `_` and `-`. Subset fonts to the characters you need to
stay under the size limits. Only ship fonts whose licence allows redistribution (SIL OFL,
Apache 2.0 and similar), keep the licence text alongside your pack if the licence asks for it,
and credit the font in `description`.

### What the validator checks

A pack that fails any rule is not offered, whether it is local, bundled or synced.

| Rule | Detail |
|---|---|
| `theme.json` | Valid per the table above; `id` matches the folder; not `tron` |
| Scoping | Every style rule names `[data-theme="<id>"]` |
| Allowed at-rules | `@font-face`, `@keyframes`, and `@media` / `@supports` / `@container` groups (checked inside) |
| Not allowed | `@import`, `@namespace`, `@charset`, any other at-rule |
| URLs | `url()` only to the pack's own fonts (`url(fonts/x.woff2)`); no images, no `image-set()` or `src()` |
| Hooks and escapes | No `expression()`, `javascript:`, `behavior:`, `-moz-binding`, and no backslash anywhere in the CSS |
| Files | Only `theme.json`, `theme.css` and `fonts/*.woff2` are used |

| Limit | Value |
|---|---|
| `theme.css` | 256 KB |
| One font | 512 KB |
| Whole pack (CSS + fonts) | 2 MB |
| Files per pack in the index | 2 to 40 |
| Packs in an index | 100 |

Because `url()` to images is blocked, draw backgrounds with gradients, `box-shadow` and the
backdrop shapes.

## Testing locally

**With a dev server.** Put the folder in the repository's `themes/` and start `pnpm dev` from
the repository root. The API loads packs from `themes/` (or from the folder named by the
`ARCLIGHT_THEMES_DIR` environment variable). Packs are read when the API starts and after a
sync, so **restart the API after editing**. The stylesheet is cached for a year per version, so
bump `version` (or hard-refresh) to see CSS changes. Then pick the theme in Settings → General →
UI.

**On a running install.** Copy the folder to `<config>/themes/<id>/` (the config volume in the
install guides) and restart. This is the same place synced packs go; a pack with the same id and
an equal or higher version than the bundled one is used.

To find out why a pack is missing, look in the log for `theme pack skipped`: it carries the
first problem found. If a theme's stylesheet fails to load in the browser, the app falls back
to Tron.

## Publishing

1. Bump `version` in `theme.json` (every change to any file needs a new version, or instances
   keep their old copy).
2. Regenerate the index:

   ```
   node scripts/build-themes.mjs
   ```

   This writes `themes/index.json` with each pack's manifest and every file's size and SHA-256.
   CI runs `node scripts/build-themes.mjs --check` and fails when the index is out of date.
3. Commit the pack and `themes/index.json`, and push to `main`.

Running instances pick the pack up on their next sync, or when an admin presses **Sync now**.
Releases also bundle whatever is in `themes/` at that point.

For a fork, do the same in your own repository and point each instance's **Source** at
the raw URL of your fork's `themes/` folder.
