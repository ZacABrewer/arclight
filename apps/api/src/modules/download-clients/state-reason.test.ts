import { describe, expect, it } from 'vitest';
import { deriveState, formatBytes, type StateInput } from './state-reason.js';

const base: StateInput = {
  state: 'downloading',
  clientStatus: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  progress: 0.4,
  clientName: 'Built-in',
};
const derive = (extra: Partial<StateInput>) => deriveState({ ...base, ...extra });

describe('deriveState', () => {
  it('explains a healthy download with its peers', () => {
    expect(derive({ live: { downloadRate: 1, uploadRate: 0, connectedPeers: 4, connectedSeeds: 1 } })).toEqual({
      code: 'downloading',
      severity: 'ok',
      reason: 'Downloading from 4 peers (1 seed).',
    });
    expect(derive({})).toMatchObject({ code: 'downloading', reason: 'Downloading.' });
  });

  it('shows copy progress while an import copies into the library', () => {
    const r = derive({ state: 'importing', importCopy: { copiedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, bytesPerSecond: 50 * 1024 ** 2 } });
    expect(r).toMatchObject({ code: 'importing', severity: 'info' });
    expect(r.reason).toMatch(/^Copying into the library: 2\.0 GiB of 8\.0 GiB \(50\.0 MiB\/s\)/);
    expect(derive({ state: 'importing' }).reason).toBe('Importing into the library.');
  });

  it('says the engine is starting instead of unreachable while it restores torrents', () => {
    const r = derive({ engineStarting: true, clientError: 'The built-in torrent engine is not running.' });
    expect(r).toMatchObject({ code: 'checking', severity: 'info' });
    expect(r.reason).toContain('starting up');
  });

  it('puts the kill switch before the paused client status, with the engine reason', () => {
    const r = derive({ clientStatus: 'paused', killSwitch: { reason: 'VPN disconnected: timeout.' } });
    expect(r).toMatchObject({ code: 'killSwitch', severity: 'error' });
    expect(r.reason).toContain('(VPN disconnected: timeout)');
    expect(derive({ clientStatus: 'paused' })).toMatchObject({ code: 'paused', severity: 'info', reason: 'Paused in Built-in.' });
  });

  it('reports metadata, checking, moving and queue-slot waits', () => {
    expect(derive({ phase: 'metadata', live: { downloadRate: 0, uploadRate: 0, connectedPeers: 0 } }).reason).toBe(
      'Waiting for the torrent metadata from peers (0 peers connected).',
    );
    expect(derive({ phase: 'checking', clientStatus: 'queued' }).code).toBe('checking');
    expect(derive({ phase: 'moving' }).code).toBe('moving');
    expect(derive({ clientStatus: 'queued', maxActiveDownloads: 3 }).reason).toContain('at most 3 active');
    expect(derive({ clientStatus: 'queued' }).reason).toBe('Queued in Built-in.');
  });

  it('flags stalls, missing peers and low disk space', () => {
    const stalled = derive({ stalledSince: '2026-01-01T00:00:00Z', stallMinutes: 10, live: { downloadRate: 0, uploadRate: 0, connectedPeers: 2, connectedSeeds: 0 } });
    expect(stalled).toMatchObject({ code: 'stalled', severity: 'warning' });
    expect(stalled.reason).toBe('No new data received for 10+ minutes. 2 peers connected, 0 seeds.');
    expect(derive({ live: { downloadRate: 0, uploadRate: 0, connectedPeers: 0, swarmSeeds: 0 } })).toMatchObject({
      code: 'noPeers',
      reason: 'No peers connected yet. Trackers report 0 seeds in the swarm.',
    });
    expect(derive({ diskShortfall: 3 * 1024 ** 3 })).toMatchObject({ code: 'diskSpace', severity: 'error' });
    expect(derive({ diskShortfall: 3 * 1024 ** 3 }).reason).toContain('3.0 GiB short');
  });

  it('reports client trouble before anything else the client said', () => {
    expect(derive({ clientError: 'ECONNREFUSED', clientStatus: 'paused' })).toMatchObject({
      code: 'clientUnavailable',
      reason: 'Built-in is unreachable: ECONNREFUSED',
    });
    expect(derive({ clientStatus: 'unknown' }).code).toBe('missing');
    expect(derive({ clientStatus: 'failed', statusMessages: [{ title: 'x', messages: ['Disk I/O error'] }] })).toMatchObject({
      code: 'error',
      reason: 'Disk I/O error',
    });
    expect(derive({ clientStatus: 'warning', trackedStatus: 'warning', statusMessages: [{ title: 'x', messages: ['All trackers failed'] }] })).toMatchObject({
      code: 'warning',
      reason: 'All trackers failed',
    });
  });

  it('follows the pipeline states after the download', () => {
    expect(derive({ state: 'pending', clientStatus: 'unknown' }).code).toBe('pendingGrab');
    expect(derive({ state: 'pending', trackedStatus: 'warning', statusMessages: [{ title: 'x', messages: ['Delayed by profile'] }] })).toMatchObject({
      code: 'pendingGrab',
      severity: 'warning',
      reason: 'Delayed by profile',
    });
    expect(derive({ state: 'importPending', clientStatus: 'completed' }).code).toBe('importPending');
    expect(derive({ state: 'importPending', trackedStatus: 'warning', statusMessages: [{ title: 'x', messages: ['Sample only'] }] })).toMatchObject({
      code: 'importBlocked',
      reason: 'Sample only',
    });
    expect(derive({ state: 'importing' }).code).toBe('importing');
    expect(derive({ state: 'failedPending' }).code).toBe('error');
    expect(derive({ clientStatus: 'seeding', progress: 1 }).code).toBe('completed');
  });

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
  });
});
