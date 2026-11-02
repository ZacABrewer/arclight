import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { passwordFormHidden, ssoErrorMessage, visibleProviders } from './sign-in.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const admin = { id: 1, username: 'admin', role: 'admin', permissions: 2, createdAt: '2026-01-01T00:00:00.000Z', settings: {} };
const session = { user: admin, via: 'session', isAdmin: true };
const signedInStatus = { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: true, session };
const systemStatus = {
  appName: 'Arclight',
  version: '0.1.0',
  startTime: '2026-10-25T09:00:00.000Z',
  uptimeSeconds: 1,
  runtime: { node: 'v24', platform: 'linux', arch: 'x64' },
  paths: { config: '/c', database: '/c/db', logs: '/c/l' },
  isDocker: false,
};

const providers = [
  { id: 'authentik', name: 'Authentik', showOnLogin: true, showOnPortal: false },
  { id: 'portal-sso', name: 'Family SSO', showOnLogin: false, showOnPortal: true },
];

function anonymous(signIn?: { providers: typeof providers; hidePasswordLogin: boolean; passkeys: boolean }) {
  return { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: false, session: null, ...(signIn ? { signIn } : {}) };
}

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;
let handler: Handler;
let calls: Array<{ url: string; method: string; body: unknown }>;

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

describe('sign-in helpers', () => {
  it('picks the buttons per page and hides the password form only with a button and without ?local=1', () => {
    const signIn = { providers, hidePasswordLogin: true, passkeys: false };
    expect(visibleProviders(signIn, 'login').map((p) => p.id)).toEqual(['authentik']);
    expect(visibleProviders(signIn, 'portal').map((p) => p.id)).toEqual(['portal-sso']);
    expect(passwordFormHidden(signIn, visibleProviders(signIn, 'login'), false)).toBe(true);
    expect(passwordFormHidden(signIn, visibleProviders(signIn, 'login'), true)).toBe(false);
    expect(passwordFormHidden(signIn, [], false)).toBe(false);
    expect(passwordFormHidden({ ...signIn, hidePasswordLogin: false }, providers, false)).toBe(false);
    expect(ssoErrorMessage('no_account')).toMatch(/no Arclight account/);
    expect(ssoErrorMessage('something-new')).toMatch(/did not complete/);
  });
});

describe('login page: identity providers', () => {
  it('shows the login-page provider buttons as links to the api start route', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous({ providers, hidePasswordLogin: false, passkeys: false }) } : undefined);
    renderAt('/login?redirect=%2Fcalendar');
    const link = await screen.findByRole('link', { name: 'Sign in with Authentik' });
    expect(link.getAttribute('href')).toBe('/api/v1/auth/oidc/authentik/start?returnTo=%2Fcalendar&rememberMe=true');
    // The portal-only provider is not offered on the admin sign-in page.
    expect(screen.queryByRole('link', { name: 'Sign in with Family SSO' })).toBeNull();
    // The password form is still there.
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('offers the portal providers when signing in to the portal', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous({ providers, hidePasswordLogin: false, passkeys: false }) } : undefined);
    renderAt('/login?redirect=%2Fportal');
    const link = await screen.findByRole('link', { name: 'Sign in with Family SSO' });
    expect(link.getAttribute('href')).toContain('returnTo=%2Fportal');
    expect(screen.queryByRole('link', { name: 'Sign in with Authentik' })).toBeNull();
  });

  it('hides the password form when the admin turned it off, and ?local=1 brings it back', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous({ providers, hidePasswordLogin: true, passkeys: false }) } : undefined);
    renderAt('/login');
    await screen.findByRole('link', { name: 'Sign in with Authentik' });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByText(/identity provider is unavailable/)).toBeNull();
  });

  it('shows the password form and the break-glass note with ?local=1', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous({ providers, hidePasswordLogin: true, passkeys: false }) } : undefined);
    renderAt('/login?local=1');
    expect(await screen.findByRole('link', { name: 'Sign in with Authentik' })).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByText(/identity provider is unavailable/)).toBeTruthy();
  });

  it('explains an ?ssoError from the provider callback', async () => {
    handler = (url) => (url === '/api/v1/auth/status' ? { status: 200, body: anonymous({ providers, hidePasswordLogin: false, passkeys: false }) } : undefined);
    renderAt('/login?ssoError=forbidden');
    expect(await screen.findByText(/not allowed to sign in to Arclight/)).toBeTruthy();
  });
});

describe('login page: two-factor step', () => {
  function twoFactorHandler(state: { authed: boolean }): Handler {
    return (url, init) => {
      if (url === '/api/v1/auth/status') return { status: 200, body: state.authed ? signedInStatus : anonymous() };
      if (url === '/api/v1/auth/me') return { status: 200, body: session };
      if (url === '/api/v1/system/status') return { status: 200, body: systemStatus };
      if (url === '/api/v1/auth/login' && init?.method === 'POST')
        return { status: 200, body: { twoFactorRequired: true, challenge: 'chal-1', methods: ['totp', 'recovery'] } };
      if (url === '/api/v1/auth/login/2fa' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { code?: string; recoveryCode?: string };
        if (body.code === '123456' || body.recoveryCode === 'abcd-efgh-ijkl') {
          state.authed = true;
          return { status: 200, body: session };
        }
        return { status: 401, body: { error: 'invalid code', code: 'INVALID_CODE' } };
      }
      return undefined;
    };
  }

  async function passwordStep() {
    await screen.findByRole('button', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('form', { name: 'Two-factor sign-in' });
  }

  it('asks for the authenticator code, reports a wrong one, then signs in', async () => {
    const state = { authed: false };
    handler = twoFactorHandler(state);
    const router = renderAt('/login?redirect=%2Fsystem%2Fstatus');
    await passwordStep();

    const code = screen.getByLabelText('Authentication code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(screen.queryByLabelText('Password')).toBeNull();

    fireEvent.change(code, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code is not right/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/system/status'));
    expect(calls.filter((c) => c.url === '/api/v1/auth/login/2fa').map((c) => c.body)).toEqual([
      { challenge: 'chal-1', code: '000000' },
      { challenge: 'chal-1', code: '123456' },
    ]);
  });

  it('accepts a recovery code instead', async () => {
    const state = { authed: false };
    handler = twoFactorHandler(state);
    const router = renderAt('/login?redirect=%2Fsystem%2Fstatus');
    await passwordStep();

    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'abcd-efgh-ijkl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/system/status'));
    expect(calls.find((c) => c.url === '/api/v1/auth/login/2fa')?.body).toMatchObject({ challenge: 'chal-1', recoveryCode: 'abcd-efgh-ijkl' });
  });

  it('goes back to the password form when the challenge expired', async () => {
    const state = { authed: false };
    const base = twoFactorHandler(state);
    handler = (url, init) =>
      url === '/api/v1/auth/login/2fa' ? { status: 401, body: { error: 'expired', code: 'CHALLENGE_EXPIRED' } } : base(url, init);
    renderAt('/login');
    await passwordStep();
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/took too long/)).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });
});
