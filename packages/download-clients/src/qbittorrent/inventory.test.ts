import { beforeEach, describe, expect, it } from 'vitest';
import { createQBittorrentInventory } from '../index.js';
import { DownloadClientError } from '../types.js';
import { FakeQBittorrent } from './fake-qbittorrent.js';

let qbt: FakeQBittorrent;

const TORRENT = {
  hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
  name: 'Show.S01',
  category: 'tv-sonarr',
  tags: 'a, b',
  save_path: '/data/downloads/tv',
  content_path: '/data/downloads/tv/Show.S01',
  size: 1000,
  total_size: 1200,
  progress: 1,
  amount_left: 0,
  state: 'stalledUP',
  added_on: 1_700_000_000,
  completion_on: 1_700_000_500,
  uploaded: 5000,
  downloaded: 1000,
  ratio_limit: -2,
  seeding_time_limit: -1,
  seeding_time: 3600,
  tracker: 'https://tracker.example/announce',
};

function inventory() {
  return createQBittorrentInventory({ baseUrl: 'http://qbt:8080/', username: 'admin', password: 'secret' }, { fetch: qbt.fetch });
}

beforeEach(() => {
  qbt = new FakeQBittorrent();
  qbt.on('GET', '/api/v2/torrents/info', { body: [TORRENT] });
  qbt.on('GET', '/api/v2/torrents/files', { body: [{ name: 'Show.S01/e1.mkv', size: 1000, priority: 1, progress: 1, index: 0 }] });
  qbt.on('GET', '/api/v2/torrents/export', () => new Response(new Uint8Array([100, 101]), { status: 200 }));
  qbt.on('POST', '/api/v2/torrents/stop', { body: '' });
  qbt.on('POST', '/api/v2/torrents/pause', { body: '' });
  qbt.on('POST', '/api/v2/torrents/delete', { body: '' });
});

describe('QBittorrentInventory', () => {
  it('logs in and lists every torrent with totals, tags, dates and limits', async () => {
    const inv = inventory();
    expect(await inv.version()).toEqual({ app: '5.0.2', api: '2.11.2' });
    const [t] = await inv.torrents();
    expect(t).toMatchObject({ category: 'tv-sonarr', tags: 'a, b', uploaded: 5000, seeding_time: 3600, ratio_limit: -2, completion_on: 1_700_000_500 });
    expect(qbt.calls('/api/v2/torrents/info')[0]!.query.get('category')).toBeNull();
    expect(await inv.files(TORRENT.hash)).toHaveLength(1);
    expect(qbt.calls('/api/v2/torrents/files')[0]!.query.get('hash')).toBe(TORRENT.hash.toLowerCase());
  });

  it('exports a .torrent as bytes and refuses on qBittorrent older than 4.5', async () => {
    expect([...(await inventory().exportTorrent(TORRENT.hash))]).toEqual([100, 101]);
    qbt.on('GET', '/api/v2/app/webapiVersion', { body: '2.8.3' });
    const err = await inventory().exportTorrent(TORRENT.hash).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadClientError);
    expect((err as DownloadClientError).message).toMatch(/4\.5 or newer/);
  });

  it('stops on qBittorrent 5, pauses on 4.x, and removes without deleting files', async () => {
    await inventory().pause(['AA', 'BB']);
    expect(qbt.calls('/api/v2/torrents/stop')[0]!.form).toEqual({ hashes: 'aa|bb' });
    qbt.on('GET', '/api/v2/app/webapiVersion', { body: '2.8.19' });
    await inventory().pause(['CC']);
    expect(qbt.calls('/api/v2/torrents/pause')[0]!.form).toEqual({ hashes: 'cc' });
    await inventory().removeKeepFiles(['DD']);
    expect(qbt.calls('/api/v2/torrents/delete')[0]!.form).toEqual({ hashes: 'dd', deleteFiles: 'false' });
    await inventory().pause([]);
    expect(qbt.calls('/api/v2/torrents/stop')).toHaveLength(1);
  });
});
