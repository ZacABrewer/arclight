import { readLimited } from '@arclight/net';

/** Largest .torrent accepted from an indexer download link. */
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;
/** Largest .nzb accepted (very large season packs run to a few MB). */
export const MAX_NZB_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Read a downloaded release file with a byte cap, cancelling the stream as soon as it passes
 * the cap. Throws `SafeFetchError('tooLarge')` from @arclight/net.
 */
export async function readReleaseFile(res: Response, protocol: 'torrent' | 'usenet'): Promise<Uint8Array> {
  return new Uint8Array(await readLimited(res, protocol === 'usenet' ? MAX_NZB_FILE_BYTES : MAX_TORRENT_FILE_BYTES));
}
