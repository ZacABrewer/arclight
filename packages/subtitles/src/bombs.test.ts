import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveError, MAX_SUBTITLE_BYTES, extractSubtitle, readZip, writeZip } from './archive.js';
import { xzDecompress, XzError } from './xz.js';
import { BaseProvider } from './providers/base.js';
import { ProviderError } from './types.js';

// DATA-07: decompression bombs and endless bodies from subtitle providers.

const file = (bytes: Uint8Array, fileName?: string) => ({ bytes, format: 'unknown' as const, encoding: 'unknown', ...(fileName ? { fileName } : {}) });

describe('subtitle decompression bombs', () => {
  it('rejects a few-KB nested gzip that expands to gigabytes, quickly and with bad-archive', () => {
    // 1 GiB of zeros gzipped twice is a few KB; built in slices so the test itself stays small.
    const inner = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    const bomb = gzipSync(Buffer.concat(Array.from({ length: 16 }, () => inner)), { level: 9 });
    expect(bomb.length).toBeLessThan(200 * 1024);
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    let caught: unknown;
    try {
      extractSubtitle(file(bomb, 'x.srt.gz.gz'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArchiveError);
    expect((caught as ArchiveError).code).toBe('bad-archive');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(process.memoryUsage().rss - before).toBeLessThan(128 * 1024 * 1024);
  });

  it('refuses a zip entry whose declared size is over the cap', () => {
    const zip = writeZip([{ name: 'a.srt', data: new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHi\n') }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cd = zip.length - 22 - (46 + 'a.srt'.length);
    view.setUint32(cd + 24, MAX_SUBTITLE_BYTES + 1, true);
    expect(() => readZip(zip)[0]!.read()).toThrow(expect.objectContaining({ code: 'bad-archive' }));
  });

  it('caps a deflated zip entry even when its declared size lies', () => {
    const raw = deflateRawSync(Buffer.alloc(MAX_SUBTITLE_BYTES + 1024 * 1024));
    const zip = writeZip([{ name: 'a.srt', data: raw }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cd = zip.length - 22 - (46 + 'a.srt'.length);
    view.setUint16(cd + 10, 8, true); // method: deflate
    view.setUint32(cd + 24, 100, true); // declared size: tiny
    let caught: unknown;
    try {
      extractSubtitle(file(zip));
    } catch (err) {
      caught = err;
    }
    expect((caught as ArchiveError).code).toBe('bad-archive');
  });

  it('caps the xz decoder output', () => {
    // A stream of uncompressed LZMA2 chunks: header, one block, 3 x 64 KiB of zeros.
    const chunk = (size: number) => [0x01, ((size - 1) >> 8) & 0xff, (size - 1) & 0xff, ...new Array<number>(size).fill(0)];
    const body = [...chunk(65536), ...chunk(65536), ...chunk(65536), 0x00];
    const header = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x00, 0, 0, 0, 0];
    // Block header: size byte, flags (1 filter), filter id 0x21 (LZMA2), props size 1, dict prop, padding to 8 bytes + CRC32.
    const block = [0x02, 0x00, 0x21, 0x01, 0x16, 0x00, 0x00, 0x00, 0, 0, 0, 0];
    const xz = new Uint8Array([...header, ...block, ...body, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(xzDecompress(xz).length).toBe(3 * 65536);
    expect(() => xzDecompress(xz, 100_000)).toThrow(XzError);
  });
});

class Probe extends BaseProvider {
  readonly kind = 'subdl' as const;
  readonly needsAuth = false;
  readonly rateLimit = { minIntervalMs: 0, requestTimeoutMs: 10_000 };
  readonly capabilities = {} as never;
  async test(): Promise<void> {}
  async search(): Promise<never[]> {
    return [];
  }
  async download(): Promise<never> {
    throw new Error('unused');
  }
  bytes(url: string) {
    return this.getBytes(url);
  }
}

describe('provider bodies are byte-limited', () => {
  it('stops an endless download at the cap', async () => {
    let sent = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(ctrl) {
            sent += 1024 * 1024;
            ctrl.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
      );
    const p = new Probe({ fetch: (async () => endless()) as typeof fetch, sleep: async () => {} });
    await expect(p.bytes('https://subs.example.com/x')).rejects.toBeInstanceOf(ProviderError);
    expect(sent).toBeLessThan(MAX_SUBTITLE_BYTES + 4 * 1024 * 1024);
  });
});
