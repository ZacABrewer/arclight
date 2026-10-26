import { describe, expect, it } from 'vitest';
import { isLocalhostAddress, joinRemotePath } from './paths.js';
import { bytes, V1_TORRENT, V1_TORRENT_HASH } from './test-support.js';
import { hashFromMagnet, hashFromTorrentFile, TorrentParseError } from './torrent-hash.js';

const encoder = new TextEncoder();

describe('hashFromMagnet', () => {
  it('reads hex and base32 btih topics as lowercase hex', () => {
    expect(hashFromMagnet('magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=x')).toBe(
      'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    );
    expect(hashFromMagnet('magnet:?dn=x&xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK')).toBe(
      'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    );
  });

  it('falls back to the truncated v2 multihash and rejects garbage', () => {
    const v2 = 'a'.repeat(64);
    expect(hashFromMagnet(`magnet:?xt=urn:btmh:1220${v2}`)).toBe('a'.repeat(40));
    expect(hashFromMagnet('magnet:?dn=no-topic')).toBeUndefined();
    expect(hashFromMagnet('https://example.test/file.torrent')).toBeUndefined();
    expect(() => hashFromMagnet('magnet:?xt=urn:btih:nothex')).toThrow(TorrentParseError);
  });
});

describe('hashFromTorrentFile', () => {
  it('hashes the bencoded info dictionary of a v1 torrent with SHA-1', async () => {
    await expect(hashFromTorrentFile(V1_TORRENT)).resolves.toBe(V1_TORRENT_HASH);
  });

  it('uses truncated SHA-256 for v2-only torrents', async () => {
    const v2 = bytes(
      'd4:info',
      'd9:file treed8:test.mkvd0:d6:lengthi5e11:pieces root32:',
      'B'.repeat(32),
      'eee12:meta versioni2e4:name8:test.mkv12:piece lengthi16384ee',
      'e',
    );
    await expect(hashFromTorrentFile(v2)).resolves.toBe('e9c0cfe45d04f25aeeb18515d9791ff1722b4d36');
  });

  it('rejects truncated or non-torrent data', async () => {
    await expect(hashFromTorrentFile(encoder.encode('<html>nope</html>'))).rejects.toThrow(TorrentParseError);
    await expect(hashFromTorrentFile(V1_TORRENT.subarray(0, 60))).rejects.toThrow(TorrentParseError);
    await expect(hashFromTorrentFile(encoder.encode('d3:fooi1ee'))).rejects.toThrow(/no info/);
  });
});

describe('paths', () => {
  it('joins POSIX and Windows client paths in their own style', () => {
    expect(joinRemotePath('/downloads/', 'tv')).toBe('/downloads/tv');
    expect(joinRemotePath('D:\\Torrents\\', 'sub/rel')).toBe('D:\\Torrents\\sub\\rel');
    expect(joinRemotePath('C:\\', 'tv')).toBe('C:\\tv');
  });

  it('recognises loopback hosts', () => {
    expect(isLocalhostAddress('localhost')).toBe(true);
    expect(isLocalhostAddress('127.0.0.1')).toBe(true);
    expect(isLocalhostAddress('[::1]')).toBe(true);
    expect(isLocalhostAddress('192.168.1.10')).toBe(false);
    expect(isLocalhostAddress('qbittorrent')).toBe(false);
  });
});
