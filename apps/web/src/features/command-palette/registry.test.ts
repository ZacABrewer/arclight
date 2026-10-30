import { afterEach, describe, expect, it, vi } from 'vitest';
import { Permission } from '@arclight/shared';
import { ADMIN_ACCESS, PORTAL_ACCESS, type Access } from '../../auth/access.js';
import { RECENT_KEY, RECENT_MAX, pushRecent, readRecent } from './recent.js';
import { acceptsItem, allowedActions, canRun, registerPaletteContext, type PaletteAction } from './registry.js';

const action = (permission: PaletteAction['permission'], id = permission): PaletteAction => ({ id, label: id, group: 'global', permission, run: () => {} });
const libraryUser: Access = { admin: false, areas: ['library'], permissions: 0 };
const requestManager: Access = { admin: false, areas: [], permissions: Permission.MANAGE_REQUESTS };

describe('permissions', () => {
  it('lets admins run everything', () => {
    for (const p of ['any', 'admin', 'library', 'requests'] as const) expect(canRun(action(p), ADMIN_ACCESS)).toBe(true);
  });

  it('gives portal users only the "any" actions', () => {
    expect(allowedActions([action('any'), action('admin'), action('library'), action('requests')], PORTAL_ACCESS).map((a) => a.id)).toEqual(['any']);
  });

  it('opens library pages for the Library area and request bulk actions for request managers', () => {
    expect(canRun(action('library'), libraryUser)).toBe(true);
    expect(canRun(action('admin'), libraryUser)).toBe(false);
    expect(canRun(action('requests'), requestManager)).toBe(true);
    expect(canRun(action('requests'), libraryUser)).toBe(false);
  });

  it('matches item kinds', () => {
    const a: PaletteAction = { ...action('admin'), target: { type: 'item', kinds: ['movie'] } };
    expect(acceptsItem(a, { kind: 'movie', id: 1, title: 'x' })).toBe(true);
    expect(acceptsItem(a, { kind: 'series', id: 1, title: 'x' })).toBe(false);
    expect(acceptsItem(action('admin'), { kind: 'movie', id: 1, title: 'x' })).toBe(false);
  });
});

describe('contextual registry', () => {
  it('adds and removes page entries', async () => {
    const { usePaletteContextEntries } = await import('./registry.js');
    expect(typeof usePaletteContextEntries).toBe('function');
    const remove = registerPaletteContext({ subject: { kind: 'movie', id: 7, title: 'Dune' } });
    // The store is module state; removal leaves nothing behind for other tests.
    remove();
  });
});

describe('recent actions', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the newest first, without duplicates, up to the maximum', () => {
    for (let i = 0; i < RECENT_MAX + 2; i += 1) pushRecent({ actionId: `a${i}` });
    pushRecent({ actionId: 'a3' });
    const list = readRecent();
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]?.actionId).toBe('a3');
    expect(list.filter((r) => r.actionId === 'a3')).toHaveLength(1);
  });

  it('remembers the target item and drops malformed entries', () => {
    pushRecent({ actionId: 'item.search', item: { kind: 'movie', id: 1, title: 'Dune' } });
    expect(readRecent()[0]?.item?.title).toBe('Dune');
    localStorage.setItem(RECENT_KEY, '{"not":"a list"}');
    expect(readRecent()).toEqual([]);
    localStorage.setItem(RECENT_KEY, 'not json');
    expect(readRecent()).toEqual([]);
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRecent()).toEqual([]);
    expect(pushRecent({ actionId: 'x' })).toEqual([{ actionId: 'x' }]);
  });
});
