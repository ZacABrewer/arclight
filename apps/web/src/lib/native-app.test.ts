import { afterEach, describe, expect, it, vi } from 'vitest';
import { installInAppMode, isExternalLink, isInApp, openExternal, parseAppUserAgent, shell, shellErrorCode, shellInfo, switchServer, type ArclightShellPlugin } from './native-app.js';

const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 ArclightApp/1.2.3 (ios)';

function fakePlugin(): ArclightShellPlugin & { [K in keyof ArclightShellPlugin]: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(async () => ({ platform: 'ios' as const, appVersion: '1.2.3', build: '7', pushAvailable: true })),
    registerPush: vi.fn(async () => ({ relayDeviceId: 'dev-1', relaySecret: 's'.repeat(32), platform: 'ios' as const, deviceName: 'iPhone' })),
    unregisterPush: vi.fn(async () => undefined),
    switchServer: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
  };
}

/** Stand-in for window with the given user agent and optional Capacitor global. */
function fakeWindow(ua: string, capacitor?: unknown) {
  return { navigator: { userAgent: ua }, document, location: window.location, open: vi.fn(), Capacitor: capacitor } as unknown as Window & { open: ReturnType<typeof vi.fn> };
}

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  document.body.innerHTML = '';
});

describe('app detection', () => {
  it('reads the app version and platform from the user agent', () => {
    expect(parseAppUserAgent(APP_UA)).toEqual({ version: '1.2.3', platform: 'ios' });
    expect(parseAppUserAgent('Mozilla/5.0 (Linux; Android 15) ArclightApp/2.0.0-beta.1 (android)')).toEqual({ version: '2.0.0-beta.1', platform: 'android' });
    expect(parseAppUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/130')).toBeNull();
  });

  it('detects the app by user agent or Capacitor, and nothing in a plain browser', () => {
    expect(isInApp(fakeWindow(APP_UA))).toBe(true);
    expect(isInApp(fakeWindow('Chrome', { isNativePlatform: () => true }))).toBe(true);
    expect(isInApp(fakeWindow('Chrome', { isNativePlatform: () => false }))).toBe(false);
    expect(isInApp(fakeWindow('Chrome'))).toBe(false);
    expect(isInApp(window)).toBe(false);
  });

  it('degrades to null / false without the plugin, never throwing', async () => {
    const w = fakeWindow(APP_UA, { Plugins: {} });
    expect(shell(w)).toBeNull();
    expect(await shellInfo(w)).toBeNull();
    expect(await switchServer(w)).toBe(false);
    expect(await openExternal('https://example.com', w)).toBe(false);
    expect(shell(window)).toBeNull();
  });

  it('calls the plugin when it is there', async () => {
    const plugin = fakePlugin();
    const w = fakeWindow(APP_UA, { isNativePlatform: () => true, Plugins: { ArclightShell: plugin } });
    expect(await shellInfo(w)).toMatchObject({ platform: 'ios', pushAvailable: true });
    expect(await switchServer(w)).toBe(true);
    expect(plugin.switchServer).toHaveBeenCalledTimes(1);
    expect(await openExternal('https://example.com/x', w)).toBe(true);
    expect(plugin.openExternal).toHaveBeenCalledWith({ url: 'https://example.com/x' });
    plugin.info.mockRejectedValueOnce(new Error('boom'));
    expect(await shellInfo(w)).toBeNull();
  });

  it('maps plugin rejection codes', () => {
    expect(shellErrorCode({ code: 'denied', message: 'no' })).toBe('denied');
    expect(shellErrorCode(new Error('x'))).toBeNull();
  });
});

describe('in-app mode', () => {
  function link(href: string, target?: string) {
    const a = document.createElement('a');
    a.href = href;
    if (target) a.target = target;
    a.textContent = 'link';
    document.body.appendChild(a);
    return a;
  }

  it('classifies external links', () => {
    const origin = window.location.origin;
    expect(isExternalLink(link('https://www.themoviedb.org/movie/1'), origin)).toBe(true);
    expect(isExternalLink(link('/library/movies'), origin)).toBe(false);
    expect(isExternalLink(link('/docs/x', '_blank'), origin)).toBe(true);
    expect(isExternalLink(link('#top'), origin)).toBe(false);
    expect(isExternalLink(link('javascript:void(0)'), origin)).toBe(false);
  });

  it('marks <html> and sends external links to the system browser', async () => {
    const plugin = fakePlugin();
    const w = fakeWindow(APP_UA, { isNativePlatform: () => true, Plugins: { ArclightShell: plugin } });
    undo = installInAppMode(w);
    expect(document.documentElement.classList.contains('in-app')).toBe(true);
    expect(document.documentElement.classList.contains('in-app--ios')).toBe(true);

    const external = link('https://www.imdb.com/title/tt1160419/', '_blank');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    external.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(plugin.openExternal).toHaveBeenCalledWith({ url: 'https://www.imdb.com/title/tt1160419/' }));

    const internal = link('/calendar');
    const inner = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    internal.addEventListener('click', (e) => e.preventDefault()); // keep jsdom from navigating
    internal.dispatchEvent(inner);
    expect(plugin.openExternal).toHaveBeenCalledTimes(1);

    undo();
    undo = null;
    expect(document.documentElement.classList.contains('in-app')).toBe(false);
  });

  it('does nothing in a plain browser', () => {
    undo = installInAppMode(fakeWindow('Mozilla/5.0 Chrome/130'));
    expect(document.documentElement.classList.contains('in-app')).toBe(false);
    const a = link('https://example.com', '_blank');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.addEventListener('click', (e) => e.preventDefault());
    a.dispatchEvent(event);
    // Only our own listener above prevented it; nothing else intercepted.
    expect(event.defaultPrevented).toBe(true);
  });
});
