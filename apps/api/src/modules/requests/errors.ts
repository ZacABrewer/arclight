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
