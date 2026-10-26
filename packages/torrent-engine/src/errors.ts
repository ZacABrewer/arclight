/** Error codes raised by the torrent engine. */
export type TorrentEngineErrorCode =
  | 'bencode'
  | 'metainfo'
  | 'magnet'
  | 'tracker'
  | 'dht'
  | 'peer'
  | 'storage'
  | 'session'
  | 'timeout'
  | 'aborted';

/** Typed error thrown by every layer of the engine. */
export class TorrentEngineError extends Error {
  override readonly name = 'TorrentEngineError';
  readonly code: TorrentEngineErrorCode;

  constructor(code: TorrentEngineErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
