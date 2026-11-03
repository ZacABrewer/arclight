import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppServicesContext } from '../app/context';
import type { AppServices } from '../app/services';
import { memoryStore } from '../core/kv';
import { transportPolicy } from '../core/transport';

// A pairing link or QR code (arclight://pair → /sign-in?server=…&code=…) must show the server
// and wait for the user before it pairs or switches accounts.

const nav = vi.hoisted(() => ({ search: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav.navigate,
  useSearch: () => nav.search,
}));

const signIn = vi.hoisted(() => ({ pair: vi.fn() }));
vi.mock('../core/sign-in', () => ({
  signInWithPairCode: signIn.pair,
  signInWithPassword: vi.fn(),
}));

const { SignInPage } = await import('./onboarding');

function renderSignIn(search: Record<string, unknown>) {
  nav.search = search;
  const switchAccount = vi.fn(async () => undefined);
  const services = { accounts: { list: () => [], active: () => null }, switchAccount } as unknown as AppServices;
  render(
    <AppServicesContext.Provider value={services}>
      <SignInPage />
    </AppServicesContext.Provider>,
  );
  return { switchAccount };
}

beforeEach(async () => {
  await transportPolicy.load(memoryStore());
  nav.navigate.mockReset();
  signIn.pair.mockReset();
  signIn.pair.mockResolvedValue({ ok: true, account: { id: 'a_1' } });
  // http addresses look for an https twin first; none answers here.
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
});

afterEach(() => vi.unstubAllGlobals());

describe('pairing link', () => {
  it('shows the server and pairs only after Pair is pressed', async () => {
    const { switchAccount } = renderSignIn({ server: 'https://music.example.com', code: 'ABCD-EFGH' });
    expect(await screen.findByText('music.example.com', { selector: '.app-server-check__host' })).toBeTruthy();
    expect(signIn.pair).not.toHaveBeenCalled();
    expect(switchAccount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('a_1'));
    expect(signIn.pair).toHaveBeenCalledWith(expect.anything(), 'https://music.example.com', 'ABCD-EFGH');
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/player', replace: true });
  });

  it('does nothing when cancelled', async () => {
    const { switchAccount } = renderSignIn({ server: 'https://music.example.com', code: 'ABCD-EFGH' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/welcome' });
    expect(signIn.pair).not.toHaveBeenCalled();
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it('asks for the host name before pairing over plain http on the internet', async () => {
    const { switchAccount } = renderSignIn({ server: 'http://music.example.com:7878', code: 'ABCD-EFGH' });
    const pairButton = await screen.findByRole('button', { name: 'Pair' });
    expect((pairButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pairButton);
    expect(signIn.pair).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'music.example.com' } });
    expect((pairButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pairButton);
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('a_1'));
    expect(transportPolicy.allowsCredentials('http://music.example.com:7878')).toBe(true);
  });

  it('shows the home-network notice once for plain http on the LAN', async () => {
    renderSignIn({ server: 'http://192.168.1.20:7878', code: 'ABCD-EFGH' });
    expect(await screen.findByText(/not encrypted/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(signIn.pair).toHaveBeenCalledTimes(1));
    expect(transportPolicy.need('http://192.168.1.20:7878')).toBe('none');
  });
});
