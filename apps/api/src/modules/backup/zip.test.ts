import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeEntryName, writeZip, ZipError, ZipReader } from './zip.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-zip-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('zip', () => {
  it('round-trips stored and deflated entries from buffers and files', async () => {
    const src = join(dir, 'source.bin');
    const fileData = Buffer.from('file contents '.repeat(500));
    writeFileSync(src, fileData);
    const zipPath = join(dir, 'a.zip');
    const mtime = new Date(2026, 9, 25, 4, 0, 10);
    await writeZip(zipPath, [
      { name: 'stored.txt', source: Buffer.from('plain'), method: 'store', mtime },
      { name: 'deflated.txt', source: Buffer.from('aaaa'.repeat(1000)), mtime },
      { name: 'dir/from-file.bin', source: { path: src } },
      { name: 'ünïcødé/名前.txt', source: Buffer.from('utf8 name') },
      { name: 'empty.txt', source: Buffer.alloc(0) },
      { name: 'empty-stored.txt', source: Buffer.alloc(0), method: 'store' },
    ]);
    const zip = await ZipReader.open(zipPath);
    try {
      expect(zip.entries.map((e) => e.name)).toEqual([
        'stored.txt',
        'deflated.txt',
        'dir/from-file.bin',
        'ünïcødé/名前.txt',
        'empty.txt',
        'empty-stored.txt',
      ]);
      expect(zip.get('stored.txt')?.method).toBe(0);
      expect(zip.get('deflated.txt')?.method).toBe(8);
      expect(zip.get('deflated.txt')!.compressedSize).toBeLessThan(4000);
      expect(zip.get('stored.txt')?.mtime.getTime()).toBe(mtime.getTime());
      expect((await zip.readBuffer('stored.txt')).toString()).toBe('plain');
      expect((await zip.readBuffer('deflated.txt')).toString()).toBe('aaaa'.repeat(1000));
      expect((await zip.readBuffer('dir/from-file.bin')).equals(fileData)).toBe(true);
      expect((await zip.readBuffer('ünïcødé/名前.txt')).toString()).toBe('utf8 name');
      expect((await zip.readBuffer('empty.txt')).length).toBe(0);
      expect((await zip.readBuffer('empty-stored.txt')).length).toBe(0);
      const out = join(dir, 'out.bin');
      await zip.extract('dir/from-file.bin', out);
      expect(readFileSync(out).equals(fileData)).toBe(true);
      await expect(zip.readBuffer('missing')).rejects.toMatchObject({ code: 'ZIP_NOT_FOUND' });
    } finally {
      await zip.close();
    }
  });

  it('handles incompressible multi-chunk data', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 17);
    const zipPath = join(dir, 'big.zip');
    const [entry] = await writeZip(zipPath, [{ name: 'random.bin', source: data }]);
    expect(entry?.size).toBe(data.length);
    const zip = await ZipReader.open(zipPath);
    try {
      expect((await zip.readBuffer('random.bin')).equals(data)).toBe(true);
    } finally {
      await zip.close();
    }
  });

  it('detects corrupted entry data', async () => {
    const zipPath = join(dir, 'c.zip');
    await writeZip(zipPath, [{ name: 'x.txt', source: Buffer.from('hello world, hello zip'), method: 'store' }]);
    const bytes = readFileSync(zipPath);
    // Data of the only entry starts right after its 30-byte header + 5-byte name.
    bytes[35] = bytes[35]! ^ 0xff;
    writeFileSync(zipPath, bytes);
    const zip = await ZipReader.open(zipPath);
    try {
      await expect(zip.readBuffer('x.txt')).rejects.toMatchObject({ code: 'ZIP_CORRUPT' });
    } finally {
      await zip.close();
    }
  });

  it('detects corrupted deflate streams', async () => {
    const zipPath = join(dir, 'd.zip');
    await writeZip(zipPath, [{ name: 'x.txt', source: randomBytes(4096) }]);
    const bytes = readFileSync(zipPath);
    for (let i = 40; i < 200; i++) bytes[i] = 0xff;
    writeFileSync(zipPath, bytes);
    const zip = await ZipReader.open(zipPath);
    try {
      await expect(zip.readBuffer('x.txt')).rejects.toBeInstanceOf(ZipError);
    } finally {
      await zip.close();
    }
  });

  it('rejects files that are not zip archives', async () => {
    const p = join(dir, 'not.zip');
    writeFileSync(p, 'this is plainly not a zip archive at all, just text');
    await expect(ZipReader.open(p)).rejects.toMatchObject({ code: 'ZIP_INVALID' });
    writeFileSync(p, 'tiny');
    await expect(ZipReader.open(p)).rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('refuses unsafe or duplicate names and leaves no partial file', async () => {
    expect(isSafeEntryName('config/wg0.conf')).toBe(true);
    for (const bad of ['../evil', 'a/../../b', '/abs', 'C:/win', 'a\\b', '', 'a//b', './x']) {
      expect(isSafeEntryName(bad)).toBe(false);
    }
    const p = join(dir, 'bad.zip');
    await expect(writeZip(p, [{ name: '../evil', source: Buffer.from('x') }])).rejects.toMatchObject({ code: 'ZIP_INVALID' });
    await expect(
      writeZip(p, [
        { name: 'a', source: Buffer.from('1') },
        { name: 'a', source: Buffer.from('2') },
      ]),
    ).rejects.toMatchObject({ code: 'ZIP_INVALID' });
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
