import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi } from '../../test/route-harness.js';
import { toSubscriptionInput, urlBase64ToUint8Array } from '../../lib/web-push.js';

const push = vi.hoisted(() => ({ subscribed: false, enable: vi.fn(), disable: vi.fn() }));
vi.mock('../../lib/web-push.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/web-push.js')>();
  return {
    ...real,
    currentSubscription: async () => (push.subscribed ? ({ endpoint: 'https://push.example/x' } as PushSubscription) : null),
    enablePush: push.enable,
    disablePush: push.disable,
  };
});

const { BrowserNotifications } = await import('./browser-notifications.js');

beforeEach(() => {
  push.subscribed = false;
  push.enable.mockReset().mockResolvedValue({});
  push.disable.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
});
afterEach(() => vi.unstubAllGlobals());

function renderIt(support: 'supported' | 'unsupported' | 'insecure' = 'supported') {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <BrowserNotifications support={support} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('web push helpers', () => {
  it('decodes the VAPID key and maps the browser subscription', () => {
    expect([...urlBase64ToUint8Array('BAEC_w')]).toEqual([4, 1, 2, 255]);
    expect(toSubscriptionInput({ endpoint: 'https://push.example/x', expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } }, 'Firefox')).toEqual({
      endpoint: 'https://push.example/x',
      expirationTime: null,
      keys: { p256dh: 'pk', auth: 'au' },
      userAgent: 'Firefox',
    });
    expect(() => toSubscriptionInput({ endpoint: 'https://push.example/x' })).toThrow(/incomplete/);
  });
});

describe('Profile → Browser notifications', () => {
  it('explains when the browser cannot do push', () => {
    renderIt('unsupported');
    expect(screen.getByText(/does not support push notifications/)).toBeTruthy();
  });

  it('asks for permission and subscribes when turned on, then saves per-event toggles', async () => {
    const api = stubApi({
      '/api/v1/push/preferences': { requests: true, availability: true, issues: true },
      'PUT /api/v1/push/preferences': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
      'POST /api/v1/push/test': { sent: 1, failed: 0, removed: 0 },
    });
    renderIt();
    const main = await screen.findByRole('switch', { name: /Show notifications in this browser/ });
    fireEvent.click(main);
    await waitFor(() => expect(push.enable).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('switch', { name: /Notifications are on/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Sent to 1 browser')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: /issues you reported/ }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ requests: true, availability: true, issues: false }));
  });

  it('shows why turning on failed', async () => {
    stubApi({ '/api/v1/push/preferences': { requests: true, availability: false, issues: true } });
    push.enable.mockRejectedValueOnce(new Error('Notifications are blocked for this site.'));
    renderIt();
    fireEvent.click(await screen.findByRole('switch', { name: /Show notifications in this browser/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/blocked/);
  });

  it('turns off a subscribed browser', async () => {
    push.subscribed = true;
    vi.stubGlobal('Notification', { permission: 'granted' });
    stubApi({ '/api/v1/push/preferences': { requests: true, availability: true, issues: true } });
    renderIt();
    fireEvent.click(await screen.findByRole('switch', { name: /Notifications are on/ }));
    await waitFor(() => expect(push.disable).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('switch', { name: /Show notifications in this browser/ })).toBeTruthy();
  });
});
