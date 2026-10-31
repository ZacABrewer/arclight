import { describe, expect, it } from 'vitest';
import { ADD_LIMIT, GrabGuard, REGRAB_COOLDOWN_MS, releaseKeys } from './grab-guard.js';
import { item, qbit, setup } from './test-support.js';

// Grabs that repeat themselves: duplicate adds, re-grabs of a release whose download just went
// away (its files may still be being deleted), and Remove Completed on downloads Arclight
// never grabbed.

const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const MAGNET = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Show.S01E01`;
const RELEASE = { guid: 'g-1', indexerId: 4, infoHash: HASH.toUpperCase(), title: 'Show.S01E01.1080p' };
const TRACKING = { mediaType: 'series' as const, seriesId: 1, episodeIds: [1], grabbedRelease: RELEASE };

async function withClient() {
  const ctx = await setup();
  const client = ctx.service.create(qbit('Main'));
  const fake = ctx.fake(client.id);
  fake.nextId = HASH;
  return { ...ctx, client, fake };
}

describe('duplicate adds', () => {
  it('tracks a torrent the client already has, and never sends it a second time', async () => {
    const h = await withClient();
    h.fake.alreadyPresent = true;
    const first = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    expect(first).toMatchObject({ downloadId: HASH, trackedState: 'downloading', seriesId: 1 });
    expect(h.service.getTimeline(first.id).events.at(-1)?.message).toMatch(/^Already in Main; tracking the existing download/);

    h.fake.items = [item({ id: HASH, title: 'Show.S01E01.1080p' })];
    await h.service.refreshQueue();
    for (let i = 0; i < 5; i++) {
      const again = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
      expect(again.id).toBe(first.id);
    }
    expect(h.fake.added).toHaveLength(1);
    expect(h.service.listTracked()).toHaveLength(1);
  });

  it('gives an untracked item the library link of a grab of the same torrent', async () => {
    const h = await withClient();
    h.fake.items = [item({ id: HASH, title: 'Show.S01E01.1080p' })];
    await h.service.refreshQueue();
    const sent = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    expect(sent).toMatchObject({ downloadId: HASH, seriesId: 1, episodeIds: [1] });
    expect(h.fake.added).toHaveLength(0);
  });

  it('holds the same release sent to one client more than the limit within an hour', async () => {
    const h = await withClient();
    // Not linked to the library, so a vanished one gets no re-grab cool-down: only the loop guard is left.
    const send = () => h.service.grab(h.client.id, { title: 'Loop', magnet: MAGNET });
    for (let i = 0; i < ADD_LIMIT; i++) {
      await send();
      // The client never lists it: the next poll flags it missing, so the next grab sends again.
      await h.service.refreshQueue();
    }
    await expect(send()).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/sent 3 times within the hour; held until/) });
    expect(h.fake.added).toHaveLength(ADD_LIMIT);
    h.advance(61 * 60_000);
    await send();
    expect(h.fake.added).toHaveLength(ADD_LIMIT + 1);
  });
});

describe('re-grab cool-down', () => {
  it('does not re-grab a release straight after its download vanished from the client', async () => {
    const h = await withClient();
    await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    h.fake.items = [item({ id: HASH, title: 'Show.S01E01.1080p' })];
    await h.service.refreshQueue();
    // Removed in qBittorrent by hand, perhaps with its data.
    h.fake.items = [];
    await h.service.refreshQueue();
    h.advance(10_000);
    await expect(h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/no longer reported by Main moments ago/),
    });
    // The same release from a .torrent (no magnet) is matched by its indexer guid.
    await expect(h.service.grab(h.client.id, { title: 'x', torrentFile: new Uint8Array([1]) }, { grabbedRelease: { guid: 'g-1', indexerId: 4 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.fake.added).toHaveLength(1);

    h.advance(REGRAB_COOLDOWN_MS);
    await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    expect(h.fake.added).toHaveLength(2);
  });

  it('"Try another release" without the blocklist does not get the same release back', async () => {
    const h = await withClient();
    const searches: string[] = [];
    const tracked = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    h.service.setReplacementSearch(async (it) => {
      searches.push(it.title);
      // What the search would do: grab the best release again, the same one here.
      await expect(h.service.grab(h.client.id, { title: it.title, magnet: MAGNET }, TRACKING)).rejects.toMatchObject({ code: 'CONFLICT' });
      return true;
    });
    await h.service.replace(tracked.id, { blocklist: false, removeData: true });
    expect(searches).toEqual(['Show.S01E01.1080p']);
    expect(h.fake.removed).toEqual([{ id: HASH, deleteData: true }]);
    expect(h.fake.added).toHaveLength(1);
    // Another release of the same episode goes through.
    h.fake.nextId = 'b'.repeat(40);
    await h.service.grab(h.client.id, { title: 'Show.S01E01.720p', magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}` }, { ...TRACKING, grabbedRelease: { guid: 'g-2', indexerId: 4 } });
    expect(h.fake.added).toHaveLength(2);
  });

  it('applies to queue removal with the client too', async () => {
    const h = await withClient();
    const tracked = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    await h.service.removeQueueItems([tracked.id], { removeFromClient: true, blocklist: false, skipRedownload: false });
    await expect(h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('Remove Completed', () => {
  it('removes a download Arclight grabbed once imported, and logs it on its timeline', async () => {
    const h = await withClient();
    const tracked = await h.service.grab(h.client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, TRACKING);
    h.fake.items = [item({ id: HASH, status: 'seeding', progress: 1, remainingBytes: 0, canBeRemoved: true })];
    await h.service.refreshQueue();
    await h.service.markImported(tracked.id);
    expect(h.fake.removed).toEqual([{ id: HASH, deleteData: true }]);
    expect(h.service.getTimeline(tracked.id).events.at(-1)).toMatchObject({ type: 'removed', data: { trigger: 'removeCompleted' } });
  });

  it('never removes a download Arclight did not grab (added by hand, another app, a migration)', async () => {
    const h = await withClient();
    h.fake.items = [item({ id: 'd'.repeat(40), status: 'seeding', progress: 1, remainingBytes: 0, canBeRemoved: true })];
    await h.service.refreshQueue();
    const found = h.service.listTracked()[0]!;
    await h.service.markImported(found.id);
    expect(h.fake.removed).toEqual([]);
  });
});

describe('alternative speed mirror', () => {
  it('switches off only what Arclight switched on', async () => {
    const h = await withClient();
    let alt = true;
    const toggles: boolean[] = [];
    Object.assign(h.fake, {
      getAlternativeSpeed: async () => alt,
      setAlternativeSpeed: async (enabled: boolean) => {
        toggles.push(enabled);
        alt = enabled;
      },
    });
    // The user had qBittorrent's alternative limits on already: slow mode leaves them alone.
    await h.service.setAlternativeSpeedOnAll(true);
    await h.service.setAlternativeSpeedOnAll(false);
    expect(toggles).toEqual([]);
    expect(alt).toBe(true);

    alt = false;
    await h.service.setAlternativeSpeedOnAll(true);
    await h.service.setAlternativeSpeedOnAll(false);
    expect(toggles).toEqual([true, false]);
  });
});

describe('GrabGuard', () => {
  it('keys releases by info-hash and indexer guid', () => {
    expect(releaseKeys({ infoHash: HASH.toUpperCase(), guid: 'g', indexerId: 2 }, 'nzo_1')).toEqual([`hash:${HASH}`, 'guid:2:g']);
    expect(releaseKeys(null, HASH)).toEqual([`hash:${HASH}`]);
  });

  it('backs off longer while the same add keeps coming', () => {
    let now = 0;
    const guard = new GrabGuard(() => now);
    for (let i = 0; i < ADD_LIMIT; i++) expect(guard.admitAdd(1, 'k')).toBeNull();
    const first = guard.admitAdd(1, 'k');
    expect(first).toMatchObject({ until: 15 * 60_000, started: true });
    expect(guard.admitAdd(1, 'k')).toMatchObject({ started: false });
    expect(guard.admitAdd(2, 'k')).toBeNull();
    now = first!.until;
    expect(guard.admitAdd(1, 'k')).toMatchObject({ until: now + 30 * 60_000, started: true });
  });
});
