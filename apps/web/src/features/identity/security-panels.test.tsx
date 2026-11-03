import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, renderAt, stubApi, user } from '../requests/test-utils.js';
import { groupSecret, recoveryCodesText } from './security-panels.js';

afterEach(() => vi.unstubAllGlobals());

const off = { totp: false, recoveryCodesLeft: 0, passkeys: 0, setupRequired: false };
const on = { totp: true, totpEnabledAt: '2026-11-01T10:00:00.000Z', recoveryCodesLeft: 10, passkeys: 0, setupRequired: false };
const codes = ['aaaa-bbbb-cccc', 'dddd-eeee-ffff', 'gggg-hhhh-iiii'];

function profileRoutes(over: Record<string, unknown> = {}) {
  return {
    ...authRoutes(user()),
    '/api/v1/user/me/passkeys': [],
    '/api/v1/user/me/identities': [],
    '/api/v1/user/me/apikeys': [],
    ...over,
  };
}

describe('security helpers', () => {
  it('groups the secret and writes the codes file', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXPJBSW')).toBe('JBSW Y3DP EHPK 3PXP JBSW');
    const text = recoveryCodesText(codes, new Date('2026-11-02T10:00:00.000Z'));
    for (const c of codes) expect(text).toContain(c);
  });
});

describe('profile: two-factor', () => {
  it('sets up the authenticator app: QR and key, confirm code, then the recovery codes once', async () => {
    let enabled = false;
    const calls = stubApi(profileRoutes(), (url, method, body) => {
      if (url === '/api/v1/user/me/2fa' && method === 'GET') return { body: enabled ? on : off };
      if (url === '/api/v1/user/me/2fa/totp/setup' && method === 'POST')
        return { body: { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Arclight:admin?secret=JBSWY3DPEHPK3PXP&issuer=Arclight' } };
      if (url === '/api/v1/user/me/2fa/totp/enable' && method === 'POST') {
        if ((body as { code: string }).code !== '123456') return { status: 401, body: { error: 'invalid code', code: 'INVALID_CODE' } };
        enabled = true;
        return { body: { codes } };
      }
      return undefined;
    });
    renderAt('/profile');
    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));

    const dialog = await screen.findByRole('dialog', { name: 'Set up an authenticator app' });
    expect(within(dialog).getByTestId('totp-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect(within(dialog).getByRole('img', { name: 'QR code for your authenticator app' })).toBeTruthy();

    // Not six digits: no request.
    fireEvent.change(within(dialog).getByLabelText('Code from the app'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByText('Enter the 6-digit code.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/user/me/2fa/totp/enable')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));

    const codesDialog = await screen.findByRole('dialog', { name: 'Recovery codes' });
    for (const c of codes) expect(within(codesDialog).getByText(c)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/user/me/2fa/totp/enable')?.body).toEqual({ code: '123456' });

    fireEvent.click(within(codesDialog).getByRole('button', { name: 'I saved them' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recovery codes' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy();
  });
});

describe('profile: API keys', () => {
  it('creates a key with a scope and expiry and shows it once', async () => {
    const created = {
      id: 7,
      name: 'Home dashboard',
      scope: 'requests',
      prefix: 'alu_ab12cd',
      createdAt: '2026-11-02T10:00:00.000Z',
      expiresAt: '2027-01-31T10:00:00.000Z',
      key: 'alu_ab12cd_example-secret-value',
    };
    let list: unknown[] = [];
    const calls = stubApi(profileRoutes({ '/api/v1/user/me/2fa': off }), (url, method) => {
      if (url === '/api/v1/user/me/apikeys' && method === 'GET') return { body: list };
      if (url === '/api/v1/user/me/apikeys' && method === 'POST') {
        const { key: _key, ...rest } = created;
        list = [rest];
        return { status: 201, body: created };
      }
      return undefined;
    });
    renderAt('/profile');
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Give the key a name.')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Home dashboard' } });
    const scope = within(dialog).getByLabelText('Scope');
    // A non-admin cannot pick the admin scope.
    expect(within(scope).queryByRole('option', { name: 'Admin' })).toBeNull();
    fireEvent.change(scope, { target: { value: 'requests' } });
    fireEvent.change(within(dialog).getByLabelText('Expires'), { target: { value: '90' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const shown = await screen.findByTestId('new-api-key');
    expect(shown.textContent).toContain('alu_ab12cd_example-secret-value');
    expect(calls.find((c) => c.url === '/api/v1/user/me/apikeys' && c.method === 'POST')?.body).toEqual({
      name: 'Home dashboard',
      scope: 'requests',
      expiresInDays: 90,
    });
    // The list shows only the prefix.
    expect(await screen.findByText('alu_ab12cd…')).toBeTruthy();
  });
});

describe('profile: confirming the password for an older session', () => {
  const created = { id: 8, name: 'Script', scope: 'read', prefix: 'alu_cd34ef', createdAt: '2026-11-02T10:00:00.000Z', key: 'alu_cd34ef_example-secret-value' };

  it('asks for the current password on REAUTH_REQUIRED and repeats the call with it', async () => {
    const calls = stubApi(profileRoutes({ '/api/v1/user/me/2fa': off }), (url, method, body) => {
      if (url !== '/api/v1/user/me/apikeys' || method !== 'POST') return undefined;
      const pw = (body as { currentPassword?: string }).currentPassword;
      if (pw === undefined) return { status: 401, body: { error: 'confirm your current password to continue', code: 'REAUTH_REQUIRED' } };
      if (pw !== 'right-one') return { status: 401, body: { error: 'current password is incorrect', code: 'INVALID_CREDENTIALS' } };
      return { status: 201, body: created };
    });
    renderAt('/profile');
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const form = await screen.findByRole('dialog', { name: 'Create API key' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Script' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create key' }));

    const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
    const field = within(confirm).getByLabelText('Current password') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await within(confirm).findByText('That password is not right.')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'right-one' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByTestId('new-api-key')).textContent).toContain('alu_cd34ef_example-secret-value');
    expect(screen.queryByRole('dialog', { name: 'Confirm your password' })).toBeNull();
    const posts = calls.filter((c) => c.url === '/api/v1/user/me/apikeys' && c.method === 'POST').map((c) => c.body);
    expect(posts).toEqual([
      { name: 'Script', scope: 'read' },
      { name: 'Script', scope: 'read', currentPassword: 'wrong' },
      { name: 'Script', scope: 'read', currentPassword: 'right-one' },
    ]);
    // Still signed in: the 401s were form errors, not a lost session.
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('tells an account without a password to sign in again', async () => {
    stubApi({ ...profileRoutes({ '/api/v1/user/me/2fa': off }), ...authRoutes(user({ localPassword: false })) }, (url, method) =>
      url === '/api/v1/user/me/2fa/totp/setup' && method === 'POST'
        ? { status: 401, body: { error: 'this account has no password: sign out and sign in again, then try again within 10 minutes', code: 'REAUTH_REQUIRED' } }
        : undefined,
    );
    renderAt('/profile');
    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
    expect(await screen.findByText('To add this, sign out and sign in again, then try again within 10 minutes.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Confirm your password' })).toBeNull();
  });
});
