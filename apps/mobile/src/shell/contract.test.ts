import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../core/kv.js';
import { PushService } from '../core/push.js';
import { createArclightShell, type ArclightShellPlugin, type ShellDeps } from './contract.js';

function make(over: Partial<ShellDeps> = {}, http = vi.fn(async () => ({ status: 200, url: '', data: { deviceId: 'dev1', secret: 's' } }))) {
  const push = new PushService({
    kv: memoryStore(),
    http,
    relayUrl: 'https://arclight-push.moviemethat.com',
    platform: 'android',
    appId: 'com.moviemethat.arclight.admin',
    appVersion: '1.0.0',
    pushAvailable: async () => true,
    requestPermission: async () => true,
    getToken: async () => 'tok',
    deviceName: async () => 'Pixel 9',
    environment: async () => 'production',
  });
  const deps: ShellDeps = {
    platform: 'android',
    appVersion: '1.0.0',
    build: async () => '1',
    pushAvailable: async () => true,
    push,
    currentServer: () => 'https://a.example.com',
    openServerList: vi.fn(async () => undefined),
    openBrowser: vi.fn(async () => undefined),
    ...over,
  };
  return { shell: createArclightShell(deps), deps, http, push };
}

describe('ArclightShell contract', () => {
  it('exposes exactly the agreed methods', () => {
    const { shell } = make();
    const names: Array<keyof ArclightShellPlugin> = ['info', 'registerPush', 'unregisterPush', 'switchServer', 'openExternal'];
    expect(Object.keys(shell).sort()).toEqual([...names].sort());
  });

  it('info()', async () => {
    expect(await make().shell.info()).toEqual({ platform: 'android', appVersion: '1.0.0', build: '1', pushAvailable: true });
    expect(await make({ build: async () => Promise.reject(new Error('x')), pushAvailable: async () => false }).shell.info()).toEqual({ platform: 'android', appVersion: '1.0.0', build: '0', pushAvailable: false });
  });

  it('registerPush() resolves the agreed shape and records the calling server', async () => {
    const { shell, push } = make();
    expect(await shell.registerPush()).toEqual({ relayDeviceId: 'dev1', relaySecret: 's', platform: 'android', deviceName: 'Pixel 9', appId: 'com.moviemethat.arclight.admin' });
    expect((await push.state())?.servers).toEqual(['https://a.example.com']);
  });

  it('registerPush() rejects with { code, message }', async () => {
    const { shell } = make({}, vi.fn(async () => Promise.reject(new Error('offline'))));
    const err = await shell.registerPush().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'relay', message: expect.stringContaining('offline') });
  });

  it('unregisterPush() deletes the device for the last server', async () => {
    const { shell, http, push } = make();
    await shell.registerPush();
    await shell.unregisterPush();
    expect(http).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', url: 'https://arclight-push.moviemethat.com/v1/devices/dev1' }));
    expect(await push.state()).toBeNull();
  });

  it('switchServer() and openExternal()', async () => {
    const { shell, deps } = make();
    await shell.switchServer();
    expect(deps.openServerList).toHaveBeenCalled();
    await shell.openExternal({ url: 'https://www.themoviedb.org/movie/1' });
    expect(deps.openBrowser).toHaveBeenCalledWith('https://www.themoviedb.org/movie/1');
    await expect(shell.openExternal({ url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(shell.openExternal({ url: '/relative' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
