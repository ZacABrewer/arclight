// Regenerates the committed audio fixtures in this folder:
//   npx tsx src/modules/imports/audio/fixtures/generate.ts
// Every value below is invented (ids are made-up UUID-shaped strings); no personal data.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFlac, buildMp3, buildMp4, buildWav, type FixtureTags } from './builders.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_IDS = {
  releaseGroup: '00000000-0000-4000-8000-0000000000a1',
  release: '00000000-0000-4000-8000-0000000000b1',
  artist: '00000000-0000-4000-8000-0000000000c1',
  recording1: '00000000-0000-4000-8000-0000000000d1',
  recording2: '00000000-0000-4000-8000-0000000000d2',
  recording3: '00000000-0000-4000-8000-0000000000d3',
} as const;

const album: FixtureTags = {
  artist: 'Fixture Artist',
  albumArtist: 'Fixture Artist',
  album: 'Silent Album',
  date: '2001-02-03',
  trackOf: 3,
  discNo: 1,
  discOf: 1,
  mbReleaseId: FIXTURE_IDS.release,
  mbReleaseGroupId: FIXTURE_IDS.releaseGroup,
  mbArtistId: FIXTURE_IDS.artist,
  mbAlbumArtistId: FIXTURE_IDS.artist,
};

export const FIXTURES: Record<string, () => Uint8Array> = {
  'tagged.flac': () => buildFlac({ durationMs: 3000, tags: { ...album, title: 'First Light', trackNo: 1, mbRecordingId: FIXTURE_IDS.recording1 } }),
  'tagged.mp3': () => buildMp3({ durationMs: 3000, tags: { ...album, title: 'Second Wind', trackNo: 2, mbRecordingId: FIXTURE_IDS.recording2 } }),
  'tagged.m4a': () => buildMp4({ durationMs: 3000, tags: { ...album, title: 'Third Time', trackNo: 3, mbRecordingId: FIXTURE_IDS.recording3 } }),
  'chapters.m4b': () =>
    buildMp4({
      brand: 'M4B ',
      durationMs: 6000,
      tags: {
        title: 'A Quiet Book',
        artist: 'Fixture Author',
        albumArtist: 'Fixture Author',
        album: 'A Quiet Book',
        date: '2020',
        narrator: 'Fixture Narrator',
        series: 'Quiet Series',
        seriesPart: '2',
        asin: 'B000000000',
      },
      chapters: [
        { title: 'Opening', startMs: 0 },
        { title: 'Middle', startMs: 2000 },
        { title: 'Ending', startMs: 4000 },
      ],
    }),
  'untagged.wav': () => buildWav({ durationMs: 1000 }),
  // A FLAC signature followed by garbage: the in-process parser must reject it.
  'corrupt.flac': () => Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0x7f, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04]),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, build] of Object.entries(FIXTURES)) {
    const bytes = build();
    writeFileSync(join(here, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}
