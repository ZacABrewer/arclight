import { useEffect, useSyncExternalStore } from 'react';
import { hasAnyPermission, Permission } from '@arclight/shared';
import type { Access } from '../../auth/access.js';

// The command palette's action registry. Every action is a fixed entry of this shape: typed text
// only ever selects among them (and picks a library item or passes a name to an add flow); it
// is never evaluated. Pages add contextual entries while they are mounted (usePaletteContext).

/** Library items an action can target. */
export type ItemKind = 'movie' | 'series' | 'artist' | 'author' | 'book';

export interface PaletteItem {
  kind: ItemKind;
  id: number;
  title: string;
  year?: number | null | undefined;
}

/**
 * Who may run an action. `any`: every signed-in person; `admin`; `library`: admins or people
 * granted the Library area (read-only, so only opening pages); `requests`: admins or people with
 * the Manage requests permission.
 */
export type ActionPermission = 'any' | 'admin' | 'library' | 'requests';

/** What the typed text after the verb is: a library item, or a free-text name (add flows). */
export type ActionTarget = { type: 'item'; kinds: readonly ItemKind[] } | { type: 'text' };

export type ActionGroup = 'item' | 'global' | 'navigate' | 'task' | 'theme' | 'context';

export interface RunContext {
  item?: PaletteItem | undefined;
  text?: string | undefined;
}

export interface PaletteAction {
  /** Stable id (recent actions are stored by it). */
  id: string;
  /** Verb label ("Search for upgrades", "Go to Settings › Indexers"). */
  label: string;
  /** Extra words the matcher accepts ("upgrade", "cutoff"). Never shown. */
  keywords?: readonly string[] | undefined;
  group: ActionGroup;
  target?: ActionTarget | undefined;
  permission: ActionPermission;
  /** Bulk or destructive: the palette asks before running. */
  destructive?: boolean | undefined;
  /** The confirm question; defaults to the label. */
  confirm?: ((ctx: RunContext) => string) | undefined;
  /** Secondary text on the row. */
  meta?: string | undefined;
  hint?: string | undefined;
  run: (ctx: RunContext) => unknown;
}

/** True when `access` may run `action`. */
export function canRun(action: Pick<PaletteAction, 'permission'>, access: Access): boolean {
  switch (action.permission) {
    case 'any':
      return true;
    case 'admin':
      return access.admin;
    case 'library':
      return access.admin || access.areas.includes('library');
    case 'requests':
      return access.admin || hasAnyPermission(access.permissions, [Permission.MANAGE_REQUESTS]);
  }
}

/** The actions `access` may run, in registry order. */
export function allowedActions(actions: readonly PaletteAction[], access: Access): PaletteAction[] {
  return actions.filter((a) => canRun(a, access));
}

/** Whether `action` takes `item` as its target. */
export function acceptsItem(action: PaletteAction, item: PaletteItem): boolean {
  return action.target?.type === 'item' && action.target.kinds.includes(item.kind);
}

// ---------------------------------------------------------------------------------------
// Contextual entries (pages register while mounted)
// ---------------------------------------------------------------------------------------

export interface PaletteContextEntry {
  /** The item the page shows: every item action applies to it with no name typed. */
  subject?: PaletteItem | undefined;
  /** Extra page-specific actions, listed first. */
  actions?: readonly PaletteAction[] | undefined;
}

const entries = new Map<symbol, PaletteContextEntry>();
const listeners = new Set<() => void>();
let snapshot: readonly PaletteContextEntry[] = [];

function emit() {
  snapshot = [...entries.values()];
  for (const l of listeners) l();
}

/** Adds an entry; returns its removal. Plain function for tests and non-React callers. */
export function registerPaletteContext(entry: PaletteContextEntry): () => void {
  const key = Symbol('palette-context');
  entries.set(key, entry);
  emit();
  return () => {
    entries.delete(key);
    emit();
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Every registered entry, newest last. */
export function usePaletteContextEntries(): readonly PaletteContextEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * Registers the page's subject (and optional actions) while the page is mounted, e.g. a movie page
 * passes `{ subject: { kind: 'movie', id, title } }` so "Search for upgrades" needs no name.
 * Pass `null` while the data is loading.
 */
export function usePaletteContext(entry: PaletteContextEntry | null): void {
  const s = entry?.subject;
  const key = s ? `${s.kind}:${s.id}:${s.title}` : '';
  const actions = entry?.actions;
  useEffect(() => {
    if (!entry || (!entry.subject && !entry.actions?.length)) return;
    return registerPaletteContext(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-register when the subject or the action list changes
  }, [key, actions]);
}
