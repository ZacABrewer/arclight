import type { z } from 'zod';

/**
 * Typed errors of the indexers module; routes.ts maps `code` to HTTP.
 * NO_MATCH: a search-page grab did not map to the library (retry with `force`).
 * UNAVAILABLE: the indexer no longer has the release (HTTP 404/410).
 * DOWNLOAD_FAILED: fetching the release file failed.
 */
export type IndexersErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'NO_MATCH' | 'UNAVAILABLE' | 'DOWNLOAD_FAILED';

export class IndexersError extends Error {
  constructor(
    public readonly code: IndexersErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IndexersError';
  }
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new IndexersError('VALIDATION', message, result.error.issues);
  }
  return result.data;
}
