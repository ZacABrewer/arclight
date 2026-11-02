import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { appOrigin, basePath, withBase } from './base-path.js';

// Sub-path hosting: the base path the server writes into the page, and the URLs built from it.

function setBase(content: string | null) {
  document.head.querySelectorAll('meta[name="arclight-base"]').forEach((m) => m.remove());
  if (content === null) return;
  const meta = document.createElement('meta');
  meta.name = 'arclight-base';
  meta.content = content;
  document.head.appendChild(meta);
}

afterEach(() => {
  setBase(null);
  vi.resetModules();
});

describe('basePath', () => {
  it('is empty without the meta tag (root, dev server)', () => {
    expect(basePath()).toBe('');
    expect(withBase('/api/v1/system/ping')).toBe('/api/v1/system/ping');
    expect(appOrigin('https://example.com/')).toBe('https://example.com');
  });

  it('reads the server-written meta tag', () => {
    setBase('/arclight');
    expect(basePath()).toBe('/arclight');
    setBase('/apps/arclight/');
    expect(basePath()).toBe('/apps/arclight');
  });

  it('ignores a malformed tag', () => {
    for (const bad of ['arclight', '/../x', '/a b', 'https://example.com/x', '/a?b', '/']) {
      setBase(bad);
      expect(basePath(), bad).toBe('');
    }
  });
});

describe('withBase / appOrigin', () => {
  it('prefixes app paths and leaves full URLs alone', () => {
    expect(withBase('/api/v1/auth/oidc/main/start', '/arclight')).toBe('/arclight/api/v1/auth/oidc/main/start');
    expect(withBase('/', '/arclight')).toBe('/arclight/');
    expect(withBase('https://example.com/x', '/arclight')).toBe('https://example.com/x');
    expect(withBase('//example.com/x', '/arclight')).toBe('//example.com/x');
    expect(withBase('relative', '/arclight')).toBe('relative');
  });

  it('reads the page base by default', () => {
    setBase('/arclight');
    expect(withBase('/sw.js')).toBe('/arclight/sw.js');
    expect(appOrigin('https://example.com')).toBe('https://example.com/arclight');
  });

  it('puts the api client below the base', async () => {
    setBase('/arclight');
    const { API_BASE, buildUrl } = await import('../api/client.js');
    expect(API_BASE).toBe('/arclight/api/v1');
    expect(buildUrl('/series', { page: 2 })).toBe('/arclight/api/v1/series?page=2');
    const { eventsUrl } = await import('../api/events.js');
    expect(eventsUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/arclight/api/v1/events');
    const { logStreamUrl } = await import('../api/logs.js');
    expect(logStreamUrl({ protocol: 'http:', host: 'example.com' })).toBe('ws://example.com/arclight/api/v1/log/stream');
  });
});

describe('router below a base path', () => {
  it('strips the base before the portal mapping and adds it back to links', async () => {
    const { createAppRouter } = await import('../router.js');
    window.history.pushState(null, '', '/arclight/watch/requests');
    try {
      const router = createAppRouter(new QueryClient(), { mode: 'path', base: '/watch' }, '/arclight');
      expect(router.state.location.pathname).toBe('/portal/requests');
      expect(router.buildLocation({ to: '/portal/requests' }).publicHref).toBe('/arclight/watch/requests');
      expect(router.buildLocation({ to: '/library/tv' }).publicHref).toBe('/arclight/library/tv');
    } finally {
      window.history.pushState(null, '', '/');
    }
  });

  it('keeps root links unchanged without a base', async () => {
    const { createAppRouter } = await import('../router.js');
    const router = createAppRouter(new QueryClient(), null, '');
    expect(router.buildLocation({ to: '/library/tv' }).publicHref).toBe('/library/tv');
  });
});
