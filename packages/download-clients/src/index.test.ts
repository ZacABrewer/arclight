import { describe, expect, it } from 'vitest';
import {
  createDownloadClient,
  createQBittorrentClient,
  DelugeSettings,
  DownloadClientError,
  DownloadClientKind,
  downloadClientProtocols,
  downloadClientSettingsSchemas,
  NzbgetSettings,
  RTorrentSettings,
  SabnzbdSettings,
  TransmissionSettings,
  type DownloadClient,
} from './index.js';

const fetchStub: typeof globalThis.fetch = async () => new Response('', { status: 500 });
const QBT = { host: 'h', port: 8080, useSsl: false, username: '', password: '', category: 'tv' };

describe('createDownloadClient', () => {
  it('creates every kind with the right protocol', () => {
    const clients: Array<[DownloadClientKind, DownloadClient]> = [
      ['qbittorrent', createDownloadClient('qbittorrent', QBT, { fetch: fetchStub })],
      ['transmission', createDownloadClient('transmission', { host: 'h' }, { fetch: fetchStub })],
      ['deluge', createDownloadClient('deluge', { host: 'h' }, { fetch: fetchStub })],
      ['rtorrent', createDownloadClient('rtorrent', { host: 'h' }, { fetch: fetchStub })],
      ['sabnzbd', createDownloadClient('sabnzbd', { host: 'h', apiKey: 'k' }, { fetch: fetchStub })],
      ['nzbget', createDownloadClient('nzbget', { host: 'h' }, { fetch: fetchStub })],
      ['builtin', createDownloadClient('builtin', {})],
    ];
    for (const [kind, client] of clients) {
      expect(client.protocol, kind).toBe(downloadClientProtocols[kind]);
      expect(client.name.length).toBeGreaterThan(0);
    }
    expect(DownloadClientKind.options).toEqual(Object.keys(downloadClientSettingsSchemas));
  });

  it('rejects unknown kinds and invalid settings', () => {
    expect(() => createDownloadClient('vuze' as DownloadClientKind, { host: 'h' } as never)).toThrow();
    expect(() => createDownloadClient('transmission', { host: '' })).toThrow();
  });

  it('describes every new settings field for the UI and fills defaults', () => {
    for (const schema of [TransmissionSettings, DelugeSettings, RTorrentSettings, SabnzbdSettings, NzbgetSettings]) {
      for (const [key, field] of Object.entries(schema.shape)) {
        expect(field.description, key).toBeTruthy();
      }
    }
    expect(TransmissionSettings.parse({ host: 'h' })).toMatchObject({ port: 9091, useSsl: false, category: 'arclight' });
    expect(NzbgetSettings.parse({ host: 'h' })).toMatchObject({ port: 6789, username: 'nzbget' });
  });

  it('makes torrent clients refuse NZBs and usenet clients refuse torrents', async () => {
    const nzb = { nzb: new Uint8Array([1]), title: 't', category: 'tv' };
    const torrentClients = [
      createQBittorrentClient(QBT, { fetch: fetchStub }),
      createDownloadClient('transmission', { host: 'h' }, { fetch: fetchStub }),
      createDownloadClient('deluge', { host: 'h' }, { fetch: fetchStub }),
      createDownloadClient('rtorrent', { host: 'h' }, { fetch: fetchStub }),
      createDownloadClient('builtin', {}),
    ];
    for (const client of torrentClients) {
      await expect(client.addNzb?.(nzb)).rejects.toMatchObject({ code: 'not-supported' });
    }
    const magnet = { magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, title: 't', category: 'tv' };
    for (const client of [
      createDownloadClient('sabnzbd', { host: 'h', apiKey: 'k' }, { fetch: fetchStub }),
      createDownloadClient('nzbget', { host: 'h' }, { fetch: fetchStub }),
    ]) {
      const error = await client.addTorrent(magnet).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).code).toBe('not-supported');
    }
  });
});
