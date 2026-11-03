import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TranscodeOptions } from '@arclight/shared';
import { decodeArgs } from '../health-scan/checks.js';
import { replayGainArgs, splitArgs, tagWriteArgs } from '../imports/audio/audio-tools.js';
import { createFfprobeTagReader } from '../imports/audio/tags.js';
import { createFfprobe } from '../subtitles/scan.js';
import { buildAudioExtractArgs } from '../playback/segments.js';
import { buildAudioTranscodeArgs } from '../playback/transcode.js';
import { buildTrickplayArgs } from '../playback/trickplay.js';
import { buildSubtitleArgs, buildThumbnailArgs, buildVideoStreamArgs } from '../playback/video-info.js';
import { tagArgs } from '../podcasts/tagger.js';
import { buildFfmpegArgs, capabilityTestArgs } from './ffmpeg.js';
import { ffprobeArgs, fileInput, INPUT_PROTOCOLS } from './input-protocols.js';

/** Every `-i` comes right after `-protocol_whitelist file,pipe`; returns the inputs. */
function guardedInputs(args: readonly string[]): string[] {
  const inputs: string[] = [];
  args.forEach((a, i) => {
    if (a !== '-i') return;
    expect(args.slice(i - 2, i), `input ${args[i + 1]}`).toEqual(['-protocol_whitelist', 'file,pipe']);
    inputs.push(args[i + 1]!);
  });
  return inputs;
}

describe('ffmpeg and ffprobe inputs only open local files and pipes (DATA-32)', () => {
  it('builds the guard', () => {
    expect(INPUT_PROTOCOLS).toBe('file,pipe');
    expect(fileInput('/m/a.mkv')).toEqual(['-protocol_whitelist', 'file,pipe', '-i', '/m/a.mkv']);
    expect(ffprobeArgs(['-v', 'error'], '/m/a.mkv')).toEqual(['-v', 'error', '-protocol_whitelist', 'file,pipe', '/m/a.mkv']);
  });

  it('playback: video stream (with an external burn-in), subtitles, thumbnails, audio, trickplay, segments', () => {
    const base = { audioTrack: 0, audioCodec: 'aac', audioChannelsIn: 2, copyAudio: true, audioChannels: 2, startMs: 5000 } as const;
    expect(guardedInputs(buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'remux' }))).toEqual(['/m/a.mkv']);
    const burn = buildVideoStreamArgs('/m/a.mkv', { ...base, method: 'transcode', hwaccel: 'qsv', burn: { path: '/m/a.sup' } });
    expect(guardedInputs(burn)).toEqual(['/m/a.mkv', '/m/a.sup']);
    // Seeking stays an input option of each input.
    expect(burn.join(' ')).toContain('-ss 5.000 -protocol_whitelist file,pipe -i /m/a.mkv');
    expect(guardedInputs(buildSubtitleArgs('/m/a.srt', null, '/c/x.vtt', 'CP1252'))).toEqual(['/m/a.srt']);
    expect(guardedInputs(buildThumbnailArgs('/m/a.mkv', 1000, '/c/x.jpg'))).toEqual(['/m/a.mkv']);
    expect(guardedInputs(buildAudioTranscodeArgs('/m/a.flac', { format: 'aac', bitrateKbps: 192, startMs: 1000 }))).toEqual(['/m/a.flac']);
    expect(guardedInputs(buildTrickplayArgs('/m/a.mkv', '/c/t', { tonemap: false }))).toEqual(['/m/a.mkv']);
    expect(guardedInputs(buildAudioExtractArgs('/m/a.mkv', 0, 1000, 2000))).toEqual(['/m/a.mkv']);
  });

  it('transcode jobs; the lavfi capability test is generated and needs no guard', () => {
    const opts = TranscodeOptions.parse({ container: 'mkv', videoCodec: 'h264', hwaccel: 'none' });
    expect(guardedInputs(buildFfmpegArgs('/in/a.mkv', '/in/.t.mkv', { action: 'transcode', options: opts }, null))).toEqual(['/in/a.mkv']);
    const cap = capabilityTestArgs('none');
    expect(cap[cap.indexOf('-i') - 1]).toBe('lavfi');
  });

  it('music imports, health scan and podcast tagging', () => {
    expect(guardedInputs(splitArgs({ source: '/dl/img.wav', destination: '/st/a.flac', startMs: 1000, endMs: 2000, lossless: true, tags: {} }))).toEqual(['/dl/img.wav']);
    expect(guardedInputs(tagWriteArgs('/lib/a.flac', '/lib/.t.flac', { tags: {}, coverPath: '/lib/cover.jpg' }))).toEqual(['/lib/a.flac', '/lib/cover.jpg']);
    expect(guardedInputs(replayGainArgs('/lib/a.flac', { startMs: 1000, endMs: 2000 }))).toEqual(['/lib/a.flac']);
    expect(guardedInputs(decodeArgs('/m/x.mkv', { start: 10, length: 10 }, 'video'))).toEqual(['/m/x.mkv']);
    const podcast = tagArgs({ file: '/p/e.mp3', coverFile: '/p/c.jpg', tags: { title: 'T', podcast: 'P' } } as Parameters<typeof tagArgs>[0], '/p/.e.mp3', '/p/ch.txt');
    expect(guardedInputs(podcast)).toEqual(['/p/e.mp3', '/p/c.jpg', '/p/ch.txt']);
  });

  it('ffprobe readers put the guard right before the path', async () => {
    const seen: string[][] = [];
    const reader = createFfprobeTagReader({
      runner: { locate: async () => '/fake/ffprobe' } as never,
      exec: async (_bin, args) => {
        seen.push([...args]);
        return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }), stderr: '' };
      },
    });
    await reader.read('/m/a.flac').catch(() => undefined);
    const probe = createFfprobe(
      async (_bin, args) => {
        seen.push([...args]);
        return { ok: true, code: 0, stdout: Buffer.from('{"streams":[]}'), stderr: '' } as never;
      },
      () => '/fake/ffprobe',
    );
    await probe('/m/b.mkv');
    expect(seen).toHaveLength(2);
    for (const args of seen) expect(args.slice(-3, -1)).toEqual(['-protocol_whitelist', 'file,pipe']);
  });

  it('no other source file passes an input to ffmpeg without the guard', () => {
    const modules = join(fileURLToPath(new URL('.', import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          const text = readFileSync(p, 'utf8');
          // The capability test's lavfi source is the only literal `-i`; input-protocols.ts holds
          // fileInput() and generatedInput().
          const hits = text.match(/'-i'/g)?.length ?? 0;
          const allowed = p.endsWith(join('transcode', 'ffmpeg.ts')) ? 1 : p.endsWith('input-protocols.ts') ? 2 : 0;
          if (hits > allowed) offenders.push(p);
        }
      }
    };
    walk(modules);
    expect(offenders).toEqual([]);
  });
});
