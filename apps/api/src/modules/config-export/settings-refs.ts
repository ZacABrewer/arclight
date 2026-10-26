import type { RefKind, Refs } from './resources.js';

// Settings that hold ids of other resources. The document carries names instead, like every
// resource reference, so a file moves between installs whose ids differ. `*` walks an array.

interface SettingsRef {
  section: string;
  path: readonly string[];
  kind: RefKind;
  /** The leaf is an array of ids. */
  many?: boolean;
}

const requestTargets = ['movie', 'series', 'movie4k', 'series4k'];

export const SETTINGS_REFS: readonly SettingsRef[] = [
  ...requestTargets.flatMap((t): SettingsRef[] => [
    { section: 'requests', path: [t, 'qualityProfileId'], kind: 'qualityProfiles' },
    { section: 'requests', path: [t, 'tags'], kind: 'tags', many: true },
  ]),
  { section: 'importLists', path: ['cleanLibraryTags'], kind: 'tags', many: true },
  { section: 'subtitles', path: ['defaultSeriesProfileId'], kind: 'languageProfiles' },
  { section: 'subtitles', path: ['defaultMovieProfileId'], kind: 'languageProfiles' },
  { section: 'guides', path: ['profiles', '*', 'localQualityProfileId'], kind: 'qualityProfiles' },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy of `node` with `fn` applied to the value at `path` (missing paths are left alone). */
function mapAt(node: unknown, path: readonly string[], fn: (leaf: unknown, at: string) => unknown, at: string): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return fn(node, at);
  if (head === '*') {
    return Array.isArray(node) ? node.map((v, i) => mapAt(v, rest, fn, `${at}[${i}]`)) : node;
  }
  if (!isPlainObject(node) || !(head in node)) return node;
  return { ...node, [head]: mapAt(node[head], rest, fn, `${at}.${head}`) };
}

function eachRef(section: string, value: Record<string, unknown>, fn: (ref: SettingsRef, leaf: unknown, at: string) => unknown) {
  let out: unknown = value;
  for (const ref of SETTINGS_REFS) {
    if (ref.section !== section) continue;
    out = mapAt(out, ref.path, (leaf, at) => (ref.many && Array.isArray(leaf) ? leaf.map((v, i) => fn(ref, v, `${at}[${i}]`)) : fn(ref, leaf, at)), `settings.${section}`);
  }
  return out as Record<string, unknown>;
}

/** ids -> names (ids without a match stay numbers). */
export function settingsToNames(section: string, value: Record<string, unknown>, refs: Refs): Record<string, unknown> {
  return eachRef(section, value, (ref, leaf) => (typeof leaf === 'number' ? (refs.name(ref.kind, leaf) ?? leaf) : leaf));
}

export interface NameResolution {
  /** Id for a name that is not stored yet (defined elsewhere in the same document), or null. */
  pending?: (kind: RefKind, name: string) => number | null;
  onRef?: (kind: RefKind, name: string, at: string) => void;
  onUnknown?: (kind: RefKind, name: string, at: string) => void;
}

/** names -> ids; numbers pass through so hand-written ids keep working. */
export function settingsToIds(section: string, value: Record<string, unknown>, refs: Refs, res: NameResolution = {}): Record<string, unknown> {
  return eachRef(section, value, (ref, leaf, at) => {
    if (typeof leaf !== 'string') return leaf;
    res.onRef?.(ref.kind, leaf, at);
    const id = refs.id(ref.kind, leaf) ?? res.pending?.(ref.kind, leaf) ?? null;
    if (id === null) res.onUnknown?.(ref.kind, leaf, at);
    return id ?? leaf;
  });
}
