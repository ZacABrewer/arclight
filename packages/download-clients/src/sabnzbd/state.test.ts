import { describe, expect, it } from 'vitest';
import {
  categoryOutputDir,
  mapHistorySlot,
  mapHistoryStatus,
  mapQueueSlot,
  mapQueueStatus,
  parseTimeLeft,
  removesCompletedDownloads,
} from './state.js';

describe('mapQueueStatus', () => {
  it.each([
    ['Downloading', false, 'downloading', undefined],
    ['Queued', false, 'queued', undefined],
    ['Paused', false, 'paused', undefined],
    ['Grabbing', false, 'queued', /fetching the NZB/],
    ['Fetching', false, 'queued', /recovery blocks/],
    ['Propagating', false, 'queued', /propagate/],
    ['Checking', false, 'downloading', /checking/],
    ['QuickCheck', false, 'downloading', /checking/],
    ['Downloading', true, 'paused', /queue is paused/],
    ['Queued', true, 'paused', /queue is paused/],
    ['Weird', false, 'downloading', /Unknown/],
  ] as const)('%s (queue paused: %s) -> %s', (raw, paused, status, message) => {
    const mapped = mapQueueStatus(raw, paused);
    expect(mapped.status).toBe(status);
    if (message === undefined) expect(mapped.message).toBeUndefined();
    else expect(mapped.message).toMatch(message);
  });
});

describe('mapHistoryStatus', () => {
  it.each([
    ['Completed', '', 'completed'],
    ['Failed', 'Aborted, cannot be completed - https://sabnzbd.org/not-complete', 'failed'],
    ['Failed', 'Unpacking failed, archive requires a password', 'failed'],
    ['Failed', '', 'failed'],
    ['Failed', 'Exit(1) Post-processing script returned an error', 'warning'],
    ['Failed', 'Unpacking failed, write error or disk is full?', 'warning'],
    ['Failed', '[Errno 28] No space left on device', 'warning'],
    ['Queued', '', 'downloading'],
    ['Verifying', '', 'downloading'],
    ['Repairing', '', 'downloading'],
    ['Extracting', '', 'downloading'],
    ['Moving', '', 'downloading'],
    ['Running', '', 'downloading'],
    ['QuickCheck', '', 'downloading'],
  ] as const)('%s "%s" -> %s', (raw, failMessage, status) => {
    expect(mapHistoryStatus(raw, failMessage).status).toBe(status);
  });

  it('labels post-processing and keeps the fail message', () => {
    expect(mapHistoryStatus('Extracting', '').message).toBe('Post-processing (Extracting)');
    expect(mapHistoryStatus('Failed', 'CRC error').message).toBe('CRC error');
  });
});

describe('parseTimeLeft', () => {
  it('parses h:mm:ss and d:hh:mm:ss, rejecting junk', () => {
    expect(parseTimeLeft('0:01:05')).toBe(65);
    expect(parseTimeLeft('12:00:00')).toBe(43_200);
    expect(parseTimeLeft('1:02:03:04')).toBe(93_784);
    expect(parseTimeLeft('unknown')).toBeUndefined();
    expect(parseTimeLeft(undefined)).toBeUndefined();
    expect(parseTimeLeft('999:00:00:00')).toBeUndefined();
  });
});

describe('slot mapping', () => {
  it('maps a downloading queue slot with MiB sizes and an ETA, not removable', () => {
    const item = mapQueueSlot(
      {
        nzo_id: 'SABnzbd_nzo_x',
        filename: 'Show.S01E01',
        cat: 'tv',
        mb: 100,
        mbleft: 25,
        percentage: 75,
        status: 'Downloading',
        timeleft: '0:00:30',
      },
      false,
    );
    expect(item).toEqual({
      id: 'SABnzbd_nzo_x',
      title: 'Show.S01E01',
      category: 'tv',
      totalBytes: 100 * 1024 * 1024,
      remainingBytes: 25 * 1024 * 1024,
      downloadedBytes: 75 * 1024 * 1024,
      progress: 0.75,
      status: 'downloading',
      outputPath: '',
      etaSeconds: 30,
      isReadOnly: false,
      canMoveFiles: false,
      canBeRemoved: false,
    });
  });

  it('maps completed history to an importable item at storage, and post-processing to not removable', () => {
    const done = mapHistorySlot({
      nzo_id: 'a',
      name: 'Show',
      category: 'tv',
      bytes: 1000,
      status: 'Completed',
      fail_message: '',
      storage: '/dl/complete/tv/Show',
    });
    expect(done).toMatchObject({
      status: 'completed',
      outputPath: '/dl/complete/tv/Show',
      progress: 1,
      etaSeconds: 0,
      isReadOnly: false,
      canMoveFiles: true,
      canBeRemoved: true,
    });
    const busy = mapHistorySlot({ nzo_id: 'b', name: 'Show', category: 'tv', bytes: 1000, status: 'Moving', storage: '/x' });
    expect(busy).toMatchObject({ status: 'downloading', outputPath: '', canBeRemoved: false, canMoveFiles: false });
    const noStorage = mapHistorySlot({ nzo_id: 'c', name: 'Show', status: 'Completed', storage: null });
    expect(noStorage.status).toBe('warning');
  });
});

describe('categoryOutputDir / removesCompletedDownloads', () => {
  const categories = [
    { name: 'tv', dir: 'tv-shows' },
    { name: 'abs', dir: '/mnt/abs/*' },
    { name: 'win', dir: 'D:\\Media' },
    { name: 'plain', dir: '' },
  ];

  it('resolves relative, absolute, starred and empty category folders', () => {
    const misc = { complete_dir: '/downloads/complete' };
    expect(categoryOutputDir(misc, categories, 'TV')).toBe('/downloads/complete/tv-shows');
    expect(categoryOutputDir(misc, categories, 'abs')).toBe('/mnt/abs');
    expect(categoryOutputDir(misc, categories, 'win')).toBe('D:\\Media');
    expect(categoryOutputDir(misc, categories, 'plain')).toBe('/downloads/complete');
    expect(categoryOutputDir(misc, categories, 'missing')).toBe('/downloads/complete');
    expect(categoryOutputDir(misc, categories, '')).toBe('/downloads/complete');
  });

  it('reads both the legacy and the 4.3+ history retention settings', () => {
    expect(removesCompletedDownloads({ history_retention: '' })).toBe(false);
    expect(removesCompletedDownloads({ history_retention: '0' })).toBe(false);
    expect(removesCompletedDownloads({ history_retention: 0 })).toBe(false);
    expect(removesCompletedDownloads({ history_retention: '-1' })).toBe(true);
    expect(removesCompletedDownloads({ history_retention: '7d' })).toBe(true);
    expect(removesCompletedDownloads({ history_retention_option: 'all', history_retention: '7d' })).toBe(false);
    expect(removesCompletedDownloads({ history_retention_option: 'days-delete' })).toBe(true);
    expect(removesCompletedDownloads({})).toBe(false);
  });
});
