import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASE_THEME_ID, THEME_IMAGE_EXTENSIONS, THEME_LIMITS, ThemeManifest, checkThemeCss, compareThemeVersions, type ThemeInfo } from '@arclight/shared';

// Theme packs on disk. Two roots: the packs bundled with the app (`themes/` in the repository,
// `/app/themes` in the image) and the ones the sync downloaded (`<config>/themes`). A pack is a
// directory `<id>/` with theme.json, theme.css, optional fonts/*.woff2 and optional background
// images (images/*.webp|png|jpg|avif, checked by their first bytes); it is only offered when
// all of it validates. When both roots have a pack, the newer version wins (equal: the synced one,
// which is what the repository publishes now).

export interface ThemePack {
  manifest: ThemeManifest;
  dir: string;
  source: 'bundled' | 'synced';
  /** Font file names (`fonts/<name>.woff2`) the pack ships. */
  fonts: ReadonlySet<string>;
  /** Background image file names (`images/<name>.<ext>`) the pack ships. */
  images: ReadonlySet<string>;
}

const IMAGE_NAME = new RegExp(`^[A-Za-z0-9._-]{1,80}[.](${THEME_IMAGE_EXTENSIONS.join('|')})$`);

/** Content type of a pack image, by extension. */
export function imageType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

/** True when the bytes start like the image type the name claims, so HTML or SVG cannot pass as one. */
function looksLikeImage(name: string, head: Buffer): boolean {
  const type = imageType(name);
  if (type === 'image/png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === 'image/webp') return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  return head.toString('latin1', 4, 12) === 'ftypavif';
}

export class ThemePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemePackError';
  }
}

/** Where the bundled packs are: ARCLIGHT_THEMES_DIR, the image path, or the repository's `themes/`. */
export function bundledThemesDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.ARCLIGHT_THEMES_DIR, '/app/themes', resolve('themes'), resolve('../../themes')];
  for (const dir of candidates) if (dir && existsSync(join(dir))) return resolve(dir);
  return null;
}

/** Reads and validates the pack in `dir`; throws ThemePackError with the first problem. */
export function readPack(dir: string, id: string, source: ThemePack['source']): ThemePack {
  const parsed = ThemeManifest.safeParse(JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8')));
  if (!parsed.success) throw new ThemePackError(`theme.json: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const manifest = parsed.data;
  if (manifest.id !== id) throw new ThemePackError(`theme.json names "${manifest.id}" but the folder is "${id}"`);
  if (manifest.id === BASE_THEME_ID) throw new ThemePackError(`"${BASE_THEME_ID}" is the built-in theme`);
  const cssPath = join(dir, 'theme.css');
  const cssSize = statSync(cssPath).size;
  if (cssSize > THEME_LIMITS.cssBytes) throw new ThemePackError(`theme.css is larger than ${THEME_LIMITS.cssBytes} bytes`);
  const fonts = new Set<string>();
  let total = cssSize;
  const fontDir = join(dir, 'fonts');
  if (existsSync(fontDir)) {
    for (const name of readdirSync(fontDir)) {
      if (!/^[A-Za-z0-9._-]{1,80}\.woff2$/.test(name)) continue;
      const size = statSync(join(fontDir, name)).size;
      if (size > THEME_LIMITS.fontBytes) throw new ThemePackError(`fonts/${name} is larger than ${THEME_LIMITS.fontBytes} bytes`);
      total += size;
      fonts.add(`fonts/${name}`);
    }
  }
  const images = new Set<string>();
  const imageDir = join(dir, 'images');
  if (existsSync(imageDir)) {
    for (const name of readdirSync(imageDir)) {
      if (!IMAGE_NAME.test(name)) continue;
      const path = join(imageDir, name);
      const size = statSync(path).size;
      if (size > THEME_LIMITS.imageBytes) throw new ThemePackError(`images/${name} is larger than ${THEME_LIMITS.imageBytes} bytes`);
      if (!looksLikeImage(name, readFileSync(path).subarray(0, 16))) throw new ThemePackError(`images/${name} is not a ${imageType(name)} file`);
      total += size;
      images.add(`images/${name}`);
    }
  }
  if (total > THEME_LIMITS.packBytes) throw new ThemePackError(`the pack is larger than ${THEME_LIMITS.packBytes} bytes`);
  const problems = checkThemeCss(readFileSync(cssPath, 'utf8'), id, new Set([...fonts, ...images]));
  if (problems.length > 0) throw new ThemePackError(`theme.css: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  return { manifest, dir, source, fonts, images };
}

export interface PackProblem {
  id: string;
  source: ThemePack['source'];
  error: string;
}

/** Every valid pack under `root`, plus the problems of the ones that are not. */
export function readPacks(root: string | null, source: ThemePack['source']): { packs: ThemePack[]; problems: PackProblem[] } {
  const packs: ThemePack[] = [];
  const problems: PackProblem[] = [];
  if (!root || !existsSync(root)) return { packs, problems };
  for (const id of readdirSync(root)) {
    if (id.startsWith('.') || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue;
    const dir = join(root, id);
    if (!statSync(dir).isDirectory()) continue;
    try {
      packs.push(readPack(dir, id, source));
    } catch (err) {
      problems.push({ id, source, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { packs, problems };
}

/** Bundled and synced packs merged by id: the newer version wins, a tie goes to the synced copy. */
export function mergePacks(bundled: readonly ThemePack[], synced: readonly ThemePack[]): Map<string, ThemePack> {
  const out = new Map<string, ThemePack>();
  for (const p of bundled) out.set(p.manifest.id, p);
  for (const p of synced) {
    const have = out.get(p.manifest.id);
    if (!have || compareThemeVersions(p.manifest.version, have.manifest.version) >= 0) out.set(p.manifest.id, p);
  }
  return out;
}

export const TRON_INFO: ThemeInfo = Object.freeze({
  id: BASE_THEME_ID,
  name: 'Tron',
  version: '1.0.0',
  description: 'The Arclight look: dark glass, cyan light and a grid horizon.',
  author: 'Arclight',
  colorScheme: 'dark',
  backdrop: 'tron',
  swatches: ['#02090c', '#6ef6ff', '#ff9a4d', '#ff5a46'],
  source: 'builtin',
  css: null,
}) as ThemeInfo;

export function packInfo(p: ThemePack): ThemeInfo {
  const m = p.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    colorScheme: m.colorScheme,
    backdrop: m.backdrop,
    swatches: [...m.swatches],
    source: p.source,
    css: `theme/${m.id}/theme.css?v=${m.version}`,
  };
}
