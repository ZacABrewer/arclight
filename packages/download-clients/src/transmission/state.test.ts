import { describe, expect, it } from 'vitest';
import sessionFixture from '../../fixtures/transmission/session-get.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/transmission/torrent-get.json' with { type: 'json' };
import type { DownloadItemStatus } from '../types.js';
import { TrSession, TrTorrentGet, type TrTorrent } from './schemas.js';
import { categoryOf, effectiveSeedLimits, mapTorrent, type CategoryContext } from './state.js';

const session = TrSession.parse(sessionFixture.arguments);
const torrents = TrTorrentGet.parse(torrentsFixture.arguments).torrents;
const NOW = 1_761_400_000_000;
const labelsContext: CategoryContext = { useLabels: true, baseDir: '/downloads/complete', requested: 'arclight', knownCategories: [] };

function torrent(n: number): TrTorrent {
  const hash = 'a' + '0'.repeat(39 - String(n).length) + n;
  const found = torrents.find((t) => t.hashString === hash);
  if (!found) throw new Error(`fixture has no torrent ${n}`);
  return found;
}

function map(t: TrTorrent, s: TrSession = session) {
  return mapTorrent(t, { session: s, nowMs: NOW, category: labelsContext });
}

describe('mapTorrent', () => {
  const cases: Array<[n: number, status: DownloadItemStatus, readOnly: boolean, removable: boolean, message?: RegExp]> = [
    [1, 'downloading', false, false],
    [2, 'paused', false, false],
    [3, 'queued', false, false],
    [4, 'queued', false, false, /verifying/],
    [5, 'seeding', true, false],
    [6, 'completed', false, true],
    [7, 'completed', false, true],
    [8, 'completed', false, true],
    [9, 'completed', true, false],
    [10, 'warning', false, false, /Tracker error: Tracker gave HTTP response code 404/],
    [11, 'warning', false, false, /Transmission error: No data found/],
    [13, 'completed', false, true],
    [14, 'warning', true, false, /Tracker warning/],
  ];

  it.each(cases)('torrent %i -> %s (readOnly %s, removable %s)', (n, status, readOnly, removable, message) => {
    const item = map(torrent(n));
    expect(item.status).toBe(status);
    expect(item.isReadOnly).toBe(readOnly);
    expect(item.canBeRemoved).toBe(removable);
    expect(item.canMoveFiles).toBe(removable);
    if (message) expect(item.statusMessage).toMatch(message);
    else expect(item.statusMessage).toBeUndefined();
  });

  it('maps sizes, progress, eta and output path', () => {
    const downloading = map(torrent(1));
    expect(downloading).toMatchObject({
      id: torrent(1).hashString,
      title: 'Show.S01E01.1080p.WEB.h264-GRP.mkv',
      category: 'arclight',
      totalBytes: 1_500_000_000,
      remainingBytes: 1_125_000_000,
      downloadedBytes: 375_000_000,
      progress: 0.25,
      etaSeconds: 600,
      outputPath: '/downloads/complete/Show.S01E01.1080p.WEB.h264-GRP.mkv',
    });
    expect(map(torrent(3)).etaSeconds).toBeUndefined();
    expect(map(torrent(7)).etaSeconds).toBe(0);
    expect(map(torrent(7)).outputPath).toBe('/downloads/complete/Show.S01.1080p.WEB.h264-GRP');
  });

  it('applies the global ratio limit when the torrent defers to it', () => {
    const limited = TrSession.parse({ ...sessionFixture.arguments, seedRatioLimited: true, seedRatioLimit: 3 });
    expect(effectiveSeedLimits(torrent(5), limited)).toEqual({}); // mode 2 = unlimited
    const seeding = { ...torrent(14), error: 0, uploadRatio: 3.2 };
    expect(map(seeding, limited).status).toBe('completed');
    expect(map({ ...seeding, uploadRatio: 1 }, limited)).toMatchObject({ status: 'seeding', isReadOnly: true });
    // The stopped public torrent now has an obligation (ratio 3, at 0), so it stays read-only.
    expect(map(torrent(8), limited)).toMatchObject({ status: 'completed', isReadOnly: true, canBeRemoved: false });
  });

  it('derives the category from labels or, without labels, from the download directory', () => {
    expect(categoryOf(torrent(12), { ...labelsContext, requested: '' })).toBe('other');
    const dirContext: CategoryContext = { useLabels: false, baseDir: '/downloads/complete', requested: '', knownCategories: ['arclight'] };
    expect(categoryOf({ ...torrent(1), downloadDir: '/downloads/complete/arclight/' }, dirContext)).toBe('arclight');
    expect(categoryOf(torrent(1), dirContext)).toBe('');
  });
});
