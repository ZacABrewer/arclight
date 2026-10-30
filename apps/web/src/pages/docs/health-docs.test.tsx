import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTH_DOCS } from './health-docs-data.js';
import { filterHealthDocs } from './health-docs-page.js';

// vitest runs with apps/web as the working directory.
const apiModules = join(process.cwd(), '../api/src/modules/');

/** Every docs anchor the api's health checks pass to finding()/err(): a kebab-case string closing the call. */
function anchorsIn(source: string): string[] {
  return [...source.matchAll(/['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"],?\s*\)/g)].map((m) => m[1]!);
}

describe('health docs', () => {
  it('documents every anchor the health checks link to', () => {
    const files = [
      ...readdirSync(`${apiModules}health/checks`).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => `${apiModules}health/checks/${f}`),
      `${apiModules}updates/health.ts`,
      `${apiModules}media-analysis/health.ts`,
      `${apiModules}library-hygiene/index.ts`,
      `${apiModules}discord-bot/index.ts`,
      `${apiModules}subtitles/whisper.ts`,
    ];
    const anchors = new Set(files.flatMap((f) => anchorsIn(readFileSync(f, 'utf8'))));
    // update/container anchors are passed as constants in updates/health.ts
    anchors.add('update-available');
    anchors.add('container-updates-available');
    // tracker-stats/index.ts passes it through docsUrl()
    for (const m of readFileSync(`${apiModules}tracker-stats/index.ts`, 'utf8').matchAll(/docsUrl\('([a-z0-9-]+)'\)/g)) anchors.add(m[1]!);
    expect(anchors.size).toBeGreaterThan(25);
    const documented = new Set(HEALTH_DOCS.map((d) => d.anchor));
    expect([...anchors].filter((a) => !documented.has(a))).toEqual([]);
    expect(documented.size).toBe(HEALTH_DOCS.length);
  });

  it('documents the feed, ffprobe and orphan checks with in-app links', () => {
    const byAnchor = new Map(HEALTH_DOCS.map((d) => [d.anchor, d]));
    expect(byAnchor.get('feed-stale')?.link?.to).toBe('/system/feeds');
    expect(byAnchor.get('ffprobe-missing')?.sources).toEqual(['FfprobeMissing']);
    expect(byAnchor.get('orphan-files-found')?.link?.to).toBe('/library/hygiene');
  });

  it('filters by check id, title or text', () => {
    expect(filterHealthDocs('flaresolverr').map((d) => d.anchor)).toEqual(['flaresolverr-unreachable']);
    expect(filterHealthDocs('VpnDisconnected').map((d) => d.anchor)).toEqual(['vpn-disconnected', 'vpn-leak']);
    expect(filterHealthDocs('')).toHaveLength(HEALTH_DOCS.length);
  });
});
