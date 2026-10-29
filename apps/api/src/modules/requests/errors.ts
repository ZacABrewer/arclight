export type RequestsErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_CONFIGURED' | 'UPSTREAM';

/** Typed error for the requests module; routes map `code` to HTTP in one place. */
export class RequestsError extends Error {
  constructor(
    readonly code: RequestsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequestsError';
  }

  static notFound(what: string, id: number | string): RequestsError {
    return new RequestsError('NOT_FOUND', `${what} ${id} not found`);
  }

  static forbidden(message = 'you do not have permission to do that'): RequestsError {
    return new RequestsError('FORBIDDEN', message);
  }
}

export const REQUESTS_ERROR_STATUS: Record<RequestsErrorCode, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_CONFIGURED: 503,
  UPSTREAM: 502,
};

/** Music or audiobook routes while the feature flag is off: 404 with the module's own code. */
export class AudioDisabledError extends Error {
  readonly code: 'MUSIC_DISABLED' | 'AUDIOBOOKS_DISABLED';

  constructor(domain: 'music' | 'audiobook') {
    super(domain === 'music' ? 'music is not enabled (Settings → Features)' : 'audiobooks are not enabled (Settings → Features)');
    this.name = 'AudioDisabledError';
    this.code = domain === 'music' ? 'MUSIC_DISABLED' : 'AUDIOBOOKS_DISABLED';
  }
}
