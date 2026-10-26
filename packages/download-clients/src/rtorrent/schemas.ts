import { z } from 'zod';

/**
 * The `d.multicall2` columns we read, in order. rTorrent answers with one array per
 * torrent holding these values positionally.
 */
export const TORRENT_FIELDS = [
  'd.hash=',
  'd.name=',
  'd.custom1=',
  'd.size_bytes=',
  'd.left_bytes=',
  'd.completed_bytes=',
  'd.down.rate=',
  'd.base_path=',
  'd.directory=',
  'd.is_multi_file=',
  'd.state=',
  'd.is_active=',
  'd.complete=',
  'd.is_open=',
  'd.is_hash_checking=',
  'd.message=',
] as const;

const count = z.number().int().transform((n) => Math.max(0, n));
/** rTorrent reports booleans as integers 0/1. */
const flag = z.union([z.number(), z.boolean()]).transform((v) => v === true || (typeof v === 'number' && v !== 0));

export const RTorrentTorrentRow = z
  .tuple([
    z.string(), // hash (uppercase hex)
    z.string(), // name
    z.string(), // custom1 (label)
    count, // size_bytes
    count, // left_bytes
    count, // completed_bytes
    count, // down.rate (bytes/s)
    z.string(), // base_path ('' while the torrent is closed)
    z.string(), // directory
    flag, // is_multi_file
    flag, // state: 1 started, 0 stopped
    flag, // is_active: 0 when paused
    flag, // complete
    flag, // is_open
    flag, // is_hash_checking
    z.string(), // message (tracker / error message)
  ])
  .transform(
    ([hash, name, label, sizeBytes, leftBytes, completedBytes, downRate, basePath, directory, isMultiFile, started, active, complete, open, hashChecking, message]) => ({
      hash,
      name,
      label,
      sizeBytes,
      leftBytes,
      completedBytes,
      downRate,
      basePath,
      directory,
      isMultiFile,
      started,
      active,
      complete,
      open,
      hashChecking,
      message,
    }),
  );
export type RTorrentTorrent = z.output<typeof RTorrentTorrentRow>;

export const RTorrentTorrentList = z.array(RTorrentTorrentRow);

export const XmlRpcString = z.string();
