import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveError, extractSubtitle, parseEntryEpisode, pickEntry, readZip, sniffArchive, writeZip } from './archive.js';
import { decodeSubtitle, toUtf8 } from './encoding.js';
import { convertToSrt, detectFormat, isValidSrt, looksHearingImpaired, parseAss, parseMicroDvd, parseSrt } from './formats.js';
import { computeOpenSubtitlesHash, openSubtitlesHash, openSubtitlesHashOfBuffer } from './hash.js';
import { languageName, languageString, parseLanguageString, parseLanguageTag, toAlpha3, LANGUAGES } from './languages.js';
import { nameSubtitleFile, parseSubtitleFileName } from './naming.js';
import { buildAlassCommand, buildFfsubsyncCommand, buildPostProcessCommand, shouldPostProcess, shouldSync, splitCommandLine, syncedOutputPath } from './postprocess.js';
import { xzDecompress } from './xz.js';

const fixture = (p: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${p}`, import.meta.url)));
const enc = (s: string) => new TextEncoder().encode(s);
const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi\n';

describe('OpenSubtitles hash', () => {
  it('all-zero 128 KiB file hashes to its size', () => {
    expect(openSubtitlesHashOfBuffer(new Uint8Array(131072))).toBe('0000000000020000');
  });
  it('adds little-endian words from head and tail', () => {
    const buf = new Uint8Array(131072);
    buf[0] = 1; // head word 1
    buf[131072 - 8] = 2; // last tail word = 2
    buf[9] = 1; // second head word = 256
    expect(openSubtitlesHashOfBuffer(buf)).toBe((131072 + 1 + 2 + 256).toString(16).padStart(16, '0'));
  });
  it('wraps around at 64 bits (all 0xFF)', () => {
    // 16384 words of 2^64-1 sum to -16384 mod 2^64; plus 131072 = 114688 = 0x1c000.
    expect(openSubtitlesHashOfBuffer(new Uint8Array(131072).fill(0xff))).toBe('000000000001c000');
  });
  it('only reads the first and last 64 KiB', () => {
    const big = new Uint8Array(300000);
    big[150000] = 0xff; // middle byte ignored
    expect(openSubtitlesHashOfBuffer(big)).toBe((300000).toString(16).padStart(16, '0'));
    expect(openSubtitlesHash(10, new Uint8Array(8), new Uint8Array(8))).toBe('000000000000000a');
  });
  it('is undefined for files under 128 KiB and matches the buffer hash on disk', async () => {
    expect(openSubtitlesHashOfBuffer(new Uint8Array(1000))).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'mt-subs-'));
    const data = new Uint8Array(200000).map((_, i) => (i * 31) & 0xff);
    writeFileSync(join(dir, 'v.mkv'), data);
    expect(await computeOpenSubtitlesHash(join(dir, 'v.mkv'))).toBe(openSubtitlesHashOfBuffer(data));
  });
});

describe('archives', () => {
  it('sniffs archive types by content', () => {
    expect(sniffArchive(writeZip([{ name: 'a.srt', data: enc(SRT) }]))).toBe('zip');
    expect(sniffArchive(enc('Rar!\x1a\x07\x00'))).toBe('rar');
    expect(sniffArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(sniffArchive(gzipSync(enc(SRT)))).toBe('gzip');
    expect(sniffArchive(fixture('archive/sample.srt.xz'))).toBe('xz');
    expect(sniffArchive(enc(SRT))).toBe('none');
  });
  it('reads store and deflate zip entries', async () => {
    const stored = readZip(writeZip([{ name: 'x/a.srt', data: enc(SRT) }]));
    expect(stored[0]!.name).toBe('x/a.srt');
    expect(new TextDecoder().decode(stored[0]!.read())).toBe(SRT);
    // Build a deflate entry by rewriting a stored zip's method and payload.
    const { deflateRawSync } = await import('node:zlib');
    const comp = deflateRawSync(enc(SRT));
    const zip = writeZip([{ name: 'b.srt', data: new Uint8Array(comp) }]);
    const v = new DataView(zip.buffer);
    v.setUint16(8, 8, true); // local method
    v.setUint32(22, SRT.length, true);
    const cd = v.getUint32(zip.length - 22 + 16, true);
    v.setUint16(cd + 10, 8, true);
    v.setUint32(cd + 24, SRT.length, true);
    expect(new TextDecoder().decode(readZip(zip)[0]!.read())).toBe(SRT);
  });
  it('decompresses xz (single block, crc32/none checks, uncompressed chunks)', () => {
    expect(Buffer.from(xzDecompress(fixture('archive/sample.srt.xz'))).equals(Buffer.from(fixture('archive/sample.srt')))).toBe(true);
    expect(Buffer.from(xzDecompress(fixture('archive/sample-nocheck.srt.xz'))).equals(Buffer.from(fixture('archive/sample.srt')))).toBe(true);
    expect(Buffer.from(xzDecompress(fixture('archive/mixed.bin.xz'))).equals(Buffer.from(fixture('archive/mixed.bin')))).toBe(true);
  });
  it('extracts from gzip and xz payloads', () => {
    const fromGz = extractSubtitle({ bytes: gzipSync(enc(SRT)), format: 'unknown', encoding: 'unknown', fileName: 'a.srt.gz' });
    expect(new TextDecoder().decode(fromGz.bytes)).toBe(SRT);
    expect(fromGz.format).toBe('srt');
    const fromXz = extractSubtitle({ bytes: fixture('archive/sample.srt.xz'), format: 'unknown', encoding: 'unknown', fileName: '1.xz' });
    expect(fromXz.format).toBe('srt');
  });
  it('refuses rar and 7z', () => {
    expect(() => extractSubtitle({ bytes: enc('Rar!\x1a\x07\x00rest'), format: 'unknown', encoding: 'unknown' })).toThrow(ArchiveError);
  });
  it('picks the target episode from a season pack, skipping junk and forced', () => {
    const zip = writeZip([
      { name: '__MACOSX/._Show.S01E02.srt', data: enc('junk') },
      { name: 'readme.txt', data: enc('hi') },
      { name: 'Show.S01E01.srt', data: enc(SRT) },
      { name: 'Show.S01E02.srt', data: enc(SRT.replace('Hello', 'Two')) },
      { name: 'Show.S01E02.forced.srt', data: enc(SRT.replace('Hello', 'Forced')) },
    ]);
    const out = extractSubtitle({ bytes: zip, format: 'unknown', encoding: 'unknown' }, { season: 1, episode: 2 });
    expect(out.fileName).toBe('Show.S01E02.srt');
    const forced = extractSubtitle({ bytes: zip, format: 'unknown', encoding: 'unknown' }, { season: 1, episode: 2, forced: true });
    expect(forced.fileName).toBe('Show.S01E02.forced.srt');
  });
  it('parses episode numbers from entry names and tiers unsure entries', () => {
    expect(parseEntryEpisode('Show.1x05.srt')).toEqual({ season: 1, episode: 5 });
    expect(parseEntryEpisode('[Sub] Anime - 12 [1080p].ass')).toEqual({ episode: 12 });
    expect(pickEntry([{ name: 'Show.S01E09.srt' }, { name: 'Show.srt' }], { episode: 3 })?.name).toBe('Show.srt');
    expect(pickEntry([{ name: 'a.WEB.srt' }, { name: 'a.HDTV.LOL.srt' }], { releaseName: 'Show.S01E01.HDTV.x264-LOL' })?.name).toBe('a.HDTV.LOL.srt');
  });
  it('archive without subtitles fails', () => {
    expect(() => extractSubtitle({ bytes: writeZip([{ name: 'a.nfo', data: enc('x') }]), format: 'unknown', encoding: 'unknown' })).toThrow(/no subtitle/);
  });
});

describe('encoding sniffing', () => {
  it('honours BOMs', () => {
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).text).toBe('A');
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    expect(decodeSubtitle(le)).toMatchObject({ text: 'AB', encoding: 'utf-16le', method: 'bom' });
  });
  it('prefers strict UTF-8', () => {
    expect(decodeSubtitle(enc('Café ñ'))).toMatchObject({ text: 'Café ñ', method: 'utf-8' });
  });
  it('uses language code pages: Cyrillic windows-1251', () => {
    const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // Привет
    expect(decodeSubtitle(bytes, { language: 'ru' })).toMatchObject({ text: 'Привет', encoding: 'windows-1251', method: 'language' });
  });
  it('uses language code pages: Polish windows-1250', () => {
    const bytes = new Uint8Array([0x9c, 0x6c, 0x69, 0x77, 0x6b, 0x61]); // śliwka
    expect(decodeSubtitle(bytes, { language: 'pl' }).text).toBe('śliwka');
  });
  it('uses language code pages: Chinese GBK and Japanese Shift_JIS', () => {
    expect(decodeSubtitle(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), { language: 'zh-Hans' }).text).toBe('你好');
    expect(decodeSubtitle(new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]), { language: 'ja' }).text).toBe('こんにちは');
  });
  it('declared encoding wins when it decodes', () => {
    expect(decodeSubtitle(new Uint8Array([0xe9]), { declared: 'iso-8859-1' })).toMatchObject({ text: 'é', method: 'declared' });
  });
  it('falls back to western code pages without a language', () => {
    expect(decodeSubtitle(new Uint8Array([0x43, 0x61, 0x66, 0xe9])).text).toBe('Café');
  });
  it('toUtf8 normalises CRLF and re-encodes', () => {
    const out = toUtf8(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0d, 0x0a]), { language: 'fr' });
    expect(out.text).toBe('Café\n');
    expect(Array.from(out.bytes)).toEqual([0x43, 0x61, 0x66, 0xc3, 0xa9, 0x0a]);
  });
});

describe('formats', () => {
  it('detects srt, ass, vtt, microdvd', () => {
    expect(detectFormat(SRT)).toBe('srt');
    expect(detectFormat('[Script Info]\nScriptType: v4.00+\n')).toBe('ass');
    expect(detectFormat('[Script Info]\nScriptType: v4.00\n')).toBe('ssa');
    expect(detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nhi')).toBe('vtt');
    expect(detectFormat('{0}{25}Hello|World')).toBe('sub');
    expect(detectFormat('garbage')).toBe('unknown');
  });
  it('converts ASS to SRT', () => {
    const ass = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hello,{\\i0} world\\Nline two\n';
    expect(parseAss(ass)).toEqual([{ startMs: 1500, endMs: 3000, text: 'Hello, world\nline two' }]);
    expect(convertToSrt(ass)).toBe('1\n00:00:01,500 --> 00:00:03,000\nHello, world\nline two\n');
  });
  it('converts VTT to SRT', () => {
    const vtt = 'WEBVTT\n\nNOTE x\n\n1\n00:00:01.000 --> 00:00:02.000 align:start\n<v Bob>Hi</v>\n\n00:03.500 --> 00:04.000\nShort';
    expect(convertToSrt(vtt)).toBe('1\n00:00:01,000 --> 00:00:02,000\n<v Bob>Hi\n\n2\n00:00:03,500 --> 00:00:04,000\nShort\n'.replace('<v Bob>', ''));
  });
  it('converts MicroDVD using fps and the declared rate line', () => {
    expect(parseMicroDvd('{25}{50}A|B', 25)).toEqual([{ startMs: 1000, endMs: 2000, text: 'A\nB' }]);
    expect(parseMicroDvd('{1}{1}50\n{50}{100}X', 25)[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
  });
  it('validates SubRip and parses tolerant input', () => {
    expect(isValidSrt(SRT)).toBe(true);
    expect(isValidSrt('nope')).toBe(false);
    expect(parseSrt('00:00:01.000 --> 00:00:02.000\r\nNo index\r\n')).toHaveLength(1);
  });
  it('HI heuristic: brackets and music, parentheses except Arabic', () => {
    expect(looksHearingImpaired('1\n00:00:01,000 --> 00:00:02,000\n[door creaks]\n')).toBe(true);
    expect(looksHearingImpaired('1\n00:00:01,000 --> 00:00:02,000\n♪ la la ♪\n')).toBe(true);
    expect(looksHearingImpaired('1\n00:00:01,000 --> 00:00:02,000\n(sighs)\n', 'en')).toBe(true);
    expect(looksHearingImpaired('1\n00:00:01,000 --> 00:00:02,000\n(sighs)\n', 'ar')).toBe(false);
    expect(looksHearingImpaired(SRT)).toBe(false);
  });
});

describe('languages', () => {
  it('has the full ISO 639-1 table', () => {
    expect(LANGUAGES.filter((l) => l.alpha2).length).toBe(184);
    expect(toAlpha3('fr', 'b')).toBe('fre');
    expect(toAlpha3('fr', 't')).toBe('fra');
  });
  it('normalises spellings to tags', () => {
    expect(parseLanguageTag('eng')).toBe('en');
    expect(parseLanguageTag('ger')).toBe('de');
    expect(parseLanguageTag('pob')).toBe('pt-BR');
    expect(parseLanguageTag('zh_tw')).toBe('zh-TW');
    expect(parseLanguageTag('zht')).toBe('zh-Hant');
    expect(parseLanguageTag('srp-latn')).toBe('sr-Latn');
    expect(parseLanguageTag('English')).toBe('en');
    expect(parseLanguageTag('Farsi')).toBe('fa');
    expect(parseLanguageTag('und')).toBeUndefined();
    expect(languageName('pt-BR')).toBe('Portuguese (Brazil)');
  });
  it('language strings (R1.4)', () => {
    expect(languageString({ tag: 'en', forced: true, hi: true })).toBe('en:forced');
    expect(languageString({ tag: 'en', forced: false, hi: true })).toBe('en:hi');
    expect(parseLanguageString('pt-BR:hi')).toEqual({ tag: 'pt-BR', forced: false, hi: true });
  });
});

describe('naming', () => {
  it('follows the R9.1 table', () => {
    expect(nameSubtitleFile('/tv/Show/Show.S01E01.mkv', 'en')).toBe('/tv/Show/Show.S01E01.en.srt');
    expect(nameSubtitleFile('/tv/Show/Show.S01E01.mkv', 'en', { hi: true })).toBe('/tv/Show/Show.S01E01.en.hi.srt');
    expect(nameSubtitleFile('/tv/Show/Show.S01E01.mkv', 'en', { forced: true, hi: true })).toBe('/tv/Show/Show.S01E01.en.forced.srt');
    expect(nameSubtitleFile('/tv/Show/Show.S01E01.mkv', 'pob')).toBe('/tv/Show/Show.S01E01.pt-BR.srt');
    expect(nameSubtitleFile('Movie.2020.mkv', 'es', { hi: true }, { hiExtension: 'sdh' })).toBe('Movie.2020.es.sdh.srt');
    expect(nameSubtitleFile('Movie.2020.mkv', 'fr', {}, { singleLanguage: true })).toBe('Movie.2020.srt');
  });
  it('keeps Windows separators, formats and target folders', () => {
    expect(nameSubtitleFile('D:\\Movies\\Movie (2020)\\Movie.mkv', 'en', {}, { format: 'ass' })).toBe('D:\\Movies\\Movie (2020)\\Movie.en.ass');
    expect(nameSubtitleFile('/m/Movie.mkv', 'en', {}, { folder: { mode: 'relative', name: 'Subs' } })).toBe('/m/Subs/Movie.en.srt');
    expect(nameSubtitleFile('/m/Movie.mkv', 'en', {}, { folder: { mode: 'absolute', path: '/subs/' } })).toBe('/subs/Movie.en.srt');
  });
  it('parses external subtitle names back (R9.8)', () => {
    expect(parseSubtitleFileName('/m/Movie.mkv', '/m/Movie.en.forced.srt')).toEqual({ language: 'en', forced: true, hi: false, format: 'srt' });
    expect(parseSubtitleFileName('/m/Movie.mkv', '/m/Movie.pt-BR.sdh.ass')).toEqual({ language: 'pt-BR', forced: false, hi: true, format: 'ass' });
    expect(parseSubtitleFileName('/m/Movie.mkv', '/m/Movie.srt')?.language).toBeUndefined();
    expect(parseSubtitleFileName('/m/Movie.mkv', '/m/Other.en.srt')).toBeUndefined();
  });
});

describe('post-processing descriptors', () => {
  it('builds ffsubsync and alass argv', () => {
    expect(buildFfsubsyncCommand({ reference: 'v.mkv', subtitle: 's.srt', output: 's.synced.srt', referenceStream: 'a:0' })).toMatchObject({
      command: 'ffsubsync',
      args: ['v.mkv', '-i', 's.srt', '-o', 's.synced.srt', '--max-offset-seconds', '60', '--no-fix-framerate', '--gss', '--reference-stream', 'a:0'],
    });
    expect(buildAlassCommand({ reference: 'v.mkv', subtitle: 's.srt', output: 'o.srt', noSplit: true }).args).toEqual(['v.mkv', 's.srt', 'o.srt', '--no-split', '--disable-fps-guessing']);
    expect(syncedOutputPath('/a/Movie.en.srt')).toBe('/a/Movie.en.synced.srt');
  });
  it('sync and post-process eligibility thresholds', () => {
    const s = { enabled: true, useThreshold: true, threshold: 90 };
    expect(shouldSync(s, { forced: false, provider: 'subdl', percent: 90 })).toBe(true);
    expect(shouldSync(s, { forced: false, provider: 'subdl', percent: 95 })).toBe(false);
    expect(shouldSync(s, { forced: true, provider: 'subdl', percent: 50 })).toBe(false);
    expect(shouldPostProcess(true, true, 90, 90)).toBe(false);
    expect(shouldPostProcess(true, true, 90, 89.9)).toBe(true);
  });
  it('splits command lines and substitutes placeholders (R11.6)', () => {
    expect(splitCommandLine(`a "b c" 'd e' f\\ g`)).toEqual(['a', 'b c', 'd e', 'f g']);
    const cmd = buildPostProcessCommand('/usr/local/bin/notify.sh "{{episode_name}}" {{subtitles_language_code2}} {{score}} {{series_id}}', {
      videoPath: '/tv/Show/Show.S01E01.mkv',
      subtitlePath: '/tv/Show/Show.S01E01.en.forced.srt',
      language: 'en',
      forced: true,
      hi: false,
      percent: 97.5,
      subtitleId: '42',
      provider: 'subdl',
    });
    expect(cmd.command).toBe('/usr/local/bin/notify.sh');
    expect(cmd.args).toEqual(['Show.S01E01', 'en:forced', '97.5']);
    expect(cmd.env?.MEDIATRON_SUBTITLES_LANGUAGE_CODE3_DOT).toBe('eng.forced');
    expect(cmd.timeoutMs).toBe(60000);
  });
});
