import type { MigrateArea } from '@arclight/shared';
import { HANDLERS, type AreaHandler, type AsyncAreaHandler, type AsyncHandlers, type Handlers } from './areas.js';
import { PROXY_HANDLERS } from './areas-indexer-proxies.js';
import { REQUEST_HANDLERS } from './areas-requests.js';
import { SUBTITLE_HANDLERS } from './areas-subtitles.js';
import { TORRENT_HANDLERS } from './areas-torrents.js';

// Every area handler in one place. Sync handlers run inside the area's transaction; async
// handlers (I/O beyond the database) run after them, outside any transaction.

export const ALL_HANDLERS: Handlers = { ...HANDLERS, ...PROXY_HANDLERS, ...SUBTITLE_HANDLERS, ...REQUEST_HANDLERS };
export const ASYNC_HANDLERS: AsyncHandlers = { ...TORRENT_HANDLERS };

export function syncHandler(area: MigrateArea): AreaHandler<MigrateArea> | undefined {
  return ALL_HANDLERS[area] as AreaHandler<MigrateArea> | undefined;
}

export function asyncHandler(area: MigrateArea): AsyncAreaHandler<MigrateArea> | undefined {
  return ASYNC_HANDLERS[area] as AsyncAreaHandler<MigrateArea> | undefined;
}
