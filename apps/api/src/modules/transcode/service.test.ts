import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { history, mediaFiles, settings } from '../../db/schema.js';
import { TranscodeError } from './service.js';
import { EAC3_LAYOUT_FAIL, NOW, ruleInput, setup, waitFor, type Fixture } from './test-support.js';

let fx: Fixture;

afterEach(async () => {
  if (fx) await rm(fx.tmp, { recursive: true, force: true });
});

const fileRow = (id: number) => fx.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get()!;
const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;

describe('TranscodeService rules', () => {
  it('CRUD round trip with defaults and validation', async () => {
    fx = await setup();
    const r = fx.service.createRule(ruleInput({ name: 'HEVC', action: 'transcode', options: { videoCodec: 'hevc' }, schedule: { start: '01:00', end: '06:00' } }));
    expect(r).toMatchObject({ enabled: true, mediaType: 'all', scope: { kind: 'all' }, keepOriginal: false, schedule: { start: '01:00', end: '06:00' } });
    expect(r.options).toMatchObject({ container: 'mkv', videoCodec: 'hevc', audio: 'copy', keepLanguages: [], dropSubtitles: false, hwaccel: 'none' });
    expect(fx.service.updateRule(r.id, ruleInput({ name: 'Renamed' })).name).toBe('Renamed');
    expect(() => fx.service.createRule(ruleInput({ action: 'transcode', options: { videoCodec: 'av1', hwaccel: 'videotoolbox' } }))).toThrow(TranscodeError);
    fx.service.deleteRule(r.id);
    expect(() => fx.service.getRule(r.id)).toThrow(/not found/);
  });

  it('matches files by scope (tags/profile) and conditions', async () => {
    fx = await setup();
    const tagged = fx.service.createRule(ruleInput({ name: 'tagged', scope: { kind: 'tags', tagIds: [1] } }));
    const profile2 = fx.service.createRule(ruleInput({ name: 'p2', scope: { kind: 'profiles', qualityProfileIds: [2] } }));
    const hdr = fx.service.createRule(ruleInput({ name: 'hdr', when: { hdr: true } }));
    expect(fx.service.matchingRules(fx.movieFileId).map((r) => r.id)).toEqual([tagged.id, hdr.id]);
    expect(fx.service.matchingRules(fx.episodeFileId).map((r) => r.id)).toEqual([profile2.id]);
  });

  it('runForFile picks the first enabled matching rule, else 400; duplicates are 409', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'off', enabled: false }));
    expect(() => fx.service.runForFile(fx.episodeFileId)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    const hevc = fx.service.createRule(ruleInput({ name: 'hevc-only', when: { videoCodec: 'hevc' } }));
    const res = fx.service.runForFile(fx.movieFileId);
    expect(res.jobs[0]).toMatchObject({ ruleId: hevc.id, ruleName: 'hevc-only', status: 'queued', trigger: 'manual', mediaFileId: fx.movieFileId });
    expect(() => fx.service.runForFile(fx.movieFileId)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => fx.service.runForFile(9999)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('runForRule queues every matching file once and skips files the rule already completed', async () => {
    fx = await setup();
    const rule = fx.service.createRule(ruleInput({ name: 'all' }));
    expect(fx.service.runForRule(rule.id).queued).toBe(2);
    expect(fx.service.runForRule(rule.id).queued).toBe(0); // both still queued
    await fx.service.process();
    expect(fx.service.listJobs('completed')).toHaveLength(2);
    expect(fx.service.runForRule(rule.id).queued).toBe(0);
  });
});

describe('TranscodeWorker', () => {
  it('remux in place: original to the recycle bin, path kept, history + notification + re-analysis', async () => {
    fx = await setup();
    fx.runner.progress = ['out_time_us=50000000\nprogress=continue\n', 'progress=end\n'];
    const rule = fx.service.createRule(ruleInput({ name: 'Remux', when: { videoCodec: 'hevc' } }));
    fx.service.runForFile(fx.movieFileId);
    const r = await fx.service.process();
    expect(r).toMatchObject({ completed: 1, failed: 0 });

    const job = fx.service.listJobs()[0]!;
    expect(job).toMatchObject({ status: 'completed', progress: 100, sizeBefore: 20, sizeAfter: 16 });
    expect(job.command).toMatch(/^\/usr\/bin\/ffmpeg -hide_banner .*-progress pipe:1 -nostats /);
    expect(job.message).toContain('recycled to');

    expect(await readFile(fx.moviePath, 'utf8')).toBe('transcoded-bytes');
    const binned = (await readdir(fx.binPath, { recursive: true })).filter((n) => n.endsWith('.mkv'));
    expect(binned.map((n) => basename(n))).toEqual(['Film (2021).mkv']);
    expect((await readdir(dirname(fx.moviePath))).filter((n) => n.includes('arclight-transcode'))).toEqual([]);

    const row = fileRow(fx.movieFileId);
    expect(row).toMatchObject({ path: fx.moviePath, sizeBytes: 16, mediaInfo: null });
    expect(fx.reanalyzed).toEqual([fx.movieFileId]);
    expect(fx.notices[0]).toMatchObject({ previousPath: fx.moviePath, sizeBefore: 20, sizeAfter: 16, rule: { id: rule.id } });
    const h = fx.db.select().from(history).all();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ eventType: 'fileTranscoded', mediaType: 'movie', movieId: fx.movieId, sourceTitle: fx.moviePath });
    expect(h[0]!.data).toMatchObject({ action: 'remux', rule: 'Remux', sizeBefore: '20', size: '16' });
    expect(fx.events).toContainEqual({ type: 'library', action: 'updated', mediaType: 'movie', id: fx.movieId });
    expect(fx.events).toContainEqual({ type: 'history', action: 'added' });
  });

  it('container change updates path/relative_path; keepOriginal leaves the original alongside', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'mp4', keepOriginal: true, options: { container: 'mp4' } }));
    fx.service.runForFile(fx.episodeFileId);
    await fx.service.process();
    const newPath = fx.episodePath.replace(/\.mkv$/, '.mp4');
    expect(fileRow(fx.episodeFileId)).toMatchObject({ path: newPath, relativePath: 'Season 01/Show S01E01.mp4', sizeBytes: 16 });
    expect(await readFile(newPath, 'utf8')).toBe('transcoded-bytes');
    expect(await readFile(fx.episodePath, 'utf8')).toBe('original-episode');
    expect(await exists(fx.binPath)).toBe(false);
    expect(fx.runner.calls[0]).toContain('mp4');
    const h = fx.db.select().from(history).all();
    expect(h[0]).toMatchObject({ eventType: 'fileTranscoded', mediaType: 'series', seriesId: fx.seriesId });
    expect(h[0]!.episodeId).not.toBeNull();
  });

  it('keepOriginal with the same name renames the original to .original', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'keep', keepOriginal: true }));
    fx.service.runForFile(fx.movieFileId);
    await fx.service.process();
    expect(await readFile(fx.moviePath, 'utf8')).toBe('transcoded-bytes');
    expect(await readFile(fx.moviePath.replace(/\.mkv$/, '.original.mkv'), 'utf8')).toBe('original-movie-bytes');
  });

  it('uses the mediaManagement recycle bin setting; without one the original is deleted', async () => {
    fx = await setup({ recycleBin: false });
    fx.service.createRule(ruleInput({ name: 'r' }));
    fx.service.runForFile(fx.movieFileId);
    await fx.service.process();
    expect(fx.service.listJobs()[0]!.message).toContain('original deleted');

    const bin = join(fx.tmp, 'configured-bin');
    fx.db.insert(settings).values({ key: 'mediaManagement', value: { recycleBinPath: bin }, updatedAt: NOW.toISOString() }).run();
    fx.service.runForFile(fx.episodeFileId);
    await fx.service.process();
    expect((await readdir(bin, { recursive: true })).some((n) => n.endsWith('Show S01E01.mkv'))).toBe(true);
  });

  it('ffmpeg failure marks the job failed, removes the temp file, keeps the original', async () => {
    fx = await setup();
    fx.runner.exitCode = 1;
    fx.service.createRule(ruleInput({ name: 'r' }));
    fx.service.runForFile(fx.movieFileId);
    const r = await fx.service.process();
    expect(r.failed).toBe(1);
    const job = fx.service.listJobs()[0]!;
    expect(job.status).toBe('failed');
    expect(job.message).toContain('code 1: Conversion failed!');
    expect(await readFile(fx.moviePath, 'utf8')).toBe('original-movie-bytes');
    expect((await readdir(dirname(fx.moviePath))).sort()).toEqual(['Film (2021).mkv']);
  });

  describe('hardware fallback', () => {
    const QSV_FAIL = [
      '[AVHWDeviceContext @ 0x7f3990204340] No supported child device type is enabled',
      'Device creation failed: -38.',
      "Failed to set value 'qsv=hw' for option 'init_hw_device': Function not implemented",
      'Error parsing global options: Function not implemented',
    ].join('\n');
    const qsvRule = () => ruleInput({ name: 'To HEVC', action: 'transcode', options: { videoCodec: 'hevc', hwaccel: 'qsv', preset: 'slow', crf: 22 } });
    const failQsv = (args: readonly string[]) => (args.includes('hevc_qsv') ? { exitCode: 218, stderr: QSV_FAIL } : undefined);

    it('retries once in software and records why', async () => {
      fx = await setup();
      fx.runner.respond = failQsv;
      fx.service.createRule(qsvRule());
      fx.service.runForFile(fx.movieFileId);
      expect(await fx.service.process()).toMatchObject({ completed: 1, failed: 0 });

      expect(fx.runner.calls).toHaveLength(2);
      expect(fx.runner.calls[0]).toContain('hevc_qsv');
      const retry = fx.runner.calls[1]!;
      expect(retry).toContain('libx265');
      expect(retry).not.toContain('-init_hw_device');
      expect(retry).toEqual(expect.arrayContaining(['-crf', '22', '-preset', 'slow']));

      const job = fx.service.listJobs()[0]!;
      expect(job.status).toBe('completed');
      expect(job.command).toContain('libx265');
      expect(job.message).toContain('hardware acceleration (Intel Quick Sync (QSV)) was unavailable (No supported child device type is enabled); encoded in software instead');
      const h = fx.db.select().from(history).all();
      expect(h[0]!.data).toMatchObject({ hardwareFallback: expect.stringContaining('No supported child device type is enabled') });
      expect(await readFile(fx.moviePath, 'utf8')).toBe('transcoded-bytes');
    });

    it('drops a hardware-native preset on the software retry', async () => {
      fx = await setup();
      fx.runner.respond = (args) => (args.includes('hevc_nvenc') ? { exitCode: 1, stderr: '[AVHWDeviceContext @ 0x1] Cannot load libcuda.so.1\nDevice creation failed: -1.' } : undefined);
      fx.service.createRule(ruleInput({ name: 'nv', action: 'transcode', options: { videoCodec: 'hevc', hwaccel: 'nvenc', preset: 'p5' } }));
      fx.service.runForFile(fx.movieFileId);
      expect(await fx.service.process()).toMatchObject({ completed: 1 });
      expect(fx.runner.calls[1]).toContain('libx265');
      expect(fx.runner.calls[1]).not.toContain('-preset');
    });

    it('fails with the fix when fallbackToSoftware is off', async () => {
      fx = await setup();
      fx.service.saveSettings({ fallbackToSoftware: false });
      fx.runner.respond = failQsv;
      fx.service.createRule(qsvRule());
      fx.service.runForFile(fx.movieFileId);
      expect(await fx.service.process()).toMatchObject({ completed: 0, failed: 1 });
      expect(fx.runner.calls).toHaveLength(1);
      const job = fx.service.listJobs()[0]!;
      expect(job.status).toBe('failed');
      expect(job.message).toContain('hardware acceleration (Intel Quick Sync (QSV)) is unavailable: No supported child device type is enabled');
      expect(job.message).toContain('/dev/dri:/dev/dri');
      expect(job.message).toContain('docs/using/hardware-transcoding.md');
      expect(await readFile(fx.moviePath, 'utf8')).toBe('original-movie-bytes');
    });

    it('does not retry failures that are not hardware init, nor software jobs', async () => {
      fx = await setup();
      fx.runner.respond = () => ({ exitCode: 1, stderr: 'av_interleaved_write_frame(): No space left on device\nConversion failed!' });
      const hw = fx.service.createRule(qsvRule());
      fx.service.runForFile(fx.movieFileId);
      expect(await fx.service.process()).toMatchObject({ failed: 1 });
      expect(fx.runner.calls).toHaveLength(1);

      fx.runner.calls = [];
      fx.service.deleteRule(hw.id);
      fx.runner.respond = () => ({ exitCode: 1, stderr: QSV_FAIL });
      fx.service.createRule(ruleInput({ name: 'sw', action: 'transcode', options: { videoCodec: 'hevc', hwaccel: 'none' }, when: { videoCodec: 'h264' } }));
      fx.service.runForFile(fx.episodeFileId);
      expect(await fx.service.process()).toMatchObject({ failed: 1 });
      expect(fx.runner.calls).toHaveLength(1);
    });

    it('a failed job names the cause ffmpeg printed before its generic last lines', async () => {
      fx = await setup();
      fx.runner.respond = () => ({ exitCode: 234, stderr: EAC3_LAYOUT_FAIL });
      fx.service.createRule(ruleInput({ name: 'sw', action: 'transcode', options: { videoCodec: 'hevc', hwaccel: 'none' }, when: { videoCodec: 'h264' } }));
      fx.service.runForFile(fx.episodeFileId);
      expect(await fx.service.process()).toMatchObject({ failed: 1 });
      const msg = fx.service.listJobs()[0]!.message!;
      expect(msg).toMatch(/^ffmpeg exited with code 234: \[eac3\] Specified channel layout '7\.1' is not supported by the eac3 encoder\n/);
      expect(msg).toContain('Conversion failed!');
    });

    it('a software retry that also fails says hardware was skipped', async () => {
      fx = await setup();
      fx.runner.respond = (args) => (args.includes('hevc_qsv') ? { exitCode: 218, stderr: QSV_FAIL } : { exitCode: 1, stderr: 'Conversion failed!' });
      fx.service.createRule(qsvRule());
      fx.service.runForFile(fx.movieFileId);
      expect(await fx.service.process()).toMatchObject({ failed: 1 });
      expect(fx.runner.calls).toHaveLength(2);
      const msg = fx.service.listJobs()[0]!.message!;
      expect(msg).toContain('code 1: Conversion failed!');
      expect(msg).toContain('was unavailable (No supported child device type is enabled)');
    });
  });

  it('records progress while running', async () => {
    fx = await setup();
    fx.runner.hold = true;
    fx.runner.progress = ['out_time_us=42000000\nprogress=continue\n'];
    fx.service.createRule(ruleInput({ name: 'r' }));
    const { jobs } = fx.service.runForFile(fx.movieFileId);
    const run = fx.service.process();
    await waitFor(() => fx.service.getJob(jobs[0]!.id).progress === 42);
    expect(fx.service.getJob(jobs[0]!.id).status).toBe('running');
    fx.runner.release();
    await run;
  });

  it('cancel: queued jobs at once, running jobs kill ffmpeg and clean up', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'r' }));
    const a = fx.service.runForFile(fx.movieFileId).jobs[0]!;
    const b = fx.service.runForFile(fx.episodeFileId).jobs[0]!;
    expect(fx.service.cancel(b.id).status).toBe('cancelled');
    expect(() => fx.service.cancel(b.id)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));

    fx.runner.hold = true;
    const run = fx.service.process();
    await waitFor(() => fx.runner.calls.length === 1);
    expect(fx.service.cancel(a.id).status).toBe('cancelled');
    const r = await run;
    expect(r).toMatchObject({ completed: 0, cancelled: 1 });
    expect(fx.runner.killed).toBe(1);
    expect(fx.service.getJob(a.id).status).toBe('cancelled');
    expect(await readFile(fx.moviePath, 'utf8')).toBe('original-movie-bytes');
    expect((await readdir(dirname(fx.moviePath)))).toEqual(['Film (2021).mkv']);
    expect(fx.runner.calls).toHaveLength(1);
  });

  it('never runs two ffmpeg processes at once', async () => {
    fx = await setup();
    const rule = fx.service.createRule(ruleInput({ name: 'r' }));
    fx.service.runForRule(rule.id);
    const [r1, r2] = await Promise.all([fx.service.process(), fx.service.process()]);
    expect(r1).toBe(r2);
    expect(r1.completed).toBe(2);
    expect(fx.runner.maxInFlight).toBe(1);
  });

  it('schedule windows gate rule/import jobs; manual single-file runs start any time', async () => {
    fx = await setup();
    fx.clock.now = new Date(2026, 9, 26, 12, 0);
    const night = fx.service.createRule(ruleInput({ name: 'night', schedule: { start: '22:00', end: '06:00' } }));
    expect(fx.service.runForRule(night.id).queued).toBe(2);
    let r = await fx.service.process();
    expect(r).toMatchObject({ completed: 0, waiting: 2 });

    // A manual run of one file ignores the window.
    const manual = fx.service.listJobs().find((j) => j.mediaFileId === fx.movieFileId)!;
    fx.service.cancel(manual.id);
    fx.service.runForFile(fx.movieFileId);
    r = await fx.service.process();
    expect(r).toMatchObject({ completed: 1, waiting: 1 });

    fx.clock.now = new Date(2026, 9, 27, 0, 30); // after midnight, inside 22:00-06:00
    r = await fx.service.process();
    expect(r).toMatchObject({ completed: 1, waiting: 0 });
  });

  it('skips when ffmpeg is missing and requeues interrupted jobs', async () => {
    fx = await setup();
    fx.runner.binary = null;
    fx.service.createRule(ruleInput({ name: 'r' }));
    const job = fx.service.runForFile(fx.movieFileId).jobs[0]!;
    expect((await fx.service.process()).skipped).toBe(true);
    expect(fx.service.getJob(job.id).status).toBe('queued');
  });

  it('deleting a rule cancels its queued jobs', async () => {
    fx = await setup();
    const rule = fx.service.createRule(ruleInput({ name: 'r' }));
    const job = fx.service.runForFile(fx.movieFileId).jobs[0]!;
    fx.service.deleteRule(rule.id);
    expect(fx.service.getJob(job.id)).toMatchObject({ status: 'cancelled', ruleId: null, message: 'rule deleted' });
  });
});

describe('runAfterImport', () => {
  it('queues the imported file for the first runAfterImport rule, waiting for media info', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'manual-only', when: { hdr: true } }));
    const rule = fx.service.createRule(ruleInput({ name: 'after-import', runAfterImport: true, when: { videoCodec: 'hevc' } }));
    // Media info present: queued straight away.
    const id = fx.service.onImported('movie', fx.movieId);
    expect(fx.service.getJob(id!)).toMatchObject({ ruleId: rule.id, trigger: 'import' });

    // No media info yet: waits for analysis (`library updated`).
    fx.db.update(mediaFiles).set({ mediaInfo: null }).where(eq(mediaFiles.id, fx.episodeFileId)).run();
    expect(fx.service.onImported('series', fx.seriesId)).toBeNull();
    expect(fx.service.onAnalyzed('series', fx.seriesId)).toEqual([]);
    fx.db.update(mediaFiles).set({ mediaInfo: { videoFormat: 'hevc' } }).where(eq(mediaFiles.id, fx.episodeFileId)).run();
    const queued = fx.service.onAnalyzed('series', fx.seriesId);
    expect(queued).toHaveLength(1);
    expect(fx.service.getJob(queued[0]!)).toMatchObject({ mediaFileId: fx.episodeFileId, trigger: 'import' });
  });

  it('does nothing without runAfterImport rules', async () => {
    fx = await setup();
    fx.service.createRule(ruleInput({ name: 'r' }));
    expect(fx.service.onImported('movie', fx.movieId)).toBeNull();
    expect(fx.service.listJobs()).toEqual([]);
  });
});
