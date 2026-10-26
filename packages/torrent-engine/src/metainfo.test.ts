import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encode } from './bencode.js';
import { Bitfield } from './bitfield.js';
import { createTorrent } from './create.js';
import { metainfoFromInfo, parseInfoDict, parseTorrent, sanitizeSegment } from './metainfo.js';

function sha1(b: Buffer): Buffer {
  return createHash('sha1').update(b).digest();
}

describe('parseTorrent', () => {
  it('parses a hand-built single-file torrent', () => {
    const data = Buffer.from('hello world, this is torrent data');
    const info = { length: data.length, name: 'hello.txt', 'piece length': 16, pieces: Buffer.concat([sha1(data.subarray(0, 16)), sha1(data.subarray(16, 32)), sha1(data.subarray(32))]) };
    const torrent = encode({ announce: 'http://t.example/announce', info, comment: 'c', 'creation date': 1700000000, 'created by': 'me' });
    const m = parseTorrent(torrent);
    expect(m.infoHash.equals(sha1(encode(info)))).toBe(true);
    expect(m.infoHashHex).toBe(sha1(encode(info)).toString('hex'));
    expect(m.version).toBe('v1');
    expect(m.name).toBe('hello.txt');
    expect(m.isMultiFile).toBe(false);
    expect(m.pieceCount).toBe(3);
    expect(m.totalLength).toBe(data.length);
    expect(m.files).toEqual([{ index: 0, path: 'hello.txt', pathSegments: ['hello.txt'], length: data.length, offset: 0, padding: false }]);
    expect(m.announceList).toEqual([['http://t.example/announce']]);
    expect(m.comment).toBe('c');
    expect(m.createdBy).toBe('me');
    expect(m.creationDate).toBe(1700000000);
    expect(m.private).toBe(false);
  });

  it('hashes the info dict exactly as it appears in the file (unsorted keys)', () => {
    // keys deliberately out of order: re-encoding would change the hash
    const rawInfo = Buffer.from('d4:name1:a12:piece lengthi4e6:lengthi4e6:pieces20:' + 'x'.repeat(20) + 'e', 'latin1');
    const torrent = Buffer.concat([Buffer.from('d4:info'), rawInfo, Buffer.from('e')]);
    const m = parseTorrent(torrent);
    expect(m.infoHash.equals(sha1(rawInfo))).toBe(true);
    expect(m.info.equals(rawInfo)).toBe(true);
  });

  it('parses multi-file torrents with offsets, announce-list, url-list and private flag', () => {
    const { torrent } = createTorrent({
      name: 'pack',
      files: [
        { path: ['a.bin'], data: Buffer.alloc(10, 1) },
        { path: ['sub', 'b.bin'], data: Buffer.alloc(25, 2) },
        { path: ['c.bin'], data: Buffer.alloc(5, 3) },
      ],
      pieceLength: 16,
      announce: [['http://a/announce', 'http://b/announce'], ['udp://c:80']],
      private: true,
      urlList: ['http://seed/'],
    });
    const m = parseTorrent(torrent);
    expect(m.isMultiFile).toBe(true);
    expect(m.files.map((f) => [f.path, f.offset, f.length])).toEqual([
      ['pack/a.bin', 0, 10],
      ['pack/sub/b.bin', 10, 25],
      ['pack/c.bin', 35, 5],
    ]);
    expect(m.pieceCount).toBe(3);
    expect(m.private).toBe(true);
    expect(m.announceList).toEqual([['http://a/announce', 'http://b/announce'], ['udp://c:80']]);
    expect(m.urlList).toEqual(['http://seed/']);
  });

  it('marks BEP 47 padding files', () => {
    const info = {
      name: 'p',
      'piece length': 16,
      pieces: Buffer.alloc(40),
      files: [
        { length: 10, path: ['a'] },
        { length: 6, path: ['.pad', '6'], attr: 'p' },
        { length: 16, path: ['b'] },
      ],
    };
    const m = parseTorrent(encode({ info }));
    expect(m.files.map((f) => f.padding)).toEqual([false, true, false]);
  });

  it('computes v2 and hybrid info-hashes', () => {
    const v2info = {
      name: 'v2',
      'piece length': 16384,
      'meta version': 2,
      'file tree': { 'f.txt': { '': { length: 5, 'pieces root': Buffer.alloc(32) } } },
    };
    const m2 = parseTorrent(encode({ info: v2info }));
    const sha256 = createHash('sha256').update(encode(v2info)).digest();
    expect(m2.version).toBe('v2');
    expect(m2.infoHashV2?.equals(sha256)).toBe(true);
    expect(m2.infoHash.equals(sha256.subarray(0, 20))).toBe(true);
    expect(m2.pieceHashes).toEqual([]);
    expect(m2.files[0]?.path).toBe('v2/f.txt');

    const hybrid = { ...v2info, length: 5, pieces: sha1(Buffer.from('hello')) };
    const mh = parseTorrent(encode({ info: hybrid }));
    expect(mh.version).toBe('hybrid');
    expect(mh.infoHash.equals(sha1(encode(hybrid)))).toBe(true);
    expect(mh.infoHashV2?.length).toBe(32);
  });

  it.each([
    [{ info: { name: 'x', 'piece length': 16, pieces: Buffer.alloc(19), length: 1 } }, 'multiple of 20'],
    [{ info: { name: 'x', 'piece length': 16, pieces: Buffer.alloc(40), length: 1 } }, 'piece count mismatch'],
    [{ info: { name: 'x', 'piece length': 0, pieces: Buffer.alloc(20), length: 1 } }, 'piece length'],
    [{ info: { 'piece length': 16, pieces: Buffer.alloc(20), length: 1 } }, 'no name'],
    [{ announce: 'x' }, 'no info'],
    [{ info: { name: 'x', 'piece length': 16, pieces: Buffer.alloc(20), files: [{ length: 1, path: ['..'] }] } }, 'invalid path'],
    [{ info: { name: 'x', 'piece length': 16, pieces: Buffer.alloc(20), files: [] } }, 'empty files'],
  ])('rejects malformed torrent %#', (root, msg) => {
    expect(() => parseTorrent(encode(root))).toThrowError(msg);
  });

  it('prefers .utf-8 names', () => {
    const info = { name: 'bad', 'name.utf-8': 'güt', 'piece length': 16, pieces: sha1(Buffer.from('a')), length: 1 };
    expect(parseTorrent(encode({ info })).name).toBe('güt');
  });
});

describe('sanitizeSegment', () => {
  it('replaces characters illegal on Windows', () => {
    expect(sanitizeSegment('a:b?c*')).toBe('a_b_c_');
    expect(sanitizeSegment('trailing. ')).toBe('trailing__');
  });
  it('rejects traversal and separators', () => {
    expect(() => sanitizeSegment('..')).toThrow();
    expect(() => sanitizeSegment('a/b')).toThrow();
    expect(() => sanitizeSegment('a\\b')).toThrow();
  });
});

describe('parseInfoDict / metainfoFromInfo', () => {
  it('rebuilds metainfo from a raw info dict with tracker hints', () => {
    const { metainfo } = createTorrent({ name: 'x.bin', files: [{ path: ['x.bin'], data: Buffer.alloc(100, 7) }], pieceLength: 32 });
    const m = metainfoFromInfo(metainfo.info, ['http://t/a']);
    expect(m.infoHashHex).toBe(metainfo.infoHashHex);
    expect(m.announceList).toEqual([['http://t/a']]);
    expect(parseInfoDict(metainfo.info).pieceHashes.length).toBe(4);
  });
});

describe('Bitfield', () => {
  it('sets, counts and serialises MSB-first', () => {
    const bf = new Bitfield(10);
    bf.set(0);
    bf.set(9);
    expect(bf.count()).toBe(2);
    expect([...bf.toBuffer()]).toEqual([0x80, 0x40]);
    expect([...bf.indices()]).toEqual([0, 9]);
    bf.set(0, false);
    expect(bf.get(0)).toBe(false);
    expect(Bitfield.full(10).hasAll()).toBe(true);
  });
  it('detects and clears spare bits', () => {
    expect(Bitfield.hasSpareBits(10, Buffer.from([0xff, 0xff]))).toBe(true);
    expect(Bitfield.hasSpareBits(10, Buffer.from([0xff, 0xc0]))).toBe(false);
    expect(new Bitfield(10, Buffer.from([0xff, 0xff])).count()).toBe(10);
  });
});
