import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_CLIENT_PROTOCOLS,
  DownloadClientImplementation,
  DownloadClientInput,
  downloadClientHost,
  PASSWORD_MASK,
  type DownloadClientField,
} from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import * as tables from './schema.js';
import { DownloadClientsService, type TrackedDownload } from './service.js';
import { assertContractInSync, implementationSchemas } from './templates.js';
import { clientOf, item, setup } from './test-support.js';

// Every implementation through the registry, the usenet grab path and usenet queue mapping.

const KINDS = DownloadClientImplementation.options;
const NZB = new TextEncoder().encode('<?xml version="1.0"?><nzb></nzb>');

const REAL_NAMES: Record<string, string> = {
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  rtorrent: 'rTorrent',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  builtin: 'Built-in',
};

async function realService(fetchImpl?: typeof fetch) {
  const db = await createTestDb({ ...tables });
  return new DownloadClientsService({
    db,
    platform: 'posix',
    directoryExists: async () => true,
    ...(fetchImpl ? { clientRuntime: { fetch: fetchImpl, sleep: async () => {} } } : {}),
  });
}

describe('registry builds the package client for every kind', () => {
  it.each(KINDS)('%s', async (kind) => {
    const service = await realService();
    const created = service.create(clientOf(kind, `My ${kind}`));
    expect(created.protocol).toBe(DOWNLOAD_CLIENT_PROTOCOLS[kind]);
    const client = service.clientById(created.id);
    expect(client.name).toBe(REAL_NAMES[kind]);
    expect(client.protocol).toBe(DOWNLOAD_CLIENT_PROTOCOLS[kind]);
    expect(typeof client.addNzb === 'function').toBe(true);
  });

  it('drives a real SABnzbd client end to end: a usenet grab uploads the NZB via addfile', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      return new Response(JSON.stringify({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const service = await realService(fetchImpl);
    const c = service.create(clientOf('sabnzbd', 'SAB', {}, { apiKey: 'k3y' }));
    const tracked = await service.grab(null, { title: 'Show.S01E01.1080p', protocol: 'usenet', nzb: NZB }, { seriesId: 1 });
    expect(tracked).toMatchObject({ downloadId: 'SABnzbd_nzo_abc', downloadClientId: c.id, protocol: 'usenet', trackedState: 'downloading' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('mode=addfile');
    expect(calls[0]!.url).toContain('apikey=k3y');
    expect(calls[0]!.body).toBeInstanceOf(FormData);
  });
});

describe('implementation templates', () => {
  const schemas = implementationSchemas();
  const settingsOf = (kind: string): DownloadClientField[] =>
    schemas.find((s) => s.implementation === kind)!.fields.filter((f) => f.name.startsWith('settings.'));

  it('lists all six kinds with protocol, name and description', () => {
    expect(schemas.map((s) => s.implementation)).toEqual([...KINDS]);
    for (const s of schemas) {
      expect(s.protocol).toBe(DOWNLOAD_CLIENT_PROTOCOLS[s.implementation]);
      expect(s.implementationName).not.toBe('');
      expect(s.description.length).toBeGreaterThan(20);
    }
    expect(schemas.filter((s) => s.protocol === 'usenet').map((s) => s.implementation)).toEqual(['sabnzbd', 'nzbget']);
  });

  it('derives help texts from the schemas .describe() for every settings field', () => {
    for (const kind of KINDS) {
      for (const f of settingsOf(kind)) expect(f.helpText, `${kind} ${f.name}`).not.toBe('');
    }
    expect(settingsOf('sabnzbd').find((f) => f.name === 'settings.apiKey')!.helpText).toContain('Config > General');
  });

  it('maps Zod types to field types, defaults and bounds', () => {
    const nzbget = settingsOf('nzbget');
    expect(nzbget.find((f) => f.name === 'settings.port')).toMatchObject({ type: 'number', default: 6789, min: 1, max: 65535 });
    expect(nzbget.find((f) => f.name === 'settings.addPaused')).toMatchObject({ type: 'checkbox', default: false, required: false });
    expect(nzbget.find((f) => f.name === 'settings.recentPriority')).toMatchObject({ type: 'select', default: 'normal' });
    expect(nzbget.find((f) => f.name === 'settings.recentPriority')!.options).toContainEqual({ value: 'veryHigh', label: 'Very High' });
    expect(nzbget.find((f) => f.name === 'settings.host')).toMatchObject({ required: true, default: 'localhost', advanced: false });
    expect(settingsOf('sabnzbd').find((f) => f.name === 'settings.apiKey')!.type).toBe('password');
    expect(settingsOf('transmission').find((f) => f.name === 'settings.password')!.type).toBe('password');
  });

  it('flags advanced fields and uses kind-specific labels', () => {
    expect(settingsOf('transmission').find((f) => f.name === 'settings.urlBase')!.advanced).toBe(true);
    expect(settingsOf('transmission').find((f) => f.name === 'settings.category')!.label).toBe('Label');
    expect(settingsOf('sabnzbd').find((f) => f.name === 'settings.username')!.advanced).toBe(true);
    expect(settingsOf('qbittorrent').find((f) => f.name === 'settings.initialState')!.options).toContainEqual({
      value: 'forceStart',
      label: 'Force Started',
    });
  });

  it('serves templates that are valid create bodies with every default filled in', () => {
    for (const s of schemas) {
      const parsed = DownloadClientInput.parse(s.template);
      expect(parsed.implementation).toBe(s.implementation);
      expect(downloadClientHost(parsed.settings)).toBe('localhost');
    }
    expect(schemas.find((s) => s.implementation === 'transmission')!.template.settings).toMatchObject({ port: 9091, urlBase: '/transmission/' });
  });

  it('keeps the shared contract in sync with the package', () => {
    expect(() => assertContractInSync()).not.toThrow();
  });
});

describe('CRUD for the new kinds', () => {
  it('masks the SABnzbd API key on read and keeps it when the mask comes back', async () => {
    const { service, fake } = await setup();
    const c = service.create(clientOf('sabnzbd', 'SAB', {}, { apiKey: 'k3y' }));
    expect(c.settings).toMatchObject({ apiKey: PASSWORD_MASK, password: PASSWORD_MASK });
    service.update(c.id, clientOf('sabnzbd', 'SAB', {}, { apiKey: PASSWORD_MASK, password: PASSWORD_MASK }));
    expect(fake(c.id).config.settings).toMatchObject({ apiKey: 'k3y', password: 'secret' });
  });

  it('rejects a protocol the kind does not support and invalid Deluge labels', async () => {
    const { service } = await setup();
    expect(() => service.create(clientOf('nzbget', 'N', { protocol: 'torrent' }))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => service.create(clientOf('deluge', 'D', {}, { category: 'bad label!' }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });

  it('tests a candidate config per kind with stored secrets restored', async () => {
    const { service } = await setup();
    const c = service.create(clientOf('sabnzbd', 'SAB', {}, { apiKey: 'k3y' }));
    const result = await service.test({ ...clientOf('sabnzbd', 'SAB', {}, { apiKey: PASSWORD_MASK }), id: c.id });
    expect(result.ok).toBe(true);
  });
});

describe('usenet grabs', () => {
  it('picks a usenet client for usenet releases even when a torrent client has a better priority', async () => {
    const { service } = await setup();
    service.create(clientOf('qbittorrent', 'qBit', { priority: 1 }));
    const sab = service.create(clientOf('sabnzbd', 'SAB', { priority: 25 }));
    expect(service.pickClient('usenet')?.id).toBe(sab.id);
    expect(service.pickClient('torrent')?.name).toBe('qBit');
  });

  it('sends NZB bytes through addNzb with the client category', async () => {
    const { service, fake } = await setup();
    const c = service.create(clientOf('nzbget', 'NZBGet', {}, { category: 'tv' }));
    const tracked = await service.grab(null, { title: 'Show.S01E01', protocol: 'usenet', nzb: NZB, isRecent: true }, { seriesId: 3 });
    expect(fake(c.id).nzbsAdded).toEqual([{ nzb: NZB, title: 'Show.S01E01', category: 'tv', isRecent: true }]);
    expect(fake(c.id).added).toHaveLength(0);
    expect(tracked).toMatchObject({ protocol: 'usenet', trackedState: 'downloading', seriesId: 3 });
  });

  it('still sends torrents through addTorrent on the new torrent kinds', async () => {
    const { service, fake } = await setup();
    const c = service.create(clientOf('transmission', 'Tr'));
    await service.grab(null, { title: 'Show.S01E02', magnet: 'magnet:?xt=urn:btih:abc' });
    expect(fake(c.id).added[0]).toMatchObject({ magnet: 'magnet:?xt=urn:btih:abc', category: 'arclight' });
  });

  it('fails with NO_CLIENT when no usenet client exists or the chosen client is a torrent client', async () => {
    const { service } = await setup();
    const qb = service.create(clientOf('qbittorrent', 'qBit'));
    await expect(service.grab(null, { title: 'X', protocol: 'usenet', nzb: NZB })).rejects.toMatchObject({ code: 'NO_CLIENT' });
    await expect(service.grab(qb.id, { title: 'X', protocol: 'usenet', nzb: NZB })).rejects.toMatchObject({ code: 'NO_CLIENT' });
  });

  it('requires NZB bytes for a usenet grab', async () => {
    const { service } = await setup();
    service.create(clientOf('sabnzbd', 'SAB'));
    await expect(service.grab(null, { title: 'X', protocol: 'usenet', torrentFile: NZB })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('parks a usenet grab as pending and retries it with the same NZB', async () => {
    const { service, fake } = await setup();
    const pending = service.addPending({ title: 'Show.S01E03', protocol: 'usenet', nzb: NZB }, { seriesId: 1 }, 'No usenet client');
    expect(pending).toMatchObject({ trackedState: 'pending', protocol: 'usenet' });
    const c = service.create(clientOf('sabnzbd', 'SAB'));
    const sent = await service.retryPending(pending.id);
    expect(sent).toMatchObject({ id: pending.id, trackedState: 'downloading', downloadClientId: c.id });
    expect(Array.from(fake(c.id).nzbsAdded[0]!.nzb)).toEqual(Array.from(NZB));
  });
});

describe('usenet queue mapping', () => {
  async function grabbed(kind: 'sabnzbd' | 'nzbget' = 'sabnzbd') {
    const ctx = await setup();
    const c = ctx.service.create(clientOf(kind, 'Usenet'));
    ctx.fake(c.id).nextId = 'nzo_1';
    await ctx.service.grab(null, { title: 'Show.S01E01', protocol: 'usenet', nzb: NZB }, { seriesId: 1, episodeIds: [10] });
    return { ...ctx, c };
  }

  it('keeps post-processing items (reported as downloading) in downloading', async () => {
    const { service, fake, c } = await grabbed();
    fake(c.id).items = [item({ id: 'nzo_1', status: 'downloading', progress: 1, remainingBytes: 0, statusMessage: 'Extracting' })];
    await service.refreshQueue();
    expect(service.listTracked()[0]).toMatchObject({ trackedState: 'downloading', protocol: 'usenet', status: 'downloading' });
  });

  it('moves a completed usenet download to importPending with the host-keyed path mapping applied', async () => {
    const { service, fake, c } = await grabbed('nzbget');
    await service.createMapping({ host: 'nas', remotePath: '/complete/', localPath: '/mnt/usenet/' });
    const completed: TrackedDownload[] = [];
    service.onItemCompleted((i) => {
      completed.push(i);
    });
    fake(c.id).items = [
      item({ id: 'nzo_1', status: 'completed', progress: 1, remainingBytes: 0, outputPath: '/complete/Show.S01E01', isReadOnly: false, canMoveFiles: true, canBeRemoved: true }),
    ];
    await service.refreshQueue();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ trackedState: 'importPending', outputPath: '/mnt/usenet/Show.S01E01', canMoveFiles: true });
  });

  it('moves a failed grabbed usenet download to failedPending and fires the failed hook', async () => {
    const { service, fake, c } = await grabbed();
    let failed = 0;
    service.onItemFailed(() => {
      failed++;
    });
    fake(c.id).items = [item({ id: 'nzo_1', status: 'failed', statusMessage: 'Repair failed' })];
    await service.refreshQueue();
    expect(failed).toBe(1);
    expect(service.listTracked()[0]).toMatchObject({ trackedState: 'failedPending', trackedStatus: 'error' });
  });

  it('leaves a failed usenet download that Arclight did not grab in downloading', async () => {
    const { service, fake } = await setup();
    const c = service.create(clientOf('sabnzbd', 'SAB'));
    fake(c.id).items = [item({ id: 'foreign', status: 'failed' })];
    await service.refreshQueue();
    const tracked = service.listTracked()[0]!;
    expect(tracked.trackedState).toBe('downloading');
    expect(tracked.protocol).toBe('usenet');
    expect(tracked.statusMessages.flatMap((m) => m.messages)).toContain(
      "Download failed and wasn't grabbed by Arclight, skipping automatic failed download handling.",
    );
  });
});
