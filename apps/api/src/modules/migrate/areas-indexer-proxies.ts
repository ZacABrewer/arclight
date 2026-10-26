import { eq } from 'drizzle-orm';
import * as t from '../../db/schema.js';
import { ProxiesService } from '../indexers/proxies.js';
import { resolveRef, SkipItem, type AreaEnv, type Handlers } from './areas.js';
import type { IndexerProxyPayload, SourceItem } from './types.js';

// Prowlarr indexer proxies (FlareSolverr, HTTP, SOCKS5) applied to Arclight's indexer proxies.
// Tags carry over, so a proxy keeps applying to the indexers that share its tags (Arclight
// matches proxies to indexers by tag the same way Prowlarr does).

function proxiesService(env: AreaEnv): ProxiesService {
  return new ProxiesService({ db: env.db });
}

function tagsOf(env: AreaEnv, item: SourceItem<IndexerProxyPayload>): number[] {
  const out: number[] = [];
  for (const sid of item.payload.sourceTagIds) {
    const id = resolveRef(env, 'tags', sid);
    if (id === null) env.warn('indexerProxies', `${item.name}: tag ${sid} could not be mapped and was dropped`, item.sourceId);
    else if (!out.includes(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

export const PROXY_HANDLERS: Handlers = {
  indexerProxies: {
    find: (env, item) => {
      const name = item.payload.create.name.toLowerCase();
      const row = env.db.select({ id: t.indexerProxies.id, name: t.indexerProxies.name }).from(t.indexerProxies).all().find((r) => r.name.toLowerCase() === name);
      return row ? { id: row.id, reason: `indexer proxy "${row.name}" exists` } : null;
    },
    create: (env, item) => {
      if (!item.payload.create.host) throw new SkipItem('proxy has no host');
      return proxiesService(env).create({ ...item.payload.create, tags: tagsOf(env, item) }).id;
    },
    overwrite: (env, item, existing) => {
      const current = env.db.select().from(t.indexerProxies).where(eq(t.indexerProxies.id, existing.id!)).get();
      if (!current) throw new SkipItem('proxy disappeared');
      return proxiesService(env).update(existing.id!, { ...item.payload.create, tags: tagsOf(env, item) }).id;
    },
  },
};
