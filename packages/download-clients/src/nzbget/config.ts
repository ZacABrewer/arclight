/** Helpers over NZBGet's `config` result (a flat list of `{Name, Value}` options). */
import { isRootedPath, joinRemotePath } from '../paths.js';
import type { NzbgetConfig } from './schemas.js';

export type NzbgetOptions = Map<string, string>;

/** Option names are case-insensitive in NZBGet; keys are lowercased. */
export function toOptions(config: NzbgetConfig): NzbgetOptions {
  const options: NzbgetOptions = new Map();
  for (const { Name, Value } of config) options.set(Name.toLowerCase(), Value);
  return options;
}

/**
 * Expands `${OptionName}` references (e.g. `${MainDir}/dst`) using other options, the way
 * NZBGet does when reading its config file. Unknown variables are left untouched.
 */
export function expandVariables(value: string, options: NzbgetOptions, depth = 0): string {
  if (depth > 10) return value;
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const replacement = options.get(name.trim().toLowerCase());
    return replacement === undefined ? whole : expandVariables(replacement, options, depth + 1);
  });
}

export function option(options: NzbgetOptions, name: string): string | undefined {
  const raw = options.get(name.toLowerCase());
  return raw === undefined ? undefined : expandVariables(raw, options);
}

/** Category names configured as Category1.Name .. CategoryN.Name, with their index. */
export function categoryIndex(options: NzbgetOptions, category: string): number | undefined {
  const wanted = category.toLowerCase();
  for (const [key, value] of options) {
    const match = /^category(\d+)\.name$/.exec(key);
    if (match && value.toLowerCase() === wanted) return Number(match[1]);
  }
  return undefined;
}

/**
 * Where NZBGet puts finished downloads of `category`: the category's own DestDir, else the
 * global DestDir (plus the category name when AppendCategoryDir is on, NZBGet's default).
 */
export function categoryDestDir(options: NzbgetOptions, category: string): string {
  const destDir = option(options, 'DestDir') ?? '';
  if (category === '') return destDir;
  const index = categoryIndex(options, category);
  const own = index === undefined ? '' : (option(options, `Category${index}.DestDir`) ?? '').trim();
  if (own !== '') return isRootedPath(own) || destDir === '' ? own : joinRemotePath(destDir, own);
  const append = (option(options, 'AppendCategoryDir') ?? 'yes').toLowerCase() !== 'no';
  if (!append || destDir === '') return destDir;
  const name = index === undefined ? category : (option(options, `Category${index}.Name`) ?? category);
  return joinRemotePath(destDir, name);
}

/** KeepHistory = 0 makes NZBGet drop finished items immediately, racing the import. */
export function removesCompletedDownloads(options: NzbgetOptions): boolean {
  const keep = option(options, 'KeepHistory');
  return keep !== undefined && Number(keep.trim()) === 0;
}
