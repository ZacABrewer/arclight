import { describe, expect, it } from 'vitest';
import { INDEXER_PROXY_SECRET_MASK } from '@media-tron/shared';
import { validateIndexerOptions, parseTagList } from '../indexer-options/indexer-options-page.js';
import { newProxy, proxyFields, toProxyBody } from './proxy-model.js';

describe('indexer proxy editor', () => {
  it('shows credentials only for network proxies', () => {
    expect(proxyFields('flaresolverr').map((f) => f.name)).not.toContain('password');
    expect(proxyFields('socks5').map((f) => f.name)).toEqual(expect.arrayContaining(['username', 'password']));
    expect(newProxy('flaresolverr')).toMatchObject({ port: 8191 });
  });

  it('keeps the stored password mask and drops credentials for FlareSolverr', () => {
    expect(toProxyBody({ name: ' p ', type: 'http', host: 'h', port: 3128, username: 'u', password: INDEXER_PROXY_SECRET_MASK, tags: [1] })).toEqual({
      name: 'p',
      type: 'http',
      host: 'h',
      port: 3128,
      username: 'u',
      password: INDEXER_PROXY_SECRET_MASK,
      tags: [1],
    });
    expect(toProxyBody({ name: 'f', type: 'flaresolverr', host: 'http://f', port: 8191, username: 'x', password: 'y', requestTimeout: 30 })).toEqual({
      name: 'f',
      type: 'flaresolverr',
      host: 'http://f',
      port: 8191,
      tags: [],
      requestTimeout: 30,
    });
  });
});

describe('indexer options form', () => {
  it('validates the RSS interval and parses subtitle tags', () => {
    const ok = { minimumAgeMinutes: 0, retentionDays: 0, maximumSizeMb: 0, rssSyncIntervalMinutes: 15, allowHardcodedSubs: false, whitelistedHardcodedSubs: [], preferIndexerFlags: false };
    expect(validateIndexerOptions(ok)).toEqual({});
    expect(validateIndexerOptions({ ...ok, rssSyncIntervalMinutes: 0 })).toEqual({});
    expect(validateIndexerOptions({ ...ok, rssSyncIntervalMinutes: 5 })).toHaveProperty('rssSyncIntervalMinutes');
    expect(validateIndexerOptions({ ...ok, retentionDays: -1 })).toHaveProperty('retentionDays');
    expect(parseTagList(' ENG, HC.ENG,,ENG ')).toEqual(['ENG', 'HC.ENG']);
  });
});
