export type ImportListsErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

/** Service errors; routes map them to HTTP in one place. */
export class ImportListsError extends Error {
  constructor(
    readonly code: ImportListsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportListsError';
  }

  static notFound(what: string, id: number | string): ImportListsError {
    return new ImportListsError('NOT_FOUND', `${what} ${id} not found`);
  }
}

export type ImportListFetchErrorCode = 'not-configured' | 'auth' | 'not-found' | 'unreachable' | 'rate-limited' | 'bad-response';

/** A provider could not fetch its list. Reported per list on sync, as `error` on test. */
export class ImportListFetchError extends Error {
  constructor(
    readonly code: ImportListFetchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ImportListFetchError';
  }
}
