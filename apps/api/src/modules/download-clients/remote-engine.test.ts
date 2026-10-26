import { describe, expect, it } from 'vitest';
import { downloadClientHost, PASSWORD_MASK } from '@arclight/shared';
import { remoteEngineUnreachableCheck } from '../health/checks/remote-engine.js';
import type { HealthDeps } from '../health/types.js';
import { implementationSchemas } from './templates.js';
import { DownloadClientError, item, setup } from './test-support.js';

// The `remoteEngine` kind inside the download-clients module: secrets, VPN port sync, remote
// path mapping host, templates and the RemoteEngineUnreachable health check.

function remote(name: string, settings: Record<string, unknown> = {}) {
  return { name, implementation: 'remoteEngine' as const, settings: { url: 'http://seedbox.lan:7879', token: 'agent-secret-token', ...settings } };
}

describe('remoteEngine in the download-clients service', () => {
  it('masks the token on read and keeps it when the mask comes back', async () => {
    const { service, fake } = await setup();
    const created = service.create(remote('Seedbox'));
    expect(created.settings).toMatchObject({ token: PASSWORD_MASK, url: 'http://seedbox.lan:7879', pullMode: false });
    service.update(created.id, { ...remote('Seedbox'), settings: { ...remote('Seedbox').settings, token: PASSWORD_MASK, pullMode: true } });
    expect((fake(created.id).config.settings as { token: string }).token).toBe('agent-secret-token');
  });

  it('applies the VPN port only to remote engines that follow it', async () => {
    const { service, fake } = await setup();
    const follows = service.create(remote('Same VPN', { followVpnPort: true }));
    const own = service.create(remote('Own VPN'));
    const ports: Record<number, number> = {};
    for (const id of [follows.id, own.id]) {
      (fake(id) as { setListenPort?: (port: number) => Promise<void> }).setListenPort = async (port: number) => {
        ports[id] = port;
      };
    }
    const results = await service.setListenPortOnAll(51_413);
    expect(results.map((r) => r.id)).toEqual([follows.id]);
    expect(ports).toEqual({ [follows.id]: 51_413 });
  });

  it('keys remote path mappings on the agent URL host', async () => {
    const { service, fake } = await setup();
    const c = service.create(remote('Seedbox'));
    await service.createMapping({ host: 'seedbox.lan', remotePath: '/downloads/', localPath: '/mnt/seedbox/' });
    fake(c.id).items = [item({ id: 'h1', status: 'seeding', progress: 1, remainingBytes: 0, outputPath: '/downloads/tv/Show.S01E01' })];
    await service.refreshQueue();
    const [tracked] = service.listTracked();
    expect(tracked).toMatchObject({ outputPath: '/mnt/seedbox/tv/Show.S01E01', trackedState: 'importPending' });
    expect(downloadClientHost({ url: 'https://agent.example:8443/x' })).toBe('agent.example');
  });

  it('reports remote engine reachability from the last poll', async () => {
    const { service, fake } = await setup();
    const up = service.create(remote('Up'));
    const down = service.create(remote('Down', { url: 'http://vps:7879' }));
    fake(down.id).failGetItems = new DownloadClientError('unreachable', 'connect ECONNREFUSED');
    fake(up.id).items = [];
    await service.refreshQueue();
    const health = await service.remoteEngineHealth();
    expect(health).toEqual([
      { id: up.id, name: 'Up', url: 'http://seedbox.lan:7879', ok: true },
      { id: down.id, name: 'Down', url: 'http://vps:7879', ok: false, message: 'connect ECONNREFUSED' },
    ]);
  });

  it('serves a template for the remote engine with the token as a password field', () => {
    const schema = implementationSchemas().find((s) => s.implementation === 'remoteEngine')!;
    expect(schema).toMatchObject({ implementationName: 'Remote Engine', protocol: 'torrent' });
    const field = (name: string) => schema.fields.find((f) => f.name === `settings.${name}`)!;
    expect(field('token').type).toBe('password');
    expect(field('pullMode').type).toBe('checkbox');
    expect(field('url')).toMatchObject({ label: 'Agent URL', required: true });
    expect(field('bandwidthLimitKbps')).toMatchObject({ type: 'number', advanced: true, min: 0 });
  });
});

describe('RemoteEngineUnreachable health check', () => {
  it('emits one error per unreachable engine and nothing when all are up', async () => {
    const deps = (engines: Array<{ id: number; name: string; url: string; ok: boolean; message?: string }>) =>
      ({ remoteEngines: async () => engines }) as unknown as HealthDeps;
    expect(await remoteEngineUnreachableCheck.run(deps([{ id: 1, name: 'A', url: 'http://a', ok: true }]))).toEqual([]);
    const findings = await remoteEngineUnreachableCheck.run(
      deps([
        { id: 1, name: 'A', url: 'http://a', ok: false, message: 'timeout' },
        { id: 2, name: 'B', url: 'http://b', ok: false },
      ]),
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ source: 'RemoteEngineUnreachable', status: 'error' });
    expect(findings[0]!.message).toContain('Remote engine A (http://a) is unreachable: timeout');
    expect(await remoteEngineUnreachableCheck.run({} as HealthDeps)).toEqual([]);
  });
});
