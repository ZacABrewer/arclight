import { describe, expect, it } from 'vitest';
import prefsFixture from '../../fixtures/qbittorrent/preferences.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/qbittorrent/torrents-info.json' with { type: 'json' };
import type { DownloadItemStatus } from '../types.js';
import { QbtPreferences, QbtTorrentList, type QbtTorrent } from './schemas.js';
import { mapTorrent } from './state.js';

const prefs = QbtPreferences.parse(prefsFixture);
const torrents = QbtTorrentList.parse(torrentsFixture);
const NOW = 1_761_400_000_000;

function byState(state: string): QbtTorrent {
  const torrent = torrents.find((t) => t.state === state);
  if (!torrent) throw new Error(`fixture has no ${state} torrent`);
  return torrent;
}

describe('mapTorrent state mapping', () => {
  const cases: Array<[state: string, status: DownloadItemStatus, message?: RegExp]> = [
    ['downloading', 'downloading'],
    ['forcedDL', 'downloading'],
    ['moving', 'downloading', /moving/],
    ['metaDL', 'queued', /metadata/i],
    ['forcedMetaDL', 'queued', /metadata/i],
    ['stalledDL', 'warning', /stalled/i],
    ['pausedDL', 'paused'],
    ['stoppedDL', 'paused'],
    ['queuedDL', 'queued'],
    ['checkingDL', 'queued'],
    ['checkingResumeData', 'queued'],
    ['checkingUP', 'queued', /checking/],
    ['uploading', 'seeding'],
    ['stalledUP', 'seeding'],
    ['forcedUP', 'seeding'],
    ['queuedUP', 'seeding'],
    ['pausedUP', 'completed'],
    ['stoppedUP', 'completed'],
    ['error', 'warning', /error/],
    ['missingFiles', 'warning', /missing/],
    ['someFutureState', 'downloading', /Unknown qBittorrent state "someFutureState"/],
  ];

  it('covers every state in the fixture', () => {
    expect(cases.map(([s]) => s).sort()).toEqual(torrents.map((t) => t.state).sort());
  });

  it.each(cases)('%s → %s', (state, status, message) => {
    const item = mapTorrent(byState(state), { prefs, nowMs: NOW });
    expect(item.status).toBe(status);
    if (message) expect(item.statusMessage).toMatch(message);
    else expect(item.statusMessage).toBeUndefined();
  });

  it('reports metadata fetching as a warning when DHT is off', () => {
    const item = mapTorrent(byState('metaDL'), { prefs: { ...prefs, dht: false }, nowMs: NOW });
    expect(item.status).toBe('warning');
    expect(item.statusMessage).toMatch(/DHT is disabled/);
  });
});

describe('mapTorrent sizes, eta and paths', () => {
  it('normalizes id, sizes, progress and eta for an active download', () => {
    const item = mapTorrent(byState('downloading'), { prefs, nowMs: NOW });
    expect(item).toMatchObject({
      id: '0101010101010101010101010101010101010101',
      category: 'tv',
      totalBytes: 1_000_000_000,
      remainingBytes: 750_000_000,
      downloadedBytes: 250_000_000,
      progress: 0.25,
      etaSeconds: 1200,
      outputPath: '/downloads/tv/Show.Name.S01E01.1080p.WEB.h264-GRP',
      isReadOnly: false,
      canBeRemoved: false,
      canMoveFiles: false,
    });
  });

  it('drops qBittorrent\'s "infinite" eta and zeroes eta once finished', () => {
    expect(mapTorrent(byState('stalledDL'), { prefs, nowMs: NOW }).etaSeconds).toBeUndefined();
    expect(mapTorrent(byState('uploading'), { prefs, nowMs: NOW }).etaSeconds).toBe(0);
  });

  it('prefers content_path, then the derived path, then save_path', () => {
    const t = byState('pausedUP');
    expect(mapTorrent(t, { prefs, nowMs: NOW }).outputPath).toBe(t.content_path);
    const { content_path: _ignored, ...legacy } = t;
    expect(mapTorrent(legacy, { prefs, nowMs: NOW, fallbackOutputPath: '/x/y' }).outputPath).toBe('/x/y');
    expect(mapTorrent(legacy, { prefs, nowMs: NOW }).outputPath).toBe('/downloads/tv');
  });

  it('flags a finished torrent whose content path is the shared save path', () => {
    const t = { ...byState('stoppedUP'), content_path: '/downloads/tv/' };
    const item = mapTorrent(t, { prefs, nowMs: NOW });
    expect(item.status).toBe('warning');
    expect(item.statusMessage).toMatch(/subfolder/);
    expect(item.canBeRemoved).toBe(false);
  });
});

describe('mapTorrent seeding limits and removability', () => {
  const ratioPrefs: QbtPreferences = { ...prefs, max_ratio_enabled: true, max_ratio: 1 };

  it('keeps a seeding torrent read-only until its limit is met', () => {
    const item = mapTorrent(byState('uploading'), { prefs: ratioPrefs, nowMs: NOW });
    expect(item).toMatchObject({ status: 'seeding', isReadOnly: true, canBeRemoved: false, canMoveFiles: false });
  });

  it('treats a reached global ratio as completed and removable, even while still uploading', () => {
    const t = { ...byState('uploading'), ratio: 0.9995 };
    const item = mapTorrent(t, { prefs: ratioPrefs, nowMs: NOW });
    expect(item).toMatchObject({ status: 'completed', isReadOnly: false, canBeRemoved: true, canMoveFiles: true });
  });

  it('lets a per-torrent ratio limit override the global one', () => {
    const t = { ...byState('stoppedUP'), ratio: 0.6, ratio_limit: 0.5 };
    expect(mapTorrent(t, { prefs: ratioPrefs, nowMs: NOW }).canBeRemoved).toBe(true);
    const unlimited = { ...byState('stoppedUP'), ratio: 5, ratio_limit: -1, private: true };
    expect(mapTorrent(unlimited, { prefs: ratioPrefs, nowMs: NOW }).canBeRemoved).toBe(false);
  });

  it('honours seeding time from torrents/info or from properties', () => {
    const timePrefs: QbtPreferences = { ...prefs, max_seeding_time_enabled: true, max_seeding_time: 60 };
    const t = byState('stalledUP'); // seeding_time 3600s = 60 min
    expect(mapTorrent(t, { prefs: timePrefs, nowMs: NOW }).status).toBe('completed');
    const { seeding_time: _drop, ...noTime } = t;
    expect(mapTorrent(noTime, { prefs: timePrefs, nowMs: NOW }).canBeRemoved).toBe(false);
    expect(
      mapTorrent(noTime, { prefs: timePrefs, nowMs: NOW, extras: { seedingTimeSeconds: 4000 } }).canBeRemoved,
    ).toBe(true);
  });

  it('honours the inactive seeding time limit', () => {
    const t = { ...byState('stalledUP'), inactive_seeding_time_limit: 30, last_activity: NOW / 1000 - 31 * 60 };
    expect(mapTorrent(t, { prefs, nowMs: NOW }).canBeRemoved).toBe(true);
  });

  it('applies private-tracker semantics when no limits are configured', () => {
    // Public torrent the user stopped: nothing obliges seeding.
    expect(mapTorrent(byState('stoppedUP'), { prefs, nowMs: NOW })).toMatchObject({
      status: 'completed',
      isReadOnly: false,
      canBeRemoved: true,
    });
    // Private torrent: tracker requirements unknown, keep seeding.
    expect(mapTorrent(byState('pausedUP'), { prefs, nowMs: NOW })).toMatchObject({
      status: 'completed',
      isReadOnly: true,
      canBeRemoved: false,
      canMoveFiles: false,
    });
    // Unknown privacy is treated as private unless properties say otherwise.
    const { private: _p, ...unknown } = byState('stoppedUP');
    expect(mapTorrent(unknown, { prefs, nowMs: NOW }).canBeRemoved).toBe(false);
    expect(mapTorrent(unknown, { prefs, nowMs: NOW, extras: { isPrivate: false } }).canBeRemoved).toBe(true);
  });
});
