// Byte-level builders for tiny, silent, tagged audio files used by the audio import tests.
// No encoder is needed: FLAC frames use CONSTANT subframes, MP3 frames carry empty main data
// (part2_3_length = 0) and AAC frames are single-channel elements with no spectral data, so
// every file decodes to digital silence. Written from the public format specifications.

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u8(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

function be16(n: number): Uint8Array {
  return u8((n >>> 8) & 0xff, n & 0xff);
}

function be24(n: number): Uint8Array {
  return u8((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function be32(n: number): Uint8Array {
  return u8((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function be64(n: number): Uint8Array {
  const hi = Math.floor(n / 2 ** 32);
  return concat([be32(hi), be32(n >>> 0)]);
}

function le32(n: number): Uint8Array {
  return u8(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function syncsafe32(n: number): Uint8Array {
  return u8((n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f);
}

/** MSB-first bit writer. */
class BitWriter {
  private readonly bytes: number[] = [];
  private cur = 0;
  private used = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(value / 2 ** i) & 1);
      if (++this.used === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.used = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.used > 0) this.write(0, 8 - this.used);
    return Uint8Array.from(this.bytes);
  }
}

// ---------------------------------------------------------------------------------------
// Tag input
// ---------------------------------------------------------------------------------------

export interface FixtureTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  date?: string;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  discOf?: number;
  compilation?: boolean;
  mbRecordingId?: string;
  mbReleaseTrackId?: string;
  mbReleaseId?: string;
  mbReleaseGroupId?: string;
  mbArtistId?: string;
  mbAlbumArtistId?: string;
  asin?: string;
  isbn?: string;
  narrator?: string;
  series?: string;
  seriesPart?: string;
}

export interface FixtureChapter {
  title: string;
  startMs: number;
}

// ---------------------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------------------

function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** FLAC "UTF-8" coded frame number (only the 1- and 2-byte forms are needed here). */
function flacFrameNumber(n: number): Uint8Array {
  if (n < 0x80) return u8(n);
  if (n < 0x800) return u8(0xc0 | (n >>> 6), 0x80 | (n & 0x3f));
  throw new Error('frame number too large for the fixture builder');
}

function vorbisComments(tags: FixtureTags): string[] {
  const out: string[] = [];
  const add = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') out.push(`${k}=${v}`);
  };
  add('TITLE', tags.title);
  add('ARTIST', tags.artist);
  add('ALBUMARTIST', tags.albumArtist);
  add('ALBUM', tags.album);
  add('DATE', tags.date);
  add('TRACKNUMBER', tags.trackNo);
  add('TRACKTOTAL', tags.trackOf);
  add('DISCNUMBER', tags.discNo);
  add('DISCTOTAL', tags.discOf);
  if (tags.compilation) add('COMPILATION', 1);
  add('MUSICBRAINZ_TRACKID', tags.mbRecordingId);
  add('MUSICBRAINZ_RELEASETRACKID', tags.mbReleaseTrackId);
  add('MUSICBRAINZ_ALBUMID', tags.mbReleaseId);
  add('MUSICBRAINZ_RELEASEGROUPID', tags.mbReleaseGroupId);
  add('MUSICBRAINZ_ARTISTID', tags.mbArtistId);
  add('MUSICBRAINZ_ALBUMARTISTID', tags.mbAlbumArtistId);
  add('ASIN', tags.asin);
  add('ISBN', tags.isbn);
  add('NARRATOR', tags.narrator);
  add('SERIES', tags.series);
  add('SERIES-PART', tags.seriesPart);
  return out;
}

export interface FlacOptions {
  durationMs: number;
  tags?: FixtureTags;
  sampleRate?: number;
  channels?: number;
}

const FLAC_SAMPLE_RATE_CODES: Record<number, number> = { 44100: 0b1001, 48000: 0b1010, 96000: 0b1011, 32000: 0b1000 };

export function buildFlac(opts: FlacOptions): Uint8Array {
  const sampleRate = opts.sampleRate ?? 44100;
  const channels = opts.channels ?? 2;
  const bps = 16;
  const block = 4096;
  const totalSamples = Math.round((opts.durationMs / 1000) * sampleRate);
  const rateCode = FLAC_SAMPLE_RATE_CODES[sampleRate];
  if (rateCode === undefined) throw new Error(`unsupported fixture sample rate ${sampleRate}`);

  // STREAMINFO
  const si = new BitWriter();
  si.write(block, 16);
  si.write(block, 16);
  si.write(0, 24);
  si.write(0, 24);
  si.write(sampleRate, 20);
  si.write(channels - 1, 3);
  si.write(bps - 1, 5);
  si.write(totalSamples, 36);
  const streamInfo = concat([si.finish(), new Uint8Array(16)]);

  const comments = vorbisComments(opts.tags ?? {}).map(utf8);
  const vendor = utf8('arclight-fixture');
  const vorbis = concat([le32(vendor.length), vendor, le32(comments.length), ...comments.flatMap((c) => [le32(c.length), c])]);

  const metaBlock = (type: number, last: boolean, body: Uint8Array) => concat([u8((last ? 0x80 : 0) | type), be24(body.length), body]);

  const frames: Uint8Array[] = [];
  let frameNo = 0;
  for (let done = 0; done < totalSamples; done += block, frameNo++) {
    const size = Math.min(block, totalSamples - done);
    const full = size === block;
    const header = concat([
      u8(0xff, 0xf8),
      u8(((full ? 0b1100 : 0b0111) << 4) | rateCode),
      u8(((channels - 1) << 4) | (0b100 << 1)),
      flacFrameNumber(frameNo),
      full ? new Uint8Array(0) : be16(size - 1),
    ]);
    const withCrc = concat([header, u8(crc8(header))]);
    // CONSTANT subframe per channel: header byte 0, then one 16-bit sample of value 0.
    const subframes = new Uint8Array(channels * 3);
    const body = concat([withCrc, subframes]);
    frames.push(concat([body, be16(crc16(body))]));
  }

  return concat([utf8('fLaC'), metaBlock(0, false, streamInfo), metaBlock(4, true, vorbis), ...frames]);
}

// ---------------------------------------------------------------------------------------
// MP3 (ID3v2.4 + MPEG-1 Layer III, 32 kbit/s, 44.1 kHz, mono)
// ---------------------------------------------------------------------------------------

function id3Frame(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8(id), syncsafe32(body.length), u8(0, 0), body]);
}

function id3Text(id: string, value: string | number | undefined): Uint8Array[] {
  if (value === undefined || value === '') return [];
  return [id3Frame(id, concat([u8(3), utf8(String(value))]))];
}

function id3Txxx(description: string, value: string | undefined): Uint8Array[] {
  if (!value) return [];
  return [id3Frame('TXXX', concat([u8(3), utf8(description), u8(0), utf8(value)]))];
}

export function buildId3v24(tags: FixtureTags): Uint8Array {
  const pair = (n?: number, of?: number) => (n === undefined ? undefined : of ? `${n}/${of}` : `${n}`);
  const frames = [
    ...id3Text('TIT2', tags.title),
    ...id3Text('TPE1', tags.artist),
    ...id3Text('TPE2', tags.albumArtist),
    ...id3Text('TALB', tags.album),
    ...id3Text('TDRC', tags.date),
    ...id3Text('TRCK', pair(tags.trackNo, tags.trackOf)),
    ...id3Text('TPOS', pair(tags.discNo, tags.discOf)),
    ...(tags.compilation ? id3Text('TCMP', '1') : []),
    ...id3Txxx('MusicBrainz Release Track Id', tags.mbReleaseTrackId),
    ...id3Txxx('MusicBrainz Album Id', tags.mbReleaseId),
    ...id3Txxx('MusicBrainz Release Group Id', tags.mbReleaseGroupId),
    ...id3Txxx('MusicBrainz Artist Id', tags.mbArtistId),
    ...id3Txxx('MusicBrainz Album Artist Id', tags.mbAlbumArtistId),
    ...id3Txxx('ASIN', tags.asin),
    ...id3Txxx('ISBN', tags.isbn),
    ...id3Txxx('NARRATOR', tags.narrator),
    ...id3Txxx('SERIES', tags.series),
    ...id3Txxx('SERIES-PART', tags.seriesPart),
    ...(tags.mbRecordingId ? [id3Frame('UFID', concat([utf8('http://musicbrainz.org'), u8(0), utf8(tags.mbRecordingId)]))] : []),
  ];
  const body = concat(frames);
  return concat([utf8('ID3'), u8(4, 0, 0), syncsafe32(body.length), body]);
}

export interface Mp3Options {
  durationMs: number;
  tags?: FixtureTags;
}

export function buildMp3(opts: Mp3Options): Uint8Array {
  const frameSamples = 1152;
  const sampleRate = 44100;
  const frameBytes = Math.floor((144 * 32000) / sampleRate); // 104, no padding
  const count = Math.max(1, Math.round(((opts.durationMs / 1000) * sampleRate) / frameSamples));
  const frame = new Uint8Array(frameBytes);
  // sync + MPEG-1 + Layer III + no CRC | 32 kbit/s, 44.1 kHz | mono. Side info and data stay 0.
  frame.set([0xff, 0xfb, 0x10, 0xc0]);
  const frames = new Uint8Array(frameBytes * count);
  for (let i = 0; i < count; i++) frames.set(frame, i * frameBytes);
  return concat([buildId3v24(opts.tags ?? {}), frames]);
}

// ---------------------------------------------------------------------------------------
// MP4 / M4A / M4B (AAC-LC mono, 44.1 kHz)
// ---------------------------------------------------------------------------------------

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([be32(body.length + 8), utf8(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version), be24(flags), ...payload);
}

const MATRIX = concat([be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000)]);

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  return concat([u8(tag, body.length), body]);
}

function ilstItem(name: string, dataType: number, value: Uint8Array): Uint8Array {
  const nameBytes = Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0) & 0xff));
  const body = box('data', be32(dataType), be32(0), value);
  return concat([be32(body.length + 8), nameBytes, body]);
}

function ilstFreeform(name: string, value: string | undefined): Uint8Array[] {
  if (!value) return [];
  return [
    box(
      '----',
      fullBox('mean', 0, 0, utf8('com.apple.iTunes')),
      fullBox('name', 0, 0, utf8(name)),
      box('data', be32(1), be32(0), utf8(value)),
    ),
  ];
}

function ilstString(name: string, value: string | undefined): Uint8Array[] {
  return value ? [ilstItem(name, 1, utf8(value))] : [];
}

export interface Mp4Options {
  durationMs: number;
  tags?: FixtureTags;
  chapters?: FixtureChapter[];
  /** 'M4A ' (music) or 'M4B ' (audiobook). */
  brand?: 'M4A ' | 'M4B ';
}

export function buildMp4(opts: Mp4Options): Uint8Array {
  const tags = opts.tags ?? {};
  const sampleRate = 44100;
  const frameSamples = 1024;
  const sampleCount = Math.max(1, Math.round(((opts.durationMs / 1000) * sampleRate) / frameSamples));
  const mediaDuration = sampleCount * frameSamples;
  const movieDuration = Math.round((mediaDuration / sampleRate) * 1000);
  // Single channel element, global_gain 0, max_sfb 0, no tools, then END: 32 bits.
  const silentFrame = u8(0x00, 0x00, 0x00, 0x07);
  const brand = opts.brand ?? 'M4A ';

  const ftyp = box('ftyp', utf8(brand), be32(0), utf8(brand), utf8('mp42'), utf8('isom'));

  const items: Uint8Array[] = [
    ...ilstString('\xa9nam', tags.title),
    ...ilstString('\xa9ART', tags.artist),
    ...ilstString('aART', tags.albumArtist),
    ...ilstString('\xa9alb', tags.album),
    ...ilstString('\xa9day', tags.date),
    ...ilstString('\xa9nrt', tags.narrator),
    ...ilstString('\xa9mvn', tags.series),
  ];
  if (tags.trackNo !== undefined) items.push(ilstItem('trkn', 0, concat([be16(0), be16(tags.trackNo), be16(tags.trackOf ?? 0), be16(0)])));
  if (tags.discNo !== undefined) items.push(ilstItem('disk', 0, concat([be16(0), be16(tags.discNo), be16(tags.discOf ?? 0)])));
  if (tags.compilation) items.push(ilstItem('cpil', 21, u8(1)));
  if (tags.seriesPart !== undefined && /^\d+$/.test(tags.seriesPart)) items.push(ilstItem('\xa9mvi', 21, be16(Number(tags.seriesPart))));
  items.push(
    ...ilstFreeform('MusicBrainz Track Id', tags.mbRecordingId),
    ...ilstFreeform('MusicBrainz Release Track Id', tags.mbReleaseTrackId),
    ...ilstFreeform('MusicBrainz Album Id', tags.mbReleaseId),
    ...ilstFreeform('MusicBrainz Release Group Id', tags.mbReleaseGroupId),
    ...ilstFreeform('MusicBrainz Artist Id', tags.mbArtistId),
    ...ilstFreeform('MusicBrainz Album Artist Id', tags.mbAlbumArtistId),
    ...ilstFreeform('ASIN', tags.asin),
    ...ilstFreeform('ISBN', tags.isbn),
  );

  const meta = fullBox(
    'meta',
    0,
    0,
    fullBox('hdlr', 0, 0, be32(0), utf8('mdir'), utf8('appl'), new Uint8Array(8), u8(0)),
    box('ilst', ...items),
  );
  const chpl =
    opts.chapters && opts.chapters.length > 0
      ? [
          fullBox(
            'chpl',
            1,
            0,
            be32(0),
            u8(opts.chapters.length),
            ...opts.chapters.flatMap((c) => {
              const title = utf8(c.title);
              return [be64(Math.round(c.startMs * 10_000)), u8(title.length), title];
            }),
          ),
        ]
      : [];
  const udta = box('udta', ...chpl, meta);

  const buildMoov = (chunkOffset: number) => {
    const mvhd = fullBox('mvhd', 0, 0, be32(0), be32(0), be32(1000), be32(movieDuration), be32(0x00010000), be16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), be32(2));
    const tkhd = fullBox('tkhd', 0, 7, be32(0), be32(0), be32(1), be32(0), be32(movieDuration), new Uint8Array(8), be16(0), be16(0), be16(0x0100), be16(0), MATRIX, be32(0), be32(0));
    const mdhd = fullBox('mdhd', 0, 0, be32(0), be32(0), be32(sampleRate), be32(mediaDuration), be16(0x55c4), be16(0));
    const hdlr = fullBox('hdlr', 0, 0, be32(0), utf8('soun'), new Uint8Array(12), utf8('SoundHandler'), u8(0));
    const esds = fullBox(
      'esds',
      0,
      0,
      descriptor(
        0x03,
        concat([
          be16(1),
          u8(0),
          descriptor(0x04, concat([u8(0x40, 0x15), be24(0), be32(0), be32(0), descriptor(0x05, u8(0x12, 0x08))])),
          descriptor(0x06, u8(0x02)),
        ]),
      ),
    );
    const mp4a = box('mp4a', new Uint8Array(6), be16(1), new Uint8Array(8), be16(1), be16(16), be16(0), be16(0), be32(sampleRate << 16), esds);
    const stbl = box(
      'stbl',
      fullBox('stsd', 0, 0, be32(1), mp4a),
      fullBox('stts', 0, 0, be32(1), be32(sampleCount), be32(frameSamples)),
      fullBox('stsc', 0, 0, be32(1), be32(1), be32(sampleCount), be32(1)),
      fullBox('stsz', 0, 0, be32(silentFrame.length), be32(sampleCount)),
      fullBox('stco', 0, 0, be32(1), be32(chunkOffset)),
    );
    const minf = box('minf', fullBox('smhd', 0, 0, be16(0), be16(0)), box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1))), stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    return box('moov', mvhd, trak, udta);
  };

  const moovSize = buildMoov(0).length;
  const moov = buildMoov(ftyp.length + moovSize + 8);
  const media = new Uint8Array(silentFrame.length * sampleCount);
  for (let i = 0; i < sampleCount; i++) media.set(silentFrame, i * silentFrame.length);
  return concat([ftyp, moov, box('mdat', media)]);
}

// ---------------------------------------------------------------------------------------
// WAV (PCM, for the "untagged" path)
// ---------------------------------------------------------------------------------------

export function buildWav(opts: { durationMs: number; sampleRate?: number }): Uint8Array {
  const rate = opts.sampleRate ?? 8000;
  const samples = Math.round((opts.durationMs / 1000) * rate);
  const data = new Uint8Array(samples * 2);
  const le16 = (n: number) => u8(n & 0xff, (n >>> 8) & 0xff);
  const fmt = concat([utf8('fmt '), le32(16), le16(1), le16(1), le32(rate), le32(rate * 2), le16(2), le16(16)]);
  const body = concat([utf8('WAVE'), fmt, utf8('data'), le32(data.length), data]);
  return concat([utf8('RIFF'), le32(body.length), body]);
}
