import { describe, expect, it, vi } from 'vitest';
import { KEYS } from '../config.js';
import { memoryStore } from './kv.js';
import { ServerStore, serverForUrl } from './servers.js';

function store(kv = memoryStore()) {
  let n = 0;
  return { kv, s: new ServerStore(kv, () => `id${++n}`, () => new Date('2026-01-01T00:00:00Z')) };
}

describe('ServerStore', () => {
  it('adds, selects, de-duplicates and persists', async () => {
    const { kv, s } = store();
    const a = await s.add('http://192.168.1.20:7878/');
    expect(a).toEqual({ id: 'id1', name: '192.168.1.20', url: 'http://192.168.1.20:7878', addedAt: '2026-01-01T00:00:00.000Z' });
    const b = await s.add('https://arclight.example.com', 'Cabin');
    expect((await s.selected())?.id).toBe(b.id);
    const again = await s.add('HTTP://192.168.1.20:7878', 'Home');
    expect(again.id).toBe('id1');
    expect((await s.list()).map((x) => x.name)).toEqual(['Home', 'Cabin']);
    expect((await s.selected())?.id).toBe('id1');
    expect(JSON.parse(kv.data.get(KEYS.servers)!)).toMatchObject({ version: 1, selectedId: 'id1' });
    expect(await new ServerStore(kv).list()).toHaveLength(2);
  });

  it('renames, changes address, removes and reselects', async () => {
    const { s } = store();
    const a = await s.add('http://nas:7878');
    const b = await s.add('https://b.example.com');
    await s.rename(a.id, '  Living room ');
    await s.rename(b.id, '   ');
    expect((await s.list()).map((x) => x.name)).toEqual(['Living room', 'b.example.com']);
    await s.updateUrl(b.id, 'https://c.example.com/');
    expect(await s.get(b.id)).toMatchObject({ url: 'https://c.example.com', name: 'c.example.com' });
    await expect(s.updateUrl(b.id, 'http://nas:7878')).rejects.toThrow(/already/);
    await s.select(b.id);
    await s.remove(b.id);
    expect((await s.selected())?.id).toBe(a.id);
    await s.remove(a.id);
    expect(await s.selected()).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it('notifies listeners and survives corrupt storage', async () => {
    const { kv, s } = store(memoryStore({ [KEYS.servers]: '{not json' }));
    expect(await s.list()).toEqual([]);
    const listener = vi.fn();
    s.onChange(listener);
    await s.add('http://nas');
    expect(listener).toHaveBeenCalledWith([expect.objectContaining({ url: 'http://nas' })]);
    kv.data.set(KEYS.servers, JSON.stringify({ version: 1, servers: [{ id: 'x', name: 'x', url: 'http://x', addedAt: '' }], selectedId: 'gone' }));
    expect((await s.selected())?.id).toBe('x');
  });
});

describe('serverForUrl', () => {
  const servers = [
    { id: 'root', name: 'r', url: 'https://a.example.com', addedAt: '' },
    { id: 'sub', name: 's', url: 'https://a.example.com/arc', addedAt: '' },
    { id: 'lan', name: 'l', url: 'http://nas:7878', addedAt: '' },
  ];
  it('matches by origin and longest base path', () => {
    expect(serverForUrl(servers, 'https://a.example.com/arc/requests/1')?.id).toBe('sub');
    expect(serverForUrl(servers, 'https://a.example.com/archive')?.id).toBe('root');
    expect(serverForUrl(servers, 'http://nas:7878/portal')?.id).toBe('lan');
    expect(serverForUrl(servers, 'http://nas/portal')).toBeNull();
    expect(serverForUrl(servers, 'not a url')).toBeNull();
  });
});
