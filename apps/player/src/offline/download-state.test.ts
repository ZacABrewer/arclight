import { describe, expect, it } from 'vitest';
import { book, track } from '@web/features/player/test-utils';
import { DownloadIndex, memoryIndexFile, type DownloadEntry, type DownloadedFile } from './download-index';
import { itemDownloadState } from './download-state';

function file(taskId: string, over: Partial<DownloadedFile> = {}): DownloadedFile {
  return { taskId, destName: `${taskId}.audio`, status: 'queued', bytesWritten: 0, totalBytes: 1000, ...over };
}

function entry(item = track(1)): DownloadEntry {
  return { accountId: 'a', itemKey: item.itemKey, item, parts: item.parts.map((_, i) => file(`a:${item.itemKey}#${i}`)), artwork: null, quality: 'original', addedAt: new Date().toISOString() };
}

describe('itemDownloadState', () => {
  it('maps the index entry to what the Download buttons show', async () => {
    const idx = new DownloadIndex(memoryIndexFile());
    await idx.load();
    expect(itemDownloadState(idx, 'a', 'track:1')).toBe('none');
    expect(itemDownloadState(idx, 'a', 'track:1', new Set(['track:1']))).toBe('queued');

    const b = book();
    await idx.put(entry(b));
    expect(itemDownloadState(idx, 'a', b.itemKey)).toBe('queued');
    await idx.updateTask(`a:${b.itemKey}#0`, { status: 'completed', bytesWritten: 1000, path: '/data/p0.mp3' });
    expect(itemDownloadState(idx, 'a', b.itemKey)).toBe('downloading');
    await idx.updateTask(`a:${b.itemKey}#1`, { status: 'completed', bytesWritten: 1000, path: '/data/p1.mp3' });
    expect(itemDownloadState(idx, 'a', b.itemKey)).toBe('done');
    // Another account's downloads are not this one's.
    expect(itemDownloadState(idx, 'b', b.itemKey)).toBe('none');

    await idx.put(entry(track(2)));
    await idx.updateTask('a:track:2#0', { status: 'failed', error: 'HTTP 500' });
    expect(itemDownloadState(idx, 'a', 'track:2')).toBe('none');

    await idx.put(entry(track(3)));
    await idx.updateTask('a:track:3#0', { status: 'waiting' });
    expect(itemDownloadState(idx, 'a', 'track:3')).toBe('waiting');
  });
});
