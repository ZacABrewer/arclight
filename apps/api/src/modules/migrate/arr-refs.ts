import { and, eq } from 'drizzle-orm';
import type { AreaEnv } from './areas.js';
import { migrateImported } from './schema.js';

/**
 * The single Arclight id that any Sonarr/Radarr import (any instance) recorded for an upstream
 * row, e.g. Seerr's "Sonarr profile 4" or Bazarr's "Sonarr series 12". Null when nothing or
 * more than one target matches (two instances with different meanings).
 */
export function importedFromArr(env: Pick<AreaEnv, 'db'>, app: 'sonarr' | 'radarr', area: string, sourceId: number | null): number | null {
  if (sourceId === null) return null;
  const rows = env.db
    .select({ targetId: migrateImported.targetId })
    .from(migrateImported)
    .where(and(eq(migrateImported.sourceApp, app), eq(migrateImported.area, area), eq(migrateImported.sourceId, String(sourceId))))
    .all();
  const ids = [...new Set(rows.map((r) => r.targetId).filter((x): x is number => x !== null))];
  return ids.length === 1 ? ids[0]! : null;
}
