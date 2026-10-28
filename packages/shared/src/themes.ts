import { z } from 'zod';

// Theme packs: a pack re-skins the web app by overriding the `--al-*` CSS variables (and any
// `.al-*` rule) under `[data-theme="<id>"]`. "Tron" is the built-in base look and is not a pack.
// Packs live in the repository under `themes/<id>/` (theme.json, theme.css, fonts/*.woff2) with a
// `themes/index.json` catalogue that `scripts/build-themes.mjs` generates. The image bundles them,
// and the themes module syncs newer versions from the repository. Owned by the themes module
// (routes under /theme and /settings/themes).

/** The built-in theme's id. */
export const BASE_THEME_ID = 'tron';

/** Where packs sync from: a raw-content base that serves `index.json` and `<id>/<file>`. */
export const DEFAULT_THEMES_URL = 'https://raw.githubusercontent.com/ZacABrewer/arclight/main/themes/';

export const ThemeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes');

export const ThemeColorScheme = z.enum(['dark', 'light']);
export type ThemeColorScheme = z.infer<typeof ThemeColorScheme>;

/** `tron`: the grid floor and spire; `shapes`: three `.al-backdrop__shape` elements the pack styles; `none`: the plain background. */
export const ThemeBackdrop = z.enum(['tron', 'shapes', 'none']);
export type ThemeBackdrop = z.infer<typeof ThemeBackdrop>;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** `themes/<id>/theme.json`. */
export const ThemeManifest = z.object({
  id: ThemeId,
  name: z.string().trim().min(1).max(40),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(200).default(''),
  author: z.string().max(80).default(''),
  colorScheme: ThemeColorScheme,
  backdrop: ThemeBackdrop.default('none'),
  /** Preview colours for the picker: background first, then the accent. */
  swatches: z.array(Hex).min(2).max(6),
});
export type ThemeManifest = z.infer<typeof ThemeManifest>;

/** A pack file name: `theme.json`, `theme.css`, `fonts/<name>.woff2`, or a font licence `fonts/<name>.txt`. */
export const ThemeFileName = z.string().regex(/^(theme\.json|theme\.css|fonts\/[A-Za-z0-9._-]{1,80}\.(woff2|txt))$/);

export const ThemeIndexFile = z.object({
  path: ThemeFileName,
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ThemeIndexFile = z.infer<typeof ThemeIndexFile>;

export const ThemeIndexEntry = ThemeManifest.extend({ files: z.array(ThemeIndexFile).min(2).max(40) });
export type ThemeIndexEntry = z.infer<typeof ThemeIndexEntry>;

/** `themes/index.json`. */
export const ThemeIndex = z.object({
  schema: z.literal(1),
  themes: z.array(ThemeIndexEntry).max(100),
});
export type ThemeIndex = z.infer<typeof ThemeIndex>;

/** Limits the server enforces on a pack (bundled or synced). */
export const THEME_LIMITS = Object.freeze({ cssBytes: 256 * 1024, fontBytes: 512 * 1024, packBytes: 2 * 1024 * 1024 });

/** One theme the server can serve (GET /theme). */
export const ThemeInfo = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string(),
  colorScheme: ThemeColorScheme,
  backdrop: ThemeBackdrop,
  swatches: z.array(z.string()),
  /** `builtin`: Tron; `bundled`: shipped in the image; `synced`: downloaded from the theme source. */
  source: z.enum(['builtin', 'bundled', 'synced']),
  /** Stylesheet path relative to the API root (`theme/<id>/theme.css?v=<version>`); null for Tron. */
  css: z.string().nullable(),
});
export type ThemeInfo = z.infer<typeof ThemeInfo>;

export const ThemeSyncState = z.object({
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Pack ids added or updated by the last sync. */
  lastChanged: z.array(z.string()),
});
export type ThemeSyncState = z.infer<typeof ThemeSyncState>;

/** GET /theme: what anyone (signed in or not) needs to apply a theme. */
export const ThemeCatalog = z.object({
  themes: z.array(ThemeInfo),
  /** The server default, used by users who have not picked one and on the sign-in page. */
  defaultTheme: z.string(),
  /** Whether users may pick their own theme (admins always can). */
  allowUserChoice: z.boolean(),
});
export type ThemeCatalog = z.infer<typeof ThemeCatalog>;

/** Stored form of the `themes` settings section; also the GET/PUT body of /settings/themes. */
export const ThemeSettings = z.object({
  defaultTheme: ThemeId.default(BASE_THEME_ID),
  allowUserChoice: z.boolean().default(true),
  /** Download new and updated packs from `sourceUrl`. */
  syncEnabled: z.boolean().default(true),
  /** 1-168 hours between automatic syncs. */
  syncIntervalHours: z.number().int().min(1).max(168).default(24),
  sourceUrl: z.string().url().default(DEFAULT_THEMES_URL),
});
export type ThemeSettings = z.infer<typeof ThemeSettings>;
export type ThemeSettingsInput = z.input<typeof ThemeSettings>;

/** GET /theme/status (admins). */
export const ThemeStatus = z.object({ settings: ThemeSettings, sync: ThemeSyncState, themes: z.array(ThemeInfo) });
export type ThemeStatus = z.infer<typeof ThemeStatus>;

/** POST /theme/sync. */
export const ThemeSyncResult = z.object({
  ok: z.boolean(),
  changed: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  error: z.string().nullable(),
});
export type ThemeSyncResult = z.infer<typeof ThemeSyncResult>;

/** Compares `x.y.z` versions: above 0 when `a` is newer. */
export function compareThemeVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Problems with a pack stylesheet, empty when it is acceptable: no `@import`, no `url()` other
 * than one of the pack's own fonts (`fonts/<name>.woff2`), no script hooks or escapes, and every
 * style rule must name the pack's `[data-theme="<id>"]`, so a pack only changes the page while it
 * is the active theme. `@font-face` and `@keyframes` may stand alone; `@media` / `@supports`
 * blocks are checked inside.
 */
export function checkThemeCss(css: string, id: string, fonts: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b/i.test(text)) problems.push('@import is not allowed');
  if (/@namespace\b|@charset\b/i.test(text)) problems.push('@namespace and @charset are not allowed');
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(text)) problems.push('script hooks are not allowed');
  // Escapes could spell "url(" or "@import" in a way the checks above do not see.
  if (text.includes('\\')) problems.push('backslash escapes are not allowed');
  for (const m of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const ref = m[2] ?? '';
    if (!fonts.has(ref)) problems.push(`url(${ref}) is not one of the pack's fonts`);
  }
  if (/\bimage-set\(|\bsrc\(/i.test(text)) problems.push('image-set() and src() are not allowed');
  const scope = `[data-theme="${id}"]`;
  for (const prelude of rulePreludes(text)) {
    if (/^@(font-face|keyframes|-webkit-keyframes)\b/i.test(prelude)) continue;
    if (prelude.startsWith('@')) {
      problems.push(`${prelude.split(/\s/)[0]} is not allowed`);
      continue;
    }
    const parts = prelude.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0 || parts.some((p) => !p.includes(scope))) problems.push(`selector "${prelude.slice(0, 80)}" is not scoped to ${scope}`);
  }
  return problems;
}

/**
 * Preludes of the top-level rules, looking through `@media` / `@supports` / `@container`
 * groups (their rules count as top level). Rules nested inside a style rule are part of it.
 */
function rulePreludes(css: string): string[] {
  const out: string[] = [];
  // 'group' = a conditional group whose children are checked; 'opaque' = a rule's body.
  const stack: Array<'group' | 'opaque'> = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      i = end < 0 ? css.length : end;
      continue;
    }
    if (ch === '{') {
      const prelude = css.slice(start, i).trim();
      if (stack.includes('opaque')) stack.push('opaque');
      else if (/^@(media|supports|container)\b/i.test(prelude)) stack.push('group');
      else {
        out.push(prelude);
        stack.push('opaque');
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && !stack.includes('opaque')) {
      // A statement at-rule (e.g. `@import x;`) at group level.
      const stmt = css.slice(start, i).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
  }
  return out;
}
