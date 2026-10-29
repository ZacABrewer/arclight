import type { BulkRequestResult } from '@arclight/shared';

/**
 * Runs one request/issue action per id, in order, as the same actor: each id is checked on its
 * own (ownership, permissions, state), so a refused id is reported and the rest still run.
 */
export async function eachId(ids: readonly number[], fn: (id: number) => unknown): Promise<BulkRequestResult> {
  const result: BulkRequestResult = { ok: [], failed: [] };
  for (const id of new Set(ids)) {
    try {
      await fn(id);
      result.ok.push(id);
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
