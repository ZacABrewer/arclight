import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { stubApi } from '../../../test/route-harness.js';
import { hasLimit, UserProfilesEditor } from './user-profiles.js';

afterEach(() => vi.unstubAllGlobals());

const settings = {
  subtitleLanguage: null, subtitleSize: 'medium', audioLanguage: null, autoplayNext: true, skipIntros: false, heroRotate: true,
  reduceMotion: false, showMusic: true, showAudiobooks: true, focusStyle: 'white-frame', theme: null,
};
const base = { settings, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const owner = { ...base, id: 1, name: 'Amy', color: '#7c6cf0', initial: 'A', isOwner: true, hasPin: false, contentRestrictions: null, sortOrder: 0 };
const kids = {
  ...base, id: 2, name: 'Kids', color: '#3aa37a', initial: 'K', isOwner: false, hasPin: true, sortOrder: 1,
  contentRestrictions: { maxCertification: { movie: 'PG', tv: 'TV-PG' }, hideAdultContent: true },
};

function renderEditor(routes: Record<string, unknown>) {
  const api = stubApi(routes);
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <UserProfilesEditor userId={7} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return api;
}

const list = (profiles: unknown[], max = 12) => ({ profiles, activeProfileId: 1, canManage: true, max });

describe('Settings → Users → Profiles', () => {
  it('lists profiles with Owner, Kids and PIN badges; the owner cannot be deleted', async () => {
    renderEditor({ '/api/v1/users/7/profiles': list([owner, kids]) });
    const ul = await screen.findByRole('list', { name: 'Profiles' });
    const rows = within(ul).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Owner')).toBeTruthy();
    expect(within(rows[0]!).queryByRole('button', { name: 'Delete Amy' })).toBeNull();
    expect(within(rows[1]!).getByText('Kids', { selector: '.al-chip' })).toBeTruthy();
    expect(within(rows[1]!).getByText('PIN')).toBeTruthy();
    expect(screen.getByText('2 of 12 profiles')).toBeTruthy();
  });

  it('adds a profile with a colour, a limit and a PIN', async () => {
    const api = renderEditor({ '/api/v1/users/7/profiles': list([owner]), 'POST /api/v1/users/7/profiles': kids });
    fireEvent.click(await screen.findByRole('button', { name: 'Add profile' }));
    const form = screen.getByRole('form', { name: 'New profile' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Kids' } });
    fireEvent.click(within(form).getByRole('radio', { name: 'Colour 3' }));
    fireEvent.change(within(form).getByLabelText('Highest movie rating'), { target: { value: 'PG' } });
    const pin = within(form).getByLabelText('PIN');
    fireEvent.change(pin, { target: { value: '12' } });
    expect(screen.getByText('Enter exactly four digits.')).toBeTruthy();
    fireEvent.change(pin, { target: { value: '12a34' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      name: 'Kids',
      color: '#3aa37a',
      contentRestrictions: { maxCertification: { movie: 'PG', tv: null }, hideAdultContent: false },
      pin: '1234',
    });
  });

  it('the owner form has no limit control; an emptied limit is sent as null; Remove PIN sends pin null', async () => {
    const api = renderEditor({
      '/api/v1/users/7/profiles': list([owner, kids]),
      'PATCH /api/v1/users/7/profiles/2': kids,
      'PATCH /api/v1/users/7/profiles/1': owner,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Amy' }));
    let form = screen.getByRole('form', { name: 'Edit Amy' });
    expect(within(form).queryByLabelText('Highest movie rating')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Kids' }));
    form = screen.getByRole('form', { name: 'Edit Kids' });
    fireEvent.change(within(form).getByLabelText('Highest movie rating'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Highest series rating'), { target: { value: '' } });
    fireEvent.click(within(form).getByLabelText('Hide adult titles'));
    fireEvent.click(within(form).getByLabelText('Remove the PIN'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe('/api/v1/users/7/profiles/2');
    expect(patch.body).toMatchObject({ contentRestrictions: null, pin: null });
  });

  it('deletes after an inline confirm and disables Add at the maximum', async () => {
    const api = renderEditor({ '/api/v1/users/7/profiles': list([owner, kids], 2), 'DELETE /api/v1/users/7/profiles/2': null });
    expect(((await screen.findByRole('button', { name: 'Add profile' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This account has the most profiles allowed (2).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Kids' }));
    const confirm = screen.getByRole('group', { name: 'Delete Kids and its progress?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/users/7/profiles/2')).toBe(true));
  });

  it('shows a translated message for limit-reached', async () => {
    renderEditor({
      '/api/v1/users/7/profiles': list([owner]),
      'POST /api/v1/users/7/profiles': () => new Response(JSON.stringify({ error: 'limit-reached' }), { status: 409 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add profile' }));
    const form = screen.getByRole('form', { name: 'New profile' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Extra' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add profile' }));
    expect(await screen.findByText('This account already has the most profiles allowed.')).toBeTruthy();
  });

  it('hasLimit treats an all-empty limit as none', () => {
    expect(hasLimit(null)).toBe(false);
    expect(hasLimit({ maxCertification: { movie: null, tv: null }, hideAdultContent: false })).toBe(false);
    expect(hasLimit({ maxCertification: { movie: null, tv: null }, hideAdultContent: true })).toBe(true);
  });
});
