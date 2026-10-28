// Errors the imports routes map to HTTP statuses (routes.ts). Kept apart from service.ts so the
// music importer (audio/music-import.ts) can throw them without importing the service.

export type ImportsErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class ImportsError extends Error {
  constructor(
    readonly code: ImportsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportsError';
  }
}
