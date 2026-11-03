import { describe, expect, it } from 'vitest';
import { book, track } from '@web/features/player/test-utils';
import { DownloadIndex, entryProgress, entryStatus, memoryIndexFile, type DownloadEntry, type DownloadedFile } from './download-index';

function file(taskId: string, over: Partial<DownloadedFile> = {}): DownloadedFile {
  return { taskId, destName: `${taskId}.audio`, status: 'queued', bytesWritten: 0, totalBytes: 1000, ...over };
}

function entry(accountId: string, item = track(1), over: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    accountId,
    itemKey: item.itemKey,
    item,
    parts: item.parts.map((_, i) => file(`${accountId}:${item.itemKey}#${i}`)),
    artwork: file(`${accountId}:art:album-1`),
    quality: 'original',
    addedAt: new Date().toISOString(),
    ...over,
  };
}

describe('DownloadIndex', () => {
  it('tracks native progress per part and reports one status per item', async () => {
    const idx = new DownloadIndex(memoryIndexFile());
    await idx.load();
    const b = book();
    await idx.put(entry('a', b));
    const [p0, p1] = idx.get('a', b.itemKey)!.parts;
    await idx.updateTask(p0!.taskId, { status: 'completed', bytesWritten: 1000, path: '/data/p0.mp3' });
    let e = idx.get('a', b.itemKey)!;
    expect(entryStatus(e)).toBe('downloading');
    expect(entryProgress(e)).toBeCloseTo(0.5);
    expect(idx.localPart('a', b.itemKey, 0)).toBe('/data/p0.mp3');
    expect(idx.localPart('a', b.itemKey, 1)).toBeNull();
    expect(idx.offlineItem('a', b.itemKey)).toBeNull();

    await idx.updateTask(p1!.taskId, { status: 'completed', bytesWritten: 1000, path: '/data/p1.mp3' });
    e = idx.get('a', b.itemKey)!;
    expect(entryStatus(e)).toBe('completed');
    expect(idx.offlineItem('a', b.itemKey)?.title).toBe(b.title);
  });

  it('a failed part fails the item', async () => {
    const idx = new DownloadIndex(memoryIndexFile());
    await idx.load();
    const b = book();
    await idx.put(entry('a', b));
    await idx.updateTask(idx.get('a', b.itemKey)!.parts[1]!.taskId, { status: 'failed', error: 'HTTP 500' });
    expect(entryStatus(idx.get('a', b.itemKey)!)).toBe('failed');
  });

  it('shares album artwork between tracks and points offline items at the local copy', async () => {
    const idx = new DownloadIndex(memoryIndexFile());
    await idx.load();
    const t1 = track(1, { artworkUrl: 'https://music.example.com/api/v1/playback/artwork/album/1?sig=x' });
    const t2 = track(2);
    await idx.put(entry('a', t1));
    await idx.put(entry('a', t2));
    expect(idx.isShared('a:art:album-1', { accountId: 'a', itemKey: t1.itemKey })).toBe(true);
    await idx.updateTask('a:art:album-1', { status: 'completed', uri: 'file:///data/album-1.jpg' });
    for (const t of [t1, t2]) await idx.updateTask(`a:${t.itemKey}#0`, { status: 'completed', path: `/data/${t.itemKey}` });
    expect(idx.offlineItem('a', t1.itemKey, (u) => `web:${u}`)?.artworkUrl).toBe('web:file:///data/album-1.jpg');
    expect(idx.get('a', t2.itemKey)!.artwork?.status).toBe('completed');
  });

  it('keeps accounts apart and persists across restarts', async () => {
    const f = memoryIndexFile();
    const idx = new DownloadIndex(f);
    await idx.load();
    await idx.put(entry('a', track(1)));
    await idx.put(entry('b', track(1)));
    await idx.put(entry('b', track(2)));
    await idx.flush();
    const again = new DownloadIndex(f);
    await again.load();
    expect(again.all('a')).toHaveLength(1);
    expect(again.all('b')).toHaveLength(2);
    await again.remove('b', track(2).itemKey);
    expect(again.all()).toHaveLength(2);
  });

  it('starts empty from a corrupt index', async () => {
    const idx = new DownloadIndex(memoryIndexFile('{not json'));
    await idx.load();
    expect(idx.all()).toEqual([]);
  });
});
