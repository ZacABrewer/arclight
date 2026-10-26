import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, parseMagnet, toMagnetUri } from './magnet.js';
import { decodeCompactNodes, decodeCompactPeers, encodeCompactNodes, encodeCompactPeers } from './compact.js';

const HEX = 'c9e15763f722f23e98a29decdfae341b98d53056';

describe('parseMagnet', () => {
  it('parses hex btih, name, trackers and peers', () => {
    const m = parseMagnet(
      `magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=My+Show&tr=http%3A%2F%2Ft1%2Fann&tr=udp%3A%2F%2Ft2%3A80&tr=http%3A%2F%2Ft1%2Fann&x.pe=10.0.0.1%3A6881&x.pe=bad`,
    );
    expect(m.infoHashHex).toBe(HEX);
    expect(m.name).toBe('My Show');
    expect(m.trackers).toEqual(['http://t1/ann', 'udp://t2:80']);
    expect(m.peers).toEqual([{ host: '10.0.0.1', port: 6881 }]);
  });

  it('parses base32 btih', () => {
    const b32 = base32Encode(Buffer.from(HEX, 'hex'));
    expect(b32).toHaveLength(32);
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32}`).infoHashHex).toBe(HEX);
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32.toLowerCase()}`).infoHashHex).toBe(HEX);
  });

  it('parses btmh v2 topics and numbered params', () => {
    const v2 = 'ab'.repeat(32);
    const m = parseMagnet(`magnet:?xt.1=urn:btih:${HEX}&xt.2=urn:btmh:1220${v2}&tr.1=http%3A%2F%2Fa`);
    expect(m.infoHashV2?.toString('hex')).toBe(v2);
    expect(m.infoHashHex).toBe(HEX);
    expect(m.trackers).toEqual(['http://a']);
    const only = parseMagnet(`magnet:?xt=urn:btmh:1220${v2}`);
    expect(only.infoHashHex).toBe(v2.slice(0, 40));
  });

  it.each(['http://x', 'magnet:?dn=x', 'magnet:?xt=urn:btih:zz', 'magnet:?xt=urn:btmh:1111'])('rejects %s', (uri) => {
    expect(() => parseMagnet(uri)).toThrow();
  });

  it('round-trips through toMagnetUri', () => {
    const uri = toMagnetUri({ infoHash: Buffer.from(HEX, 'hex'), name: 'a b', trackers: ['http://t/a'], peers: [{ host: '1.2.3.4', port: 5 }] });
    const m = parseMagnet(uri);
    expect(m.name).toBe('a b');
    expect(m.trackers).toEqual(['http://t/a']);
    expect(m.peers).toEqual([{ host: '1.2.3.4', port: 5 }]);
  });

  it('base32 decodes RFC 4648 vectors', () => {
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });
});

describe('compact encoding', () => {
  it('round-trips peers and nodes', () => {
    const peers = [{ host: '127.0.0.1', port: 6881 }, { host: '10.1.2.3', port: 65535 }];
    expect(decodeCompactPeers(encodeCompactPeers(peers))).toEqual(peers);
    const nodes = [{ id: Buffer.alloc(20, 9), host: '1.2.3.4', port: 80 }];
    expect(decodeCompactNodes(encodeCompactNodes(nodes))).toEqual(nodes);
  });
  it('skips port 0 and IPv6 entries', () => {
    expect(decodeCompactPeers(Buffer.from([1, 2, 3, 4, 0, 0]))).toEqual([]);
    expect(encodeCompactPeers([{ host: '::1', port: 1 }]).length).toBe(0);
  });
});
