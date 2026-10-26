import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';

// A minimal ZIP writer/reader (PKWARE APPNOTE 6.3): methods 0 (store) and 8 (deflate), UTF-8
// names, no ZIP64, no encryption, no spanning. Enough for backup archives without a
// dependency, and still readable by every common unzip tool.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_LEN = 30;
const CENTRAL_LEN = 46;
const EOCD_LEN = 22;
const MAX_U32 = 0xffffffff;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

export type ZipErrorCode = 'ZIP_INVALID' | 'ZIP_UNSUPPORTED' | 'ZIP_CORRUPT' | 'ZIP_TOO_LARGE' | 'ZIP_NOT_FOUND';

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export type ZipMethod = 'store' | 'deflate';

export interface ZipInput {
  /** Path inside the archive, '/'-separated. */
  name: string;
  source: Buffer | { path: string };
  method?: ZipMethod;
  mtime?: Date;
}

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  mtime: Date;
  localHeaderOffset: number;
}

/** Rejects absolute paths, drive letters, backslashes and `.`/`..` segments. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== '');
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(time: number, date: number): Date {
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

/** Computes CRC-32 and byte count of everything flowing through; errors past `limit` bytes. */
class Measure extends Transform {
  crc = 0;
  bytes = 0;
  constructor(private readonly limit = Infinity) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.crc = crc32(chunk, this.crc);
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      cb(new ZipError('ZIP_CORRUPT', 'entry is larger than declared'));
      return;
    }
    cb(null, chunk);
  }
}

/**
 * Writes `inputs` to `dest`. The archive goes to `<dest>.partial` first and is renamed into
 * place, so a crash never leaves a truncated file under the final name.
 */
export async function writeZip(dest: string, inputs: readonly ZipInput[]): Promise<ZipEntry[]> {
  const partial = `${dest}.partial`;
  const fh = await open(partial, 'w');
  const entries: ZipEntry[] = [];
  let pos = 0;
  const write = async (buf: Buffer) => {
    await fh.write(buf, 0, buf.length, pos);
    pos += buf.length;
  };
  try {
    const seen = new Set<string>();
    for (const input of inputs) {
      if (!isSafeEntryName(input.name)) throw new ZipError('ZIP_INVALID', `unsafe entry name: ${input.name}`);
      if (seen.has(input.name)) throw new ZipError('ZIP_INVALID', `duplicate entry: ${input.name}`);
      seen.add(input.name);
      const name = Buffer.from(input.name, 'utf8');
      const method = input.method === 'store' ? 0 : 8;
      const mtime = input.mtime ?? new Date();
      const { time, date } = dosDateTime(mtime);
      const offset = pos;

      const header = Buffer.alloc(LOCAL_LEN);
      header.writeUInt32LE(LOCAL_SIG, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(FLAG_UTF8, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt16LE(name.length, 26);
      // crc + sizes (bytes 14..25) are patched once the data is written.
      await write(Buffer.concat([header, name]));

      const measure = new Measure();
      let compressed = 0;
      const source = Buffer.isBuffer(input.source) ? Readable.from([input.source]) : createReadStream(input.source.path);
      const sink = async (src: AsyncIterable<Buffer>) => {
        for await (const chunk of src) {
          await write(chunk);
          compressed += chunk.length;
        }
      };
      if (method === 8) await pipeline(source, measure, createDeflateRaw(), sink);
      else await pipeline(source, measure, sink);

      if (measure.bytes > MAX_U32 || compressed > MAX_U32 || pos > MAX_U32) {
        throw new ZipError('ZIP_TOO_LARGE', `entry too large for a non-ZIP64 archive: ${input.name}`);
      }
      const sizes = Buffer.alloc(12);
      sizes.writeUInt32LE(measure.crc >>> 0, 0);
      sizes.writeUInt32LE(compressed, 4);
      sizes.writeUInt32LE(measure.bytes, 8);
      await fh.write(sizes, 0, 12, offset + 14);

      entries.push({
        name: input.name,
        method,
        crc32: measure.crc >>> 0,
        compressedSize: compressed,
        size: measure.bytes,
        mtime,
        localHeaderOffset: offset,
      });
    }

    const cdStart = pos;
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const { time, date } = dosDateTime(e.mtime);
      const h = Buffer.alloc(CENTRAL_LEN);
      h.writeUInt32LE(CENTRAL_SIG, 0);
      h.writeUInt16LE(VERSION, 4);
      h.writeUInt16LE(VERSION, 6);
      h.writeUInt16LE(FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc32, 16);
      h.writeUInt32LE(e.compressedSize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(name.length, 28);
      h.writeUInt32LE(e.localHeaderOffset, 42);
      await write(Buffer.concat([h, name]));
    }
    const cdSize = pos - cdStart;
    if (entries.length >= 0xffff || pos > MAX_U32) throw new ZipError('ZIP_TOO_LARGE', 'archive too large for a non-ZIP64 archive');
    const eocd = Buffer.alloc(EOCD_LEN);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await write(eocd);
    await fh.close();
    await rename(partial, dest);
    return entries;
  } catch (err) {
    await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw err;
  }
}

/** Random-access reader over a zip file. Call `close()` when done. */
export class ZipReader {
  private constructor(
    private readonly fh: FileHandle,
    private readonly fileSize: number,
    readonly entries: readonly ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const entries = await readCentralDirectory(fh, size);
      return new ZipReader(fh, size, entries);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  get(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Decompressed, size- and CRC-checked stream of one entry. */
  async stream(name: string): Promise<Readable> {
    const entry = this.get(name);
    if (!entry) throw new ZipError('ZIP_NOT_FOUND', `no entry named ${name}`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError('ZIP_UNSUPPORTED', `unsupported compression method ${entry.method} in ${name}`);
    }
    const header = Buffer.alloc(LOCAL_LEN);
    const { bytesRead } = await this.fh.read(header, 0, LOCAL_LEN, entry.localHeaderOffset);
    if (bytesRead < LOCAL_LEN || header.readUInt32LE(0) !== LOCAL_SIG) {
      throw new ZipError('ZIP_CORRUPT', `bad local header for ${name}`);
    }
    const start = entry.localHeaderOffset + LOCAL_LEN + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + entry.compressedSize > this.fileSize) {
      throw new ZipError('ZIP_CORRUPT', `entry ${name} runs past the end of the file`);
    }
    const raw: Readable =
      entry.compressedSize === 0
        ? Readable.from([])
        : this.fh.createReadStream({ start, end: start + entry.compressedSize - 1, autoClose: false });

    const measure = new Measure(entry.size);
    const verify = new Transform({
      transform: (chunk: Buffer, _enc, cb) => cb(null, chunk),
      flush: (cb) => {
        if (measure.bytes !== entry.size || measure.crc >>> 0 !== entry.crc32) {
          cb(new ZipError('ZIP_CORRUPT', `checksum mismatch in ${name}`));
        } else cb();
      },
    });
    const stages: Readable[] = [raw];
    let decoded: Readable = raw;
    if (entry.method === 8 && entry.compressedSize > 0) {
      decoded = raw.pipe(createInflateRaw());
      stages.push(decoded);
    }
    // Forward every stage's error to the returned stream so consumers see corruption.
    for (const s of [...stages, measure]) s.on('error', (err) => verify.destroy(asZipError(err)));
    return decoded.pipe(measure).pipe(verify);
  }

  async readBuffer(name: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.stream(name)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async extract(name: string, destPath: string): Promise<void> {
    await pipeline(await this.stream(name), createWriteStream(destPath));
  }

  async close(): Promise<void> {
    await this.fh.close();
  }
}

function asZipError(err: unknown): Error {
  if (err instanceof ZipError) return err;
  return new ZipError('ZIP_CORRUPT', `corrupt data: ${err instanceof Error ? err.message : String(err)}`);
}

async function readCentralDirectory(fh: FileHandle, size: number): Promise<ZipEntry[]> {
  if (size < EOCD_LEN) throw new ZipError('ZIP_INVALID', 'not a zip archive (too small)');
  // The EOCD record sits at the end, followed by a comment of up to 65535 bytes.
  const tailLen = Math.min(size, EOCD_LEN + 0xffff);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let at = -1;
  for (let i = tailLen - EOCD_LEN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError('ZIP_INVALID', 'not a zip archive (no end of central directory)');
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdOffset === MAX_U32) throw new ZipError('ZIP_UNSUPPORTED', 'ZIP64 archives are not supported');
  if (cdOffset + cdSize > size) throw new ZipError('ZIP_CORRUPT', 'central directory runs past the end of the file');

  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_LEN > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError('ZIP_CORRUPT', 'bad central directory entry');
    }
    const flags = cd.readUInt16LE(p + 8);
    if (flags & 0x1) throw new ZipError('ZIP_UNSUPPORTED', 'encrypted entries are not supported');
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const name = cd
      .subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen)
      .toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');
    entries.push({
      name,
      method: cd.readUInt16LE(p + 10),
      mtime: fromDos(cd.readUInt16LE(p + 12), cd.readUInt16LE(p + 14)),
      crc32: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    });
    p += CENTRAL_LEN + nameLen + extraLen + commentLen;
  }
  return entries;
}
