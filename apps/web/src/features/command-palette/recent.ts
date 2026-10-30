import type { PaletteItem } from './registry.js';

// Recently run palette actions, kept on this device (localStorage). Storage may be missing or
// refuse writes (private windows, blocked site data): every access is guarded and the palette
// works without it.

export interface RecentAction {
  actionId: string;
  item?: PaletteItem | undefined;
  text?: string | undefined;
}

export const RECENT_KEY = 'arclight.palette.recent';
export const RECENT_MAX = 5;

const isItem = (v: unknown): v is PaletteItem =>
  typeof v === 'object' && v !== null && typeof (v as PaletteItem).id === 'number' && typeof (v as PaletteItem).title === 'string' && typeof (v as PaletteItem).kind === 'string';

export function readRecent(): RecentAction[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentAction => typeof r === 'object' && r !== null && typeof (r as RecentAction).actionId === 'string')
      .map((r) => ({ actionId: r.actionId, ...(isItem(r.item) ? { item: r.item } : {}), ...(typeof r.text === 'string' && r.text ? { text: r.text } : {}) }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

const same = (a: RecentAction, b: RecentAction) =>
  a.actionId === b.actionId && (a.item?.kind ?? '') === (b.item?.kind ?? '') && (a.item?.id ?? 0) === (b.item?.id ?? 0) && (a.text ?? '') === (b.text ?? '');

/** Puts `entry` first (dropping an equal older one) and returns the new list. */
export function pushRecent(entry: RecentAction): RecentAction[] {
  const next = [entry, ...readRecent().filter((r) => !same(r, entry))].slice(0, RECENT_MAX);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not stored: the list just stays as it was next time.
  }
  return next;
}
