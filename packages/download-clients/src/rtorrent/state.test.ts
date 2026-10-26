import { describe, expect, it } from 'vitest';
import type { RTorrentTorrent } from './schemas.js';
import { decodeLabel, encodeLabel, mapTorrent, outputPathOf } from './state.js';

function torrent(overrides: Partial<RTorrentTorrent> = {}): RTorrentTorrent {
  return {
    hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    name: 'Show.S01E01',
    label: 'tv',
    sizeBytes: 1000,
    leftBytes: 250,
    completedBytes: 750,
    downRate: 50,
    basePath: '/data/Show.S01E01',
    directory: '/data/Show.S01E01',
    isMultiFile: true,
    started: true,
    active: true,
    complete: false,
    open: true,
    hashChecking: false,
    message: '',
    ...overrides,
  };
}

describe('mapTorrent state table', () => {
  const cases: Array<[string, Partial<RTorrentTorrent>, string, boolean, boolean]> = [
    // name, flags, status, isReadOnly, canBeRemoved
    ['downloading', {}, 'downloading', false, false],
    ['paused (started, inactive)', { active: false }, 'paused', false, false],
    ['stopped, incomplete', { started: false, active: false }, 'paused', false, false],
    ['seeding', { complete: true, leftBytes: 0 }, 'seeding', true, false],
    ['seeding but paused', { complete: true, leftBytes: 0, active: false }, 'seeding', true, false],
    ['stopped and complete', { complete: true, leftBytes: 0, started: false, active: false }, 'completed', false, true],
    ['hash checking a finished torrent', { complete: true, leftBytes: 0, hashChecking: true }, 'queued', false, false],
    ['magnet metadata', { sizeBytes: 0, leftBytes: 0, completedBytes: 0 }, 'queued', false, false],
    ['tracker error, nothing downloading', { message: 'Tracker: [Timeout was reached]', downRate: 0 }, 'warning', false, false],
    ['tracker error while downloading', { message: 'Tracker: [Timeout was reached]' }, 'downloading', false, false],
  ];

  it.each(cases)('%s', (_name, overrides, status, readOnly, removable) => {
    const item = mapTorrent(torrent(overrides));
    expect(item.status).toBe(status);
    expect(item.isReadOnly).toBe(readOnly);
    expect(item.canBeRemoved).toBe(removable);
    expect(item.canMoveFiles).toBe(removable);
  });

  it('maps ids, sizes, progress and eta', () => {
    const item = mapTorrent(torrent());
    expect(item.id).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(item).toMatchObject({ totalBytes: 1000, remainingBytes: 250, downloadedBytes: 750, progress: 0.75, etaSeconds: 5 });
    expect(mapTorrent(torrent({ downRate: 0 })).etaSeconds).toBeUndefined();
    expect(mapTorrent(torrent({ complete: true, leftBytes: 0 })).etaSeconds).toBe(0);
    expect(mapTorrent(torrent({ complete: true, leftBytes: 0 })).progress).toBe(1);
  });

  it('keeps tracker messages on finished torrents without changing status', () => {
    const item = mapTorrent(torrent({ complete: true, leftBytes: 0, message: 'Tracker: [Timeout]' }));
    expect(item.status).toBe('seeding');
    expect(item.statusMessage).toBe('Tracker: [Timeout]');
  });
});

describe('outputPathOf', () => {
  it('prefers base_path, else rebuilds it from directory', () => {
    expect(outputPathOf(torrent())).toBe('/data/Show.S01E01');
    expect(outputPathOf(torrent({ basePath: '', isMultiFile: true, directory: '/data/Pack' }))).toBe('/data/Pack');
    expect(outputPathOf(torrent({ basePath: '', isMultiFile: false, directory: '/data', name: 'a.mkv' }))).toBe('/data/a.mkv');
    expect(outputPathOf(torrent({ basePath: '', isMultiFile: false, directory: 'D:\\dl', name: 'a.mkv' }))).toBe('D:\\dl\\a.mkv');
  });
});

describe('labels', () => {
  it('URI-encodes like ruTorrent and decodes tolerantly', () => {
    expect(encodeLabel('TV Shows')).toBe('TV%20Shows');
    expect(encodeLabel('media-tron')).toBe('media-tron');
    expect(decodeLabel('TV%20Shows')).toBe('TV Shows');
    expect(decodeLabel('100%')).toBe('100%');
    expect(mapTorrent(torrent({ label: 'Movies%20UHD' })).category).toBe('Movies UHD');
  });
});
