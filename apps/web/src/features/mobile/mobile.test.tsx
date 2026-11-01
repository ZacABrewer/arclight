import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi } from '../../test/route-harness.js';
import type { ArclightShellPlugin } from '../../lib/native-app.js';
import { DEVICE_ID_KEY, DeviceNotifications } from './device-notifications.js';
import { MobileAppSection, pairingServerUrl } from './mobile-app-section.js';

function wrap(children: ReactNode) {
  const toasts = createToastStore();
  return render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}

const device = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  userId: 2,
  relayDeviceId: `dev-${id}`,
  platform: 'ios',
  deviceName: `iPhone ${id}`,
  appVersion: '1.0.0',
  createdAt: '2026-10-31T10:00:00Z',
  lastSeenAt: '2026-10-31T10:00:00Z',
  ...extra,
});

const prefs = { '/api/v1/push/preferences': { requests: true, availability: true, issues: true } };

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('Mobile app section', () => {
  it('encodes the Application URL in the pairing QR code and shows it as text', async () => {
    stubApi({ '/api/v1/mobile/pairing': { serverUrl: 'https://arclight.example.com', pushEnabled: true }, '/api/v1/mobile/devices': [] });
    wrap(<MobileAppSection />);
    const qr = await screen.findByRole('img', { name: /Pairing code for https:\/\/arclight\.example\.com/ });
    expect(qr.getAttribute('data-value')).toBe('arclight://pair?url=https%3A%2F%2Farclight.example.com');
    expect(screen.getByTestId('mobile-server-url').textContent).toBe('https://arclight.example.com');
    expect(screen.getByRole('link', { name: /iPhone and iPad/ }).getAttribute('href')).toBe('https://arclight.moviemethat.com/');
    expect(await screen.findByText(/No phone is paired yet/)).toBeTruthy();
  });

  it('falls back to this page’s origin without an Application URL', async () => {
    stubApi({ '/api/v1/mobile/pairing': { serverUrl: null, pushEnabled: false }, '/api/v1/mobile/devices': [] });
    wrap(<MobileAppSection />);
    const qr = await screen.findByRole('img', { name: /Pairing code/ });
    expect(qr.getAttribute('data-value')).toBe(`arclight://pair?url=${encodeURIComponent(window.location.origin)}`);
    expect(screen.getByText(/Phone notifications are turned off/)).toBeTruthy();
    expect(pairingServerUrl(' https://x.example.com/ ', 'http://o')).toBe('https://x.example.com');
  });

  it('lists devices with test and remove (admin view shows owners)', async () => {
    const api = stubApi({
      '/api/v1/mobile/pairing': { serverUrl: null, pushEnabled: true },
      '/api/v1/mobile/devices': (_i: RequestInit | undefined, url: URL) => (url.searchParams.get('all') === 'true' ? [device(1, { userName: 'alice' })] : []),
      'POST /api/v1/mobile/devices/1/test': { ok: true, outcome: 'sent' },
      'DELETE /api/v1/mobile/devices/1': null,
    });
    wrap(<MobileAppSection all />);
    expect(await screen.findByText('iPhone 1')).toBeTruthy();
    expect(screen.getByText(/alice · iOS · App 1\.0\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Sent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/mobile/devices/1')).toBe(true));
  });
});

function plugin(over: Partial<Record<keyof ArclightShellPlugin, unknown>> = {}) {
  const order: string[] = [];
  const p = {
    info: vi.fn(async () => ({ platform: 'ios', appVersion: '1.4.0', build: '12', pushAvailable: true })),
    registerPush: vi.fn(async () => {
      order.push('registerPush');
      return { relayDeviceId: 'dev-9', relaySecret: 'secret-'.repeat(5), platform: 'ios', deviceName: 'Sam’s iPhone' };
    }),
    unregisterPush: vi.fn(async () => {
      order.push('unregisterPush');
    }),
    switchServer: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    ...over,
  };
  return { plugin: p as unknown as ArclightShellPlugin, mocks: p, order };
}

describe('Notifications on this device', () => {
  it('registers with the app, then with the server', async () => {
    const { plugin: p, mocks, order } = plugin();
    let devices: unknown[] = [];
    const api = stubApi({
      ...prefs,
      '/api/v1/mobile/pairing': { serverUrl: null, pushEnabled: true },
      '/api/v1/mobile/devices': () => devices,
      'POST /api/v1/mobile/devices': (init: RequestInit | undefined) => {
        order.push('POST');
        devices = [device(9, { relayDeviceId: 'dev-9' })];
        return { ...device(9), ...(JSON.parse(String(init?.body)) as object), relaySecret: undefined };
      },
    });
    wrap(<DeviceNotifications plugin={p} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Show notifications on this device/ }));
    expect(await screen.findByRole('switch', { name: /Notifications are on/ })).toBeTruthy();
    expect(order).toEqual(['registerPush', 'POST']);
    expect(mocks.registerPush).toHaveBeenCalledTimes(1);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ relayDeviceId: 'dev-9', relaySecret: 'secret-'.repeat(5), platform: 'ios', deviceName: 'Sam’s iPhone', appVersion: '1.4.0' });
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe('dev-9');
  });

  it('turns off: removes the device on the server, then unregisters in the app', async () => {
    localStorage.setItem(DEVICE_ID_KEY, 'dev-9');
    const { plugin: p, order } = plugin();
    let devices: unknown[] = [device(9)];
    stubApi({
      ...prefs,
      '/api/v1/mobile/pairing': { serverUrl: null, pushEnabled: true },
      '/api/v1/mobile/devices': () => devices,
      'DELETE /api/v1/mobile/devices/9': () => {
        order.push('DELETE');
        devices = [];
        return null;
      },
    });
    wrap(<DeviceNotifications plugin={p} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Notifications are on/ }));
    expect(await screen.findByRole('switch', { name: /Show notifications on this device/ })).toBeTruthy();
    expect(order).toEqual(['DELETE', 'unregisterPush']);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBeNull();
  });

  it('explains a denied permission', async () => {
    const { plugin: p } = plugin({ registerPush: vi.fn(async () => Promise.reject({ code: 'denied', message: 'nope' })) });
    stubApi({ ...prefs, '/api/v1/mobile/pairing': { serverUrl: null, pushEnabled: true }, '/api/v1/mobile/devices': [] });
    wrap(<DeviceNotifications plugin={p} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Show notifications on this device/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/turned off for Arclight in the phone’s settings/);
  });

  it('renders nothing without the plugin (plain browser)', () => {
    const api = stubApi({});
    const { container } = wrap(<DeviceNotifications plugin={null} />);
    expect(container.textContent).toBe('');
    expect(api.calls).toEqual([]);
  });
});

describe('in-app styles', () => {
  it('pads the admin shell and the portal for safe areas', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/arclight/in-app.css'), 'utf8');
    for (const sel of ['.in-app .al-topbar', '.in-app .al-content', '.in-app .portal-head', '.in-app .portal-main']) expect(css).toContain(sel);
    expect(css).toContain('env(safe-area-inset-top');
    expect(readFileSync(join(process.cwd(), 'src/styles/arclight/index.css'), 'utf8')).toContain("@import './in-app.css';");
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).toContain('viewport-fit=cover');
  });
});
