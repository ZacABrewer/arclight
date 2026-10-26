export type LibraryErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'ROOT_FOLDER_INACCESSIBLE';

export class LibraryError extends Error {
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LibraryError';
  }

  static notFound(what: string, id: number | string): LibraryError {
    return new LibraryError('NOT_FOUND', `${what} ${id} not found`);
  }
}

export function httpStatusFor(code: LibraryErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'VALIDATION':
    case 'ROOT_FOLDER_INACCESSIBLE':
      return 400;
  }
}
