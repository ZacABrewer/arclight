import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../components/toast.js';
import { createToastStore } from '../lib/toast.js';
import { createQueryClient } from '../query-client.js';
import { routeTree } from '../router.js';
import { loginHref } from './guard.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const admin = { id: 1, username: 'admin', role: 'admin', permissions: 2, createdAt: '2026-01-01T00:00:00.000Z', settings: {} };
const viewer = { ...admin, id: 2, username: 'viewer', displayName: 'Vee', role: 'user', permissions: 0 };

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;
let handler: Handler;
let calls: Array<{ url: string; method: string; body: unknown }>;

function anonymous(needsSetup = false) {
  return { needsSetup, authMethod: 'forms', authenticated: false, session: null };
}
function signedIn(user: typeof admin) {
  const session = { user, via: 'session', isAdmin: user.role === 'admin' };
  return { status: { needsSetup: false, authMethod: 'forms', authenticated: true, session }, session };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = handler(url, init) ?? { status: 404, body: { error: 'not found' } };
      return r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body), { status: r.status });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('route guard', () => {
  it('redirects to /setup when setup is needed', async () => {
    handler = (url) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: anonymous(true) };
      if (url === '/api/v1/setup/status')
        return { status: 200, body: { needsSetup: true, steps: [{ id: 'admin', complete: false, optional: false }] } };
      return undefined;
    };
    const router = renderAt('/library/tv');
    expect(await screen.findByRole('heading', { name: 'Create the admin account' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/setup');
  });

  it('redirects anonymous users to /login and remembers where they were going', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous() } : undefined);
    const router = renderAt('/calendar');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: '/calendar' });
    // No shell (and no sidebar) on the login page.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('hides admin-only nav for role user and shows the user menu', async () => {
    const { status, session } = signedIn(viewer);
    handler = (url) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: status };
      if (url === '/api/v1/auth/me') return { status: 200, body: session };
      return undefined;
    };
    renderAt('/calendar');
    expect(await screen.findByRole('button', { name: /Vee/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'System' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeTruthy();
    // No admin status in the top bar; the mobile bar swaps Activity for Requests.
    expect(document.querySelector('.al-topbar__requests')).toBeNull();
    expect(document.querySelector('.al-topbar__vpn')).toBeNull();
    const tabbar = document.querySelector('.al-tabbar') as HTMLElement;
    expect(Array.from(tabbar.querySelectorAll('.al-tabbar__item')).map((t) => t.textContent)).toEqual(['Home', 'Library', 'Discover', 'Requests', 'More']);
    fireEvent.click(screen.getByRole('button', { name: /Vee/ }));
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Security/ })).toBeNull();
  });
});

describe('login form', () => {
  it('shows the session-expired banner (Page 07) when a 401 sent the user back', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous() } : undefined);
    renderAt(loginHref('/calendar', true));
    expect(await screen.findByText('Your session expired. Sign in to continue.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(loginHref('/calendar', true)).toBe('/login?redirect=%2Fcalendar&expired=1');
    expect(loginHref('/')).toBe('/login');
  });

  it('shows no banner on a normal visit', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous() } : undefined);
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(/session expired/)).toBeNull();
  });

  it('validates, reports bad credentials, then signs in and returns to the target', async () => {
    let authed = false;
    const { status, session } = signedIn(admin);
    handler = (url, init) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: authed ? status : anonymous() };
      if (url === '/api/v1/auth/me') return { status: 200, body: session };
      if (url === '/api/v1/auth/login' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { password: string };
        if (body.password !== 'password1') return { status: 401, body: { error: 'invalid username or password', code: 'INVALID_CREDENTIALS' } };
        authed = true;
        return { status: 200, body: session };
      }
      if (url === '/api/v1/system/status') return { status: 200, body: { appName: 'Arclight', version: '0.1.0', startTime: '2026-10-25T09:00:00.000Z', uptimeSeconds: 1, runtime: { node: 'v24', platform: 'linux', arch: 'x64' }, paths: { config: '/c', database: '/c/db', logs: '/c/l' }, isDocker: false } };
      return undefined;
    };
    const router = renderAt('/login?redirect=%2Fsystem%2Fstatus');
    const submit = await screen.findByRole('button', { name: 'Sign in' });
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Enter your username and password/);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Incorrect username or password/);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/system/status'));
    expect(calls.find((c) => c.url === '/api/v1/auth/login' && (c.body as { password: string }).password === 'password1')?.body).toEqual({
      username: 'admin',
      password: 'password1',
      rememberMe: true,
    });
  });
});

describe('setup wizard', () => {
  it('blocks an invalid admin step and creates the admin when valid', async () => {
    let created = false;
    handler = (url, init) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: created ? { ...signedIn(admin).status, needsSetup: true } : anonymous(true) };
      if (url === '/api/v1/auth/me') return { status: 200, body: signedIn(admin).session };
      if (url === '/api/v1/setup/status')
        return {
          status: 200,
          body: { needsSetup: true, steps: [{ id: 'admin', complete: created, optional: false }, { id: 'tmdb', complete: false, optional: false }] },
        };
      if (url === '/api/v1/setup/admin' && init?.method === 'POST') {
        created = true;
        return { status: 201, body: signedIn(admin).session };
      }
      return undefined;
    };
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Create the admin account' });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create admin account' }));
    expect(await screen.findByText('At least 8 characters.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/setup/admin')).toBe(false);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create admin account' }));
    expect(await screen.findByRole('heading', { name: 'Connect TMDB' })).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/setup/admin')?.body).toEqual({ username: 'admin', password: 'password1' });
  });

  it('requires a TMDB key before moving on', async () => {
    const { status, session } = signedIn(admin);
    handler = (url) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: { ...status, needsSetup: true } };
      if (url === '/api/v1/auth/me') return { status: 200, body: session };
      if (url === '/api/v1/setup/status')
        return { status: 200, body: { needsSetup: true, steps: [{ id: 'admin', complete: true, optional: false }, { id: 'tmdb', complete: false, optional: false }] } };
      return undefined;
    };
    renderAt('/setup');
    await screen.findByRole('heading', { name: 'Connect TMDB' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/TMDB API key is required/);
  });
});
