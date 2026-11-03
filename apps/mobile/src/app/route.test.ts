import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, type Route } from './route.js';

describe('hash routes', () => {
  it('parses what the shell and error page send', () => {
    expect(parseRoute('')).toEqual({ name: 'auto' });
    expect(parseRoute('#/servers')).toEqual({ name: 'servers' });
    expect(parseRoute('#/unreachable')).toEqual({ name: 'unreachable' });
    expect(parseRoute('#/add?url=http%3A%2F%2Fnas%3A7878')).toEqual({ name: 'add', url: 'http://nas:7878' });
    expect(parseRoute('#/edit/abc')).toEqual({ name: 'edit', id: 'abc' });
    expect(parseRoute('#/nope')).toEqual({ name: 'auto' });
  });
  it('round-trips', () => {
    const routes: Route[] = [{ name: 'servers' }, { name: 'add', url: 'https://a.example.com/x' }, { name: 'edit', id: 'id 1' }, { name: 'open', id: 'id 2', path: '/requests/12?tab=a' }, { name: 'settings' }, { name: 'about' }, { name: 'licenses' }];
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
  });
});
