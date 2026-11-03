import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { stubApi } from '../../../test/route-harness.js';
import { AppSignInPanel } from './app-sign-in.js';

function wrap(children: ReactNode) {
  const toasts = createToastStore();
  return render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}

const SERVER = 'https://media.example.org';
const code = (value: string, ms = 5 * 60_000) => ({
  code: value,
  expiresAt: new Date(Date.now() + ms).toISOString(),
  serverUrl: SERVER,
  qr: `arclight://pair?server=${encodeURIComponent(SERVER)}&code=${value}`,
});
const device = (id: number, name: string) => ({
  id,
  userId: 2,
  name,
  platform: 'android',
  appVersion: '1.2.0',
  createdAt: '2026-11-01T10:00:00Z',
  lastSeenAt: '2026-11-01T10:00:00Z',
  lastIp: null,
  method: 'pairing',
  current: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Sign in to the Arclight app', () => {
  it('shows the QR code, the code and server address as text, and a countdown', async () => {
    stubApi({ 'POST /api/v1/app/pair-codes': code('ABCDEFGH', 90_000), '/api/v1/app/devices': [] });
    wrap(<AppSignInPanel />);
    const qr = await screen.findByRole('img', { name: `Sign-in code for ${SERVER}` });
    expect(qr.getAttribute('data-value')).toBe(`arclight://pair?server=${encodeURIComponent(SERVER)}&code=ABCDEFGH`);
    expect(screen.getByTestId('app-pair-code').textContent).toBe('ABCD-EFGH');
    expect(screen.getByTestId('app-server-url').textContent).toBe(SERVER);
    expect(screen.getByTestId('app-pair-countdown').textContent).toMatch(/expires in 1:(29|30)\./);
    expect(await screen.findByText(/No device is signed in/)).toBeTruthy();
  });

  it('says when the code has expired and makes a new one on request', async () => {
    let n = 0;
    const api = stubApi({
      'POST /api/v1/app/pair-codes': () => (++n === 1 ? code('AAAABBBB', -1000) : code('CCCCDDDD')),
      '/api/v1/app/devices': [],
    });
    wrap(<AppSignInPanel />);
    expect(await screen.findByText(/This code has expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New code' }));
    await waitFor(() => expect(screen.getByTestId('app-pair-code').textContent).toBe('CCCC-DDDD'));
    expect(screen.getByTestId('app-pair-countdown').textContent).toMatch(/expires in [45]:\d\d/);
    expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/app/pair-codes')).toHaveLength(2);
  });

  it('lists signed-in devices and removes one after confirming', async () => {
    let devices = [device(1, 'Pixel'), device(2, 'iPad')];
    const api = stubApi({
      'POST /api/v1/app/pair-codes': code('ABCDEFGH'),
      '/api/v1/app/devices': () => devices,
      'DELETE /api/v1/app/devices/1': () => {
        devices = devices.filter((d) => d.id !== 1);
        return null;
      },
    });
    wrap(<AppSignInPanel />);
    expect(await screen.findByText('Pixel')).toBeTruthy();
    expect(screen.getAllByText(/Android · App 1\.2\.0 · last used/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(await screen.findByText('Remove Pixel?')).toBeTruthy();
    const dialogButtons = screen.getAllByRole('button', { name: 'Remove' });
    await act(async () => {
      fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    });
    await waitFor(() => expect(screen.queryByText('Pixel')).toBeNull());
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/app/devices/1')).toBe(true);
    expect(screen.getByText('iPad')).toBeTruthy();
  });
});
