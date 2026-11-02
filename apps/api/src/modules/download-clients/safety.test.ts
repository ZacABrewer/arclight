import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKED_EXTENSIONS } from '@arclight/shared';
import { getSection, setSection } from '../settings/service.js';
import { DEFAULT_RECOVERY_SETTINGS, stallSeedRuleExemption, type RecoverySettings } from './recovery.js';
import { blockedExtensionSet, checkReleaseFiles, resolutionOf, type SafetyOptions } from './safety.js';
import type { TrackedDownload } from './service.js';
import { item, qbit, setup } from './test-support.js';

// The fake-release / malware filter (decisions and the queue-side rejection) and the stall
// exemption for private trackers' hit-and-run rules.

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MIN = 60_000;
const opts: SafetyOptions = { blockedExtensions: [...DEFAULT_BLOCKED_EXTENSIONS], rejectImplausibleSize: true };
const movie = { mediaType: 'movie' as const, title: 'Great.Movie.2021.1080p.BluRay.x264-GRP', runtimeMinutes: 120 };

describe('checkReleaseFiles', () => {
  it('passes a normal release and an unknown file list', () => {
    expect(checkReleaseFiles([], movie, opts)).toEqual({ ok: true });
    expect(
      checkReleaseFiles(
        [
          { path: 'Great.Movie/Great.Movie.mkv', sizeBytes: 8 * GIB },
          { path: 'Great.Movie/Sample/sample.mkv', sizeBytes: 20 * MIB },
          { path: 'Great.Movie/Great.Movie.nfo', sizeBytes: 2000 },
        ],
        movie,
        opts,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects blocked extensions, the configured ones and the built-in list', () => {
    const exe = checkReleaseFiles([{ path: 'M/M.mkv', sizeBytes: 8 * GIB }, { path: 'M/Codec/setup.exe', sizeBytes: 1000 }], movie, opts);
    expect(exe).toMatchObject({ ok: false, rule: 'blockedExtension', file: 'M/Codec/setup.exe' });
    expect(!exe.ok && exe.reason).toBe('Unsafe release: contains setup.exe (.exe files are blocked)');
    expect(checkReleaseFiles([{ path: 'M.mkv', sizeBytes: 8 * GIB }, { path: 'M.zipx', sizeBytes: 9 }], movie, opts)).toMatchObject({ rule: 'blockedExtension' });
    expect(checkReleaseFiles([{ path: 'M.mkv', sizeBytes: 8 * GIB }, { path: 'Play.lnk', sizeBytes: 9 }], movie, opts)).toMatchObject({ rule: 'blockedExtension' });
    // A user-added extension, written with or without the dot.
    const custom = { ...opts, blockedExtensions: ['.Iso', 'arj'] };
    expect(checkReleaseFiles([{ path: 'M.iso', sizeBytes: 8 * GIB }], movie, custom)).toMatchObject({ rule: 'blockedExtension' });
    expect(blockedExtensionSet(['*.FOO', ' bar ']).has('.foo')).toBe(true);
    expect(blockedExtensionSet(['*.FOO', ' bar ']).has('.bar')).toBe(true);
    // The import's caution list applies even when the setting is emptied.
    expect(blockedExtensionSet([]).has('.exe')).toBe(true);
  });

  it('rejects a release without any media file, but not one made of archives', () => {
    expect(checkReleaseFiles([{ path: 'M/readme.txt', sizeBytes: 100 }, { path: 'M/M.nfo', sizeBytes: 100 }], movie, opts)).toMatchObject({
      ok: false,
      rule: 'noMedia',
      reason: 'Fake release: it contains no video file',
    });
    const rars = Array.from({ length: 50 }, (_, i) => ({ path: `M/m.part${String(i + 1).padStart(2, '0')}.rar`, sizeBytes: 100 * MIB }));
    expect(checkReleaseFiles(rars, movie, opts)).toEqual({ ok: true });
    expect(checkReleaseFiles([{ path: 'A/01.txt', sizeBytes: 1 }], { mediaType: 'music', title: 'Artist - Album' }, opts)).toMatchObject({
      rule: 'noMedia',
      reason: 'Fake release: it contains no audio file',
    });
    expect(checkReleaseFiles([{ path: 'A/01.flac', sizeBytes: 1 }], { mediaType: 'music', title: 'Artist - Album' }, opts)).toEqual({ ok: true });
    // Unknown kinds: only the extension rule.
    expect(checkReleaseFiles([{ path: 'x.txt', sizeBytes: 1 }], { title: 'x' }, opts)).toEqual({ ok: true });
  });

  it('rejects an implausibly small main video for its resolution and runtime', () => {
    const small = checkReleaseFiles([{ path: 'M.mkv', sizeBytes: 40 * MIB }, { path: 'Sample/s.mkv', sizeBytes: 900 * MIB }], movie, opts);
    expect(small).toMatchObject({ ok: false, rule: 'tooSmall' });
    expect(!small.ok && small.reason).toBe(
      'Fake release: the main video is only 40 MiB, implausibly small for 1080p with 120 min runtime (at least 300 MiB expected)',
    );
    // SD with the series fallback runtime (20 min, 0.7 MiB/min = 14 MiB).
    const ep = { mediaType: 'series' as const, title: 'Show.S01E01.HDTV' };
    expect(checkReleaseFiles([{ path: 'e.mkv', sizeBytes: 15 * MIB }], ep, opts)).toEqual({ ok: true });
    expect(checkReleaseFiles([{ path: 'e.mkv', sizeBytes: 10 * MIB }], ep, opts)).toMatchObject({ rule: 'tooSmall' });
    // Archives only: their total counts.
    expect(checkReleaseFiles([{ path: 'm.rar', sizeBytes: 50 * MIB }], movie, opts)).toMatchObject({ rule: 'tooSmall' });
    expect(checkReleaseFiles([{ path: 'M.mkv', sizeBytes: 40 * MIB }], movie, { ...opts, rejectImplausibleSize: false })).toEqual({ ok: true });
  });

  it('reads the resolution from the title', () => {
    expect(resolutionOf('Movie.2021.2160p.UHD')).toBe('2160p');
    expect(resolutionOf('Movie 4K HDR')).toBe('2160p');
    expect(resolutionOf('Movie.1080i.HDTV')).toBe('1080p');
    expect(resolutionOf('Movie.720p.WEB')).toBe('720p');
    expect(resolutionOf('Movie.DVDRip')).toBe('sd');
    expect(resolutionOf('Movie.10800p')).toBe('sd');
  });
});

describe('stallSeedRuleExemption', () => {
  it('keeps torrents with data from trackers with a hit-and-run rule', () => {
    expect(stallSeedRuleExemption({ minSeedHours: 72, label: 'Tracker A' }, { progress: 0.2, downloadedBytes: 10 })).toBe(
      'Tracker A has a hit-and-run rule (72 h of seeding) and this torrent already has data, so removing it could count as a hit-and-run',
    );
    expect(stallSeedRuleExemption({ minSeedHours: 48, minRatio: 1 }, { progress: 0.01, downloadedBytes: 1 })).toContain(
      'its tracker has a hit-and-run rule (48 h of seeding or ratio 1)',
    );
  });

  it('does not keep torrents without data or without a rule', () => {
    expect(stallSeedRuleExemption({ minSeedHours: 72 }, { progress: 0, downloadedBytes: 0 })).toBeNull();
    expect(stallSeedRuleExemption({ label: 'Open' }, { progress: 0.5, downloadedBytes: 5 })).toBeNull();
    expect(stallSeedRuleExemption(null, { progress: 0.5, downloadedBytes: 5 })).toBeNull();
  });
});

const MAGNET = 'magnet:?xt=urn:btih:abc123';

async function grabbed(options: { settings?: Partial<RecoverySettings> } = {}) {
  const recovery: RecoverySettings = { ...DEFAULT_RECOVERY_SETTINGS, ...options.settings };
  const ctx = await setup({
    stallAfterMs: () => 10 * MIN,
    minimumFreeSpaceBytes: () => 100 * MIB,
    freeSpace: async () => 100 * GIB,
    recoverySettings: () => recovery,
  });
  const client = ctx.service.create(qbit('Main'));
  const blocklisted: Array<{ id: number; message?: string | undefined }> = [];
  ctx.service.onBlocklist((tracked, o) => {
    blocklisted.push({ id: tracked.id, message: o.message });
  });
  const searches: TrackedDownload[] = [];
  ctx.service.setReplacementSearch((tracked) => {
    searches.push(tracked);
    return true;
  });
  const tracked = await ctx.service.grab(client.id, { title: 'Great.Movie.2021.1080p.BluRay', magnet: MAGNET }, { mediaType: 'movie', movieId: 1 });
  const fake = ctx.fake(client.id);
  fake.items = [item({ id: 'abc123', title: 'Great.Movie.2021.1080p.BluRay', downloadedBytes: 100, remainingBytes: 900, progress: 0.1 })];
  const types = () => ctx.service.getTimeline(tracked.id).events.map((e) => e.type);
  return { ...ctx, client, tracked, fake, blocklisted, searches, types };
}

describe('release safety on the queue', () => {
  it('rejects a torrent as soon as its file list shows a blocked file', async () => {
    const h = await grabbed();
    await h.service.refreshQueue();
    // No file list yet: nothing happens, and it is asked again next time.
    expect(h.fake.removed).toEqual([]);
    h.fake.files.set('abc123', [
      { path: 'Great.Movie/Great.Movie.mkv', sizeBytes: 8 * GIB },
      { path: 'Great.Movie/Great.Movie.scr', sizeBytes: 300_000 },
    ]);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([{ id: 'abc123', deleteData: true }]);
    expect(h.blocklisted).toEqual([{ id: h.tracked.id, message: 'Unsafe release: contains Great.Movie.scr (.scr files are blocked)' }]);
    expect(h.searches).toHaveLength(1);
    expect(() => h.service.getQueueItem(h.tracked.id)).toThrow(/not found/);
    const last = h.service.getTimeline(h.tracked.id).events.at(-1)!;
    expect(last).toMatchObject({ type: 'rejected', severity: 'error', data: expect.objectContaining({ trigger: 'metadata', rule: 'blockedExtension' }) });
    expect(last.message).toBe(
      'Unsafe release: contains Great.Movie.scr (.scr files are blocked): removed from Main with its data, release blocklisted, searching for another release.',
    );
    // The queue banner lists it.
    expect(h.service.queueStatus().recentRejections).toEqual([
      expect.objectContaining({ trackedDownloadId: h.tracked.id, title: 'Great.Movie.2021.1080p.BluRay', reason: last.message }),
    ]);
  });

  it('checks each download once, and not at all with the filter off', async () => {
    const h = await grabbed();
    h.fake.files.set('abc123', [{ path: 'Great.Movie.mkv', sizeBytes: 8 * GIB }]);
    await h.service.refreshQueue();
    h.fake.files.set('abc123', [{ path: 'Great.Movie.mkv', sizeBytes: 8 * GIB }, { path: 'x.exe', sizeBytes: 1 }]);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([]);

    const off = await grabbed();
    setSection(off.db, 'mediaManagement', { ...getSection(off.db, 'mediaManagement'), releaseSafetyFilter: false });
    off.fake.files.set('abc123', [{ path: 'x.exe', sizeBytes: 1 }]);
    await off.service.refreshQueue();
    expect(off.fake.removed).toEqual([]);
  });

  it('rejects through rejectUnsafe even while importing, and still blocklists when the client refuses', async () => {
    const h = await grabbed();
    await h.service.refreshQueue();
    h.service.setState(h.tracked.id, 'importing');
    h.fake.failRemove = new Error('hit-and-run guard');
    const r = await h.service.rejectUnsafe(h.tracked.id, 'Unsafe release: x.rar is password-protected', 'unpack', 'encrypted');
    expect(r).not.toBeNull();
    expect(h.fake.paused).toContain('abc123');
    expect(h.blocklisted.map((b) => b.message)).toEqual(['Unsafe release: x.rar is password-protected']);
    expect(h.service.getTimeline(h.tracked.id).events.at(-1)!.message).toContain('paused in Main (it refused the removal; remove it there)');
    expect(await h.service.rejectUnsafe(9999, 'x', 'import')).toBeNull();
  });
});

describe('stall exemption for hit-and-run rules', () => {
  async function stalled(rule: { minSeedHours?: number; label?: string } | null, settings: Partial<RecoverySettings> = {}) {
    const h = await grabbed({ settings });
    h.service.setSeedRuleLookup(() => rule);
    await h.service.refreshQueue();
    h.advance(10 * MIN);
    await h.service.refreshQueue();
    h.advance(60 * MIN);
    await h.service.refreshQueue();
    return h;
  }

  it('keeps a stalled private torrent with data and says why', async () => {
    const h = await stalled({ minSeedHours: 72, label: 'Tracker A' });
    expect(h.fake.removed).toEqual([]);
    expect(h.fake.reannounced).toEqual(['abc123']);
    const q = h.service.getQueueItem(h.tracked.id);
    expect(q.stateCode).toBe('stalled');
    expect(q.stateReason).toContain('Not removed automatically: Tracker A has a hit-and-run rule (72 h of seeding)');
  });

  it('replaces as usual without a rule, or with the exemption switched off', async () => {
    expect((await stalled(null)).fake.removed).toHaveLength(1);
    expect((await stalled({ minSeedHours: 72 }, { respectHitAndRun: false })).fake.removed).toHaveLength(1);
  });
});
