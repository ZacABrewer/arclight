import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@arclight/torrent-engine';
import { SeedingRulesSettings, type SeedingRuleInput } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { history, rootFolders } from '../../db/schema.js';
import { importedInDb, libraryPathsInDb, matchSeedingRule, pathsOverlap, type SeedingRulesPorts } from './seeding-rules.js';
import { harness, seededTorrent, waitFor, type Harness } from './test-support.js';

// Slow mode / speed schedule applied to a live engine, and the seeding rules over real
// seeding torrents on loopback (no trackers, no peers).

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});

async function make(...args: Parameters<typeof harness>): Promise<Harness> {
  const h = await harness(...args);
  open.push(h);
  return h;
}

function running(h: Harness): Session {
  const s = h.service.session;
  if (!s) throw new Error('engine not running');
  return s;
}

describe('slow mode and the speed schedule', () => {
  it('switches the running engine to the alternative limits and back without a restart', async () => {
    const h = await make({ settings: { enabled: true, downloadLimitKbps: 0, uploadLimitKbps: 300 } });
    const session = running(h);
    await h.service.updateSpeedSettings({ altDownloadLimitKbps: 200, altUploadLimitKbps: 20 });
    const on = await h.service.setSlowMode({ enabled: true });
    expect(on).toMatchObject({ mode: 'alternative', reason: 'manual', slowMode: true, slowModeUntil: null, downloadLimit: 200 * 1024 });
    expect(h.service.session).toBe(session);
    expect(session.settings).toMatchObject({ downloadLimit: 200 * 1024, uploadLimit: 20 * 1024 });
    expect(h.service.status().speed).toMatchObject({ mode: 'alternative', reason: 'manual' });
    await h.service.setSlowMode({ enabled: false });
    expect(session.settings).toMatchObject({ downloadLimit: 0, uploadLimit: 300 * 1024 });
    // Changing the normal limits while slow mode is on keeps the alternative ones.
    await h.service.setSlowMode({ enabled: true });
    await h.service.updateSettings({ downloadLimitKbps: 50 });
    expect(session.settings.downloadLimit).toBe(200 * 1024);
  });

  it('ends a timed slow mode and rejects end times in the past', async () => {
    let clock = new Date('2026-10-26T10:00:00.000Z');
    const h = await make({ service: { now: () => clock } });
    await expect(h.service.setSlowMode({ enabled: true, until: '2026-10-26T09:00:00.000Z' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const mode = await h.service.setSlowMode({ enabled: true, until: '2026-10-26T12:00:00+01:00' });
    expect(mode).toMatchObject({ mode: 'alternative', slowModeUntil: '2026-10-26T11:00:00.000Z' });
    clock = new Date('2026-10-26T11:00:01.000Z');
    expect((await h.service.applySpeedMode()).mode).toBe('normal');
    clock = new Date('2026-10-26T10:30:00.000Z');
    // Cleared for good: going back in time does not bring it back.
    expect(h.service.speedMode()).toMatchObject({ mode: 'normal', slowMode: false });
  });

  it('applies the alternative limits during scheduled windows', async () => {
    const h = await make();
    const always = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' };
    expect((await h.service.updateSpeedSettings({ scheduleEnabled: true, schedule: [always] })).schedule).toHaveLength(1);
    expect(h.service.speedMode()).toMatchObject({ mode: 'alternative', reason: 'schedule', slowMode: false });
    await expect(h.service.updateSpeedSettings({ schedule: [{ days: [1], start: '25:00', end: '01:00' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("mirrors mode changes to qBittorrent's alternative limits when enabled", async () => {
    const calls: boolean[] = [];
    const registry = {
      list: () => [],
      create: () => {
        throw new Error('unused');
      },
      setAlternativeSpeedOnAll: async (enabled: boolean) => {
        calls.push(enabled);
        return [];
      },
    };
    const h = await make({ service: { downloadClients: registry } });
    await h.service.applySpeedMode();
    expect(calls).toEqual([]); // starting in normal mode leaves qBittorrent alone
    await h.service.setSlowMode({ enabled: true });
    await h.service.applySpeedMode();
    await h.service.setSlowMode({ enabled: false });
    expect(calls).toEqual([true, false]);
    await h.service.updateSpeedSettings({ mirrorToQbittorrent: false });
    await h.service.setSlowMode({ enabled: true });
    expect(calls).toEqual([true, false]);
  });
});

// ---- seeding rules -----------------------------------------------------------------------------

interface Recorded {
  infoHash: string;
  type: string;
  message: string;
  data: Record<string, string | number | boolean>;
}

async function seedingSetup(rules: SeedingRuleInput[], ports: Partial<SeedingRulesPorts> & { importedIds?: string[] } = {}) {
  const h = await make({ settings: { enabled: true } });
  const session = running(h);
  const records: Recorded[] = [];
  h.service.setSeedingPorts({
    imported: ports.imported ?? ((id) => (ports.importedIds ?? []).includes(id)),
    libraryPaths: ports.libraryPaths ?? (() => []),
    record: (infoHash, type, message, data) => records.push({ infoHash, type, message, data }),
  });
  h.service.updateSeedingRules({ rules });
  const { torrent, infoHash } = await seededTorrent(h.dir);
  const t = await session.addTorrent({ torrent, savePath: h.dir, category: 'tv' });
  await waitFor(() => t.state === 'seeding');
  return { h, session, t, infoHash, records };
}

const rule = (extra: Partial<SeedingRuleInput> = {}): SeedingRuleInput => ({ id: 'r1', name: 'TV', categories: ['tv'], ratio: 0, ...extra });

describe('seeding rules', () => {
  it('pauses a torrent once its rule is reached and records it', async () => {
    const { h, t, infoHash, records } = await seedingSetup([rule()]);
    const result = await h.service.applySeedingRules();
    expect(result).toMatchObject({ checked: 1, paused: [infoHash], removed: [] });
    expect(t.state).toBe('paused');
    expect(records).toEqual([expect.objectContaining({ infoHash, type: 'paused', data: expect.objectContaining({ reason: 'seedingRule', rule: 'TV' }) })]);
    // Nothing more to do on the next pass.
    expect((await h.service.applySeedingRules())?.paused).toEqual([]);
  });

  it('leaves torrents of other categories and unreached limits alone', async () => {
    const { h, t } = await seedingSetup([rule({ categories: ['movies'] }), rule({ id: 'r2', categories: [], ratio: 5 })]);
    expect(await h.service.applySeedingRules()).toMatchObject({ paused: [], removed: [], held: [] });
    expect(t.state).toBe('seeding');
  });

  it('removes only imported downloads', async () => {
    const { h, session, infoHash } = await seedingSetup([rule({ action: 'remove', deleteFiles: true })]);
    const result = await h.service.applySeedingRules();
    expect(result?.removed).toEqual([]);
    expect(result?.held[0]?.reason).toMatch(/Not imported yet/);
    expect(session.getTorrent(infoHash)).toBeDefined();
  });

  it('removes an imported download and deletes the download folder copy', async () => {
    const { h, session, infoHash, records, t } = await seedingSetup([rule({ action: 'remove', deleteFiles: true })], { importedIds: [] });
    h.service.setSeedingPorts({ imported: () => true, libraryPaths: () => [join(h.dir, 'library')], record: (i, type, message, data) => records.push({ infoHash: i, type, message, data }) });
    const content = t.getStats().contentPath;
    expect((await h.service.applySeedingRules())?.removed).toEqual([infoHash]);
    expect(session.getTorrent(infoHash)).toBeUndefined();
    await expect(stat(content)).rejects.toThrow();
    expect(records[0]).toMatchObject({ type: 'removed', data: { deleteFiles: true } });
    expect(records[0]?.message).toMatch(/Download folder copy deleted/);
  });

  it('keeps the files when they are inside the library', async () => {
    const { h, session, infoHash, records, t } = await seedingSetup([rule({ action: 'remove', deleteFiles: true })]);
    h.service.setSeedingPorts({ imported: () => true, libraryPaths: () => [h.dir], record: (i, type, message, data) => records.push({ infoHash: i, type, message, data }) });
    const content = t.getStats().contentPath;
    expect((await h.service.applySeedingRules())?.removed).toEqual([infoHash]);
    expect(session.getTorrent(infoHash)).toBeUndefined();
    expect((await stat(content)).isDirectory()).toBe(true);
    expect(records[0]).toMatchObject({ type: 'removed', data: { deleteFiles: false } });
    expect(records[0]?.message).toMatch(/inside the library/);
  });

  it('never acts before the hit-and-run requirement is met', async () => {
    const { h, session, infoHash } = await seedingSetup([rule({ action: 'remove' })], { imported: () => true });
    h.service.setSeedRuleProvider(() => ({ minSeedHours: 72, label: 'PrivateHD' }));
    const result = await h.service.applySeedingRules();
    expect(result?.removed).toEqual([]);
    expect(result?.held[0]?.reason).toMatch(/Hit-and-run guard: PrivateHD requires 72 h/);
    expect(session.getTorrent(infoHash)?.state).toBe('seeding');
  });

  it('matches rules by indexer through the resolver', async () => {
    const { h, t } = await seedingSetup([rule({ categories: [], indexerIds: [8] })]);
    h.service.setIndexerResolver(() => 7);
    expect((await h.service.applySeedingRules())?.paused).toEqual([]);
    h.service.updateSeedingRules({ rules: [rule({ categories: [], indexerIds: [7] })] });
    expect((await h.service.applySeedingRules())?.paused).toEqual([t.infoHashHex]);
  });

  it('rejects duplicate rule ids and rules without a limit', async () => {
    const h = await make();
    expect(() => h.service.updateSeedingRules({ rules: [rule(), rule()] })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => h.service.updateSeedingRules({ rules: [{ id: 'x', name: 'X' }] })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(await h.service.applySeedingRules()).toBeNull(); // engine not running
  });
});

describe('seeding rule helpers', () => {
  it('matches categories, trackers (with subdomains) and indexers together', () => {
    const { rules } = SeedingRulesSettings.parse({
      rules: [
        { id: 'a', name: 'A', categories: ['tv'], trackers: ['Tracker.Example'], ratio: 1 },
        { id: 'b', name: 'B', ratio: 2, action: 'remove' },
      ],
    });
    expect(matchSeedingRule(rules, { category: 'tv', hosts: ['announce.tracker.example'] })?.id).toBe('a');
    expect(matchSeedingRule(rules, { category: 'tv', hosts: ['other.example'] })?.id).toBe('b');
    expect(matchSeedingRule([{ ...rules[1]!, enabled: false }], { category: 'tv', hosts: [] })).toBeNull();
  });

  it('detects overlapping paths in both directions', () => {
    expect(pathsOverlap('/data/downloads/x', '/data/downloads')).toBe(true);
    expect(pathsOverlap('/data', '/data/downloads/x')).toBe(true);
    expect(pathsOverlap('/data/downloads/x', '/data/media')).toBe(false);
    expect(pathsOverlap('/data/downloads/x', '/data/downloads/xy')).toBe(false);
  });

  it('reads import state and library folders from the database', async () => {
    const db = await createTestDb();
    const hash = 'cd'.repeat(20);
    expect(importedInDb(db, hash)).toBe(false);
    db.insert(history)
      .values({
        eventType: 'downloadFolderImported',
        mediaType: 'movie',
        movieId: 1,
        sourceTitle: 'Movie.2020',
        quality: { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0, isRepack: false } } as never,
        languages: [],
        date: '2026-10-26T00:00:00.000Z',
        downloadId: hash.toUpperCase(),
        data: {},
      })
      .run();
    expect(importedInDb(db, hash)).toBe(true);
    db.insert(rootFolders).values({ path: '/media/movies', mediaType: 'movie' }).run();
    expect(libraryPathsInDb(db)).toEqual(['/media/movies']);
  });
});
