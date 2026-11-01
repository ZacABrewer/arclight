import { describe, expect, it } from 'vitest';
import { dataCodewords, encodeQr, formatBits, interleaved, qrPath, reedSolomon, versionFor } from './qr.js';

describe('QR encoder', () => {
  it('knows the data capacity of each version and level', () => {
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(dataCodewords(1, 'L')).toBe(19);
    expect(dataCodewords(1, 'H')).toBe(9);
    expect(dataCodewords(2, 'M')).toBe(28);
    expect(dataCodewords(5, 'Q')).toBe(62);
    expect(dataCodewords(10, 'M')).toBe(216);
    expect(dataCodewords(40, 'M')).toBe(2334);
    expect(dataCodewords(40, 'L')).toBe(2956);
    // Byte mode: 14 bytes fit version 1-M, 15 need version 2.
    expect(versionFor(14, 'M')).toBe(1);
    expect(versionFor(15, 'M')).toBe(2);
    expect(versionFor(2331, 'M')).toBe(40);
    expect(() => versionFor(2332, 'M')).toThrow(RangeError);
  });

  it('computes Reed-Solomon codewords (ISO 18004 "HELLO WORLD" 1-M example)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    // One block: data followed by its ECC.
    expect(interleaved(data, 1, 'M')).toEqual([...data, 196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('BCH-codes the format information', () => {
    expect(formatBits('M', 0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits('M', 4).toString(2).padStart(15, '0')).toBe('100010111111001');
    expect(formatBits('L', 0).toString(2).padStart(15, '0')).toBe('111011111000100');
    expect(formatBits('H', 7).toString(2).padStart(15, '0')).toBe('000100000111011');
  });

  it('lays out finder, timing and format patterns for a pairing URI', () => {
    const uri = `arclight://pair?url=${encodeURIComponent('https://arclight.example.com:7878')}`;
    const m = encodeQr(uri);
    expect(m.size).toBe(m.version * 4 + 17);
    expect(m.version).toBe(versionFor(new TextEncoder().encode(uri).length, 'M'));
    const at = (x: number, y: number) => m.modules[y]![x]!;
    // Finder patterns: dark 7x7 ring, light ring inside, dark 3x3 core; light separator.
    for (const [ox, oy] of [
      [0, 0],
      [m.size - 7, 0],
      [0, m.size - 7],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(at(ox + i, oy)).toBe(true);
        expect(at(ox + i, oy + 6)).toBe(true);
      }
      expect(at(ox + 1, oy + 1)).toBe(false);
      expect(at(ox + 3, oy + 3)).toBe(true);
    }
    // Timing patterns alternate between the finders.
    for (let i = 8; i < m.size - 8; i++) {
      expect(at(i, 6)).toBe(i % 2 === 0);
      expect(at(6, i)).toBe(i % 2 === 0);
    }
    // Dark module and both copies of the format bits.
    expect(at(8, m.size - 8)).toBe(true);
    const bits = formatBits('M', m.mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) expect(at(8, i)).toBe(bit(i));
    for (let i = 0; i < 8; i++) expect(at(m.size - 1 - i, 8)).toBe(bit(i));
    for (let i = 8; i < 15; i++) expect(at(8, m.size - 15 + i)).toBe(bit(i));
  });

  it('is deterministic and renders an SVG path with a quiet zone', () => {
    const a = encodeQr('arclight://pair?url=x');
    expect(encodeQr('arclight://pair?url=x')).toEqual(a);
    const path = qrPath(a, 4);
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
    expect(path.split('z').length - 1).toBe(a.modules.flat().filter(Boolean).length);
  });
});
