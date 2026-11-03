// Synthetic fragmented MP4 for the HLS tests (like fingerprint.fixtures.ts). Just the
// boxes the splitter and the tfdt rewrite read: tkhd/mdhd/hdlr/stsd in the init, and
// moof → traf → tfhd/tfdt/trun + mdat per fragment.

export const VIDEO_ID = 1;
export const AUDIO_ID = 2;
export const VIDEO_TS = 90_000;
export const AUDIO_TS = 48_000;

export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const u32 = (...ns: number[]) => {
  const b = Buffer.alloc(4 * ns.length);
  ns.forEach((n, i) => b.writeUInt32BE(n >>> 0, i * 4));
  return b;
};

function trak(id: number, timescale: number, handler: 'vide' | 'soun', stsdTag: string): Buffer {
  const tkhd = box('tkhd', u32(0, 0, 0, id, 0), Buffer.alloc(60));
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, 0), Buffer.alloc(4));
  const hdlr = box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('h\0', 'latin1'));
  const stsd = box('stsd', u32(0, 1), box(stsdTag, Buffer.alloc(16)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
}

/** ftyp + moov with a video (90 kHz) and an audio (48 kHz) track; `tag` changes the stsd. */
export function initSegment(tag = 'avc1'): Buffer {
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), u32(512)), box('moov', box('mvhd', u32(0, 0, 0, 1000, 0)), trak(VIDEO_ID, VIDEO_TS, 'vide', tag), trak(AUDIO_ID, AUDIO_TS, 'soun', 'mp4a'))]);
}

function traf(id: number, decodeTime: bigint, cts: number | null): Buffer {
  const tfhd = box('tfhd', u32(0x020000, id));
  const t = Buffer.alloc(12);
  t.writeUInt32BE(0x01000000, 0);
  t.writeBigInt64BE(decodeTime, 4);
  const tfdt = box('tfdt', t);
  const trun = cts === null ? box('trun', u32(0, 1)) : box('trun', u32(0x000800, 1, cts));
  return box('traf', tfhd, tfdt, trun);
}

/** One moof + mdat with both tracks (decode times in each track's timescale). */
export function fragment(videoDecode: bigint, audioDecode: bigint, cts = 7500, payload = 100): Buffer {
  return Buffer.concat([box('moof', box('mfhd', u32(0, 1)), traf(VIDEO_ID, videoDecode, cts), traf(AUDIO_ID, audioDecode, null)), box('mdat', Buffer.alloc(payload, 7))]);
}

/** The decode times of every traf in a segment file (moof by moof). */
export function decodeTimes(seg: Buffer): Array<{ track: number; t: bigint }> {
  const out: Array<{ track: number; t: bigint }> = [];
  let p = 0;
  while (p + 8 <= seg.length) {
    const size = seg.readUInt32BE(p);
    const type = seg.toString('latin1', p + 4, p + 8);
    if (type === 'moof') {
      let q = p + 8;
      while (q < p + size) {
        const s = seg.readUInt32BE(q);
        if (seg.toString('latin1', q + 4, q + 8) === 'traf') {
          let r = q + 8;
          let track = 0;
          while (r < q + s) {
            const bs = seg.readUInt32BE(r);
            const bt = seg.toString('latin1', r + 4, r + 8);
            if (bt === 'tfhd') track = seg.readUInt32BE(r + 12);
            if (bt === 'tfdt') out.push({ track, t: seg.readBigUInt64BE(r + 12) });
            r += bs;
          }
        }
        q += s;
      }
    }
    p += size;
  }
  return out;
}

/**
 * A fragment with real sample tables, as ffmpeg writes them: one 10-byte video sample and audio
 * samples of the given sizes (1024 ticks each, a tfhd default), data offsets from the moof start.
 * `audioFirst` puts the audio bytes before the video bytes in the mdat.
 */
export function sampledFragment(videoDecode: bigint, audioDecode: bigint, audioSizes: number[], audioFirst = false): Buffer {
  const build = (videoOff: number, audioOff: number) => {
    const t = (decodeTime: bigint) => {
      const b = Buffer.alloc(12);
      b.writeUInt32BE(0x01000000, 0);
      b.writeBigInt64BE(decodeTime, 4);
      return box('tfdt', b);
    };
    const v = box('traf', box('tfhd', u32(0x020000, VIDEO_ID)), t(videoDecode), box('trun', u32(0x000201, 1, videoOff, 10)));
    const a = box('traf', box('tfhd', u32(0x020008, AUDIO_ID, 1024)), t(audioDecode), box('trun', u32(0x000201, audioSizes.length, audioOff, ...audioSizes)));
    return box('moof', box('mfhd', u32(0, 1)), v, a);
  };
  const moofSize = build(0, 0).length;
  const audioBytes = audioSizes.reduce((s, n) => s + n, 0);
  const videoOff = moofSize + 8 + (audioFirst ? audioBytes : 0);
  const audioOff = moofSize + 8 + (audioFirst ? 0 : 10);
  const video = Buffer.alloc(10, 0xee);
  const audio = Buffer.concat(audioSizes.map((n, i) => Buffer.alloc(n, i + 1)));
  return Buffer.concat([build(videoOff, audioOff), box('mdat', audioFirst ? audio : video, audioFirst ? video : audio)]);
}

/** Each track's samples (bytes) of a one-fragment buffer, read through the trun data offsets. */
export function samplesOf(frag: Buffer): Map<number, Buffer[]> {
  const out = new Map<number, Buffer[]>();
  const moofSize = frag.readUInt32BE(0);
  let q = 8 + frag.readUInt32BE(8); // after mfhd
  while (q < moofSize) {
    const s = frag.readUInt32BE(q);
    let r = q + 8;
    let track = 0;
    let defSize = 0;
    while (r < q + s) {
      const bs = frag.readUInt32BE(r);
      const bt = frag.toString('latin1', r + 4, r + 8);
      if (bt === 'tfhd') {
        track = frag.readUInt32BE(r + 12);
        if (frag.readUInt32BE(r + 8) & 0x10) defSize = frag.readUInt32BE(r + 16);
      }
      if (bt === 'trun') {
        const count = frag.readUInt32BE(r + 12);
        let off = frag.readInt32BE(r + 16);
        const list: Buffer[] = [];
        for (let i = 0; i < count; i++) {
          const size = frag.readUInt32BE(r + 20 + i * 4) || defSize;
          list.push(frag.subarray(off, off + size));
          off += size;
        }
        out.set(track, list);
      }
      r += bs;
    }
    q += s;
  }
  return out;
}
