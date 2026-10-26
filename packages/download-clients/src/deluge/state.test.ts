import { describe, expect, it } from 'vitest';
import hostStatus13 from '../../fixtures/deluge/host-status-1.3.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/deluge/torrents-status.json' with { type: 'json' };
import { parseHostStatus } from './rpc.js';
import { DelugeTorrentMap, DelugeTorrentStatus, type DelugeConfigValues } from './schemas.js';
import { mapTorrent } from './state.js';

const config: DelugeConfigValues = { stop_seed_at_ratio: false, stop_seed_ratio: 2, remove_seed_at_ratio: false };

function torrent(overrides: Record<string, unknown>): DelugeTorrentStatus {
  return DelugeTorrentStatus.parse({
    name: 'Release',
    state: 'Downloading',
    progress: 50,
    eta: 100,
    is_finished: false,
    download_location: '/data',
    total_size: 1000,
    total_done: 500,
    ratio: 0,
    ...overrides,
  });
}

describe('mapTorrent state table', () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    status: string;
    readOnly: boolean;
    removable: boolean;
    message?: RegExp;
  }> = [
    { name: 'downloading', input: {}, status: 'downloading', readOnly: false, removable: false },
    { name: 'paused, unfinished', input: { state: 'Paused' }, status: 'paused', readOnly: false, removable: false },
    { name: 'queued, unfinished', input: { state: 'Queued' }, status: 'queued', readOnly: false, removable: false },
    {
      name: 'queued, finished (waiting to seed)',
      input: { state: 'Queued', is_finished: true, progress: 100 },
      status: 'seeding',
      readOnly: true,
      removable: false,
    },
    {
      name: 'seeding below the stop ratio',
      input: { state: 'Seeding', is_finished: true, ratio: 0.5, stop_at_ratio: true, stop_ratio: 1 },
      status: 'seeding',
      readOnly: true,
      removable: false,
    },
    {
      name: 'seeding at the stop ratio',
      input: { state: 'Seeding', is_finished: true, ratio: 0.9995, stop_at_ratio: true, stop_ratio: 1 },
      status: 'completed',
      readOnly: false,
      removable: true,
    },
    {
      name: 'seeding with no ratio limit',
      input: { state: 'Seeding', is_finished: true, ratio: 9 },
      status: 'seeding',
      readOnly: true,
      removable: false,
    },
    {
      name: 'paused and finished',
      input: { state: 'Paused', is_finished: true },
      status: 'completed',
      readOnly: false,
      removable: true,
    },
    {
      name: 'checking a finished torrent',
      input: { state: 'Checking', is_finished: true, progress: 100 },
      status: 'queued',
      readOnly: false,
      removable: false,
      message: /checking/,
    },
    { name: 'allocating', input: { state: 'Allocating' }, status: 'queued', readOnly: false, removable: false, message: /allocating/ },
    {
      name: 'moving a finished torrent',
      input: { state: 'Moving', is_finished: true },
      status: 'downloading',
      readOnly: false,
      removable: false,
      message: /moving/,
    },
    {
      name: 'error',
      input: { state: 'Error', message: 'Error: disk full' },
      status: 'warning',
      readOnly: false,
      removable: false,
      message: /disk full/,
    },
    { name: 'unknown state', input: { state: 'Weird' }, status: 'downloading', readOnly: false, removable: false, message: /Unknown/ },
  ];

  for (const c of cases) {
    it(`maps ${c.name}`, () => {
      const item = mapTorrent('ABCDEF', torrent(c.input), { config });
      expect(item.status).toBe(c.status);
      expect(item.isReadOnly).toBe(c.readOnly);
      expect(item.canBeRemoved).toBe(c.removable);
      expect(item.canMoveFiles).toBe(c.removable);
      if (c.message) expect(item.statusMessage).toMatch(c.message);
      else expect(item.statusMessage).toBeUndefined();
    });
  }

  it('uses the global stop ratio when the torrent has no own setting', () => {
    const t = torrent({ state: 'Seeding', is_finished: true, ratio: 2.1 });
    expect(mapTorrent('a', t, { config }).status).toBe('seeding');
    expect(mapTorrent('a', t, { config: { ...config, stop_seed_at_ratio: true } }).status).toBe('completed');
  });

  it('computes sizes, eta, ids and output paths from the fixture', () => {
    const map = DelugeTorrentMap.parse(torrentsFixture);
    const items = Object.entries(map).map(([hash, t]) => mapTorrent(hash, t, { config }));
    const downloading = items.find((i) => i.id === '1111111111111111111111111111111111111111');
    expect(downloading).toMatchObject({
      title: 'Show.S01E01.1080p.WEB.h264-GRP',
      category: 'tv',
      totalBytes: 2_000_000_000,
      remainingBytes: 1_150_000_000,
      downloadedBytes: 850_000_000,
      progress: 0.425,
      etaSeconds: 600,
      outputPath: '/downloads/Show.S01E01.1080p.WEB.h264-GRP',
    });
    const singleFile = items.find((i) => i.id === '2222222222222222222222222222222222222222');
    expect(singleFile).toMatchObject({ etaSeconds: 0, remainingBytes: 0, outputPath: '/downloads/Show.S01E02.1080p.WEB.h264-GRP.mkv' });
    const queued = items.find((i) => i.id === '6666666666666666666666666666666666666666');
    expect(queued?.etaSeconds).toBeUndefined();
    expect(items.find((i) => i.id.startsWith('3'))?.outputPath).toBe('/downloads/completed/Show.S01E03.1080p.WEB.h264-GRP');
  });

  it('falls back to the 1.3 save_path field and lowercases the hash', () => {
    const t = DelugeTorrentStatus.parse({ name: 'X', state: 'Downloading', save_path: 'D:\\Torrents' });
    const item = mapTorrent('ABCDEF0123', t, { config });
    expect(item.id).toBe('abcdef0123');
    expect(item.outputPath).toBe('D:\\Torrents\\X');
  });
});

describe('parseHostStatus', () => {
  it('reads both the 2.x and the 1.3 row layout', () => {
    expect(parseHostStatus('h', ['h', 'Online', '2.1.1'])).toEqual({ status: 'Online', version: '2.1.1' });
    expect(parseHostStatus('c0ffee0123456789abcdef0123456789', hostStatus13)).toEqual({ status: 'Online', version: '1.3.15' });
    expect(parseHostStatus('h', null)).toEqual({ status: undefined, version: undefined });
  });
});
