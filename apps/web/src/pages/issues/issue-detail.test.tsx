import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Issue } from '@media-tron/shared';
import { authRoutes, renderAt, stubApi, user } from '../../features/requests/test-utils.js';

afterEach(() => vi.unstubAllGlobals());

const amy = { id: 2, username: 'amy' };
const issue = (comments: Issue['comments']): Issue => ({
  id: 4,
  type: 'audio',
  status: 'open',
  mediaType: 'series',
  mediaTmdbId: 1399,
  mediaTitle: 'Dragons',
  problemSeason: 2,
  problemEpisode: 3,
  createdBy: amy,
  modifiedBy: null,
  comments,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
});
const comment = (id: number, message: string) => ({ id, user: amy, message, createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z' });

describe('issue detail', () => {
  it('posts a comment, edits own comment and resolves', async () => {
    let current = issue([comment(1, 'Audio is out of sync')]);
    const calls = stubApi({ ...authRoutes(user()) }, (url, method, body) => {
      if (url === '/api/v1/issue/4' && method === 'GET') return { body: current };
      if (url === '/api/v1/issue/4/comment' && method === 'POST') {
        current = issue([...current.comments, comment(2, (body as { message: string }).message)]);
        return { body: current };
      }
      if (url === '/api/v1/issuecomment/1' && method === 'PUT') {
        current = issue([comment(1, (body as { message: string }).message), ...current.comments.slice(1)]);
        return { body: current };
      }
      if (url === '/api/v1/issue/4/status' && method === 'POST') {
        current = { ...current, status: 'resolved' };
        return { body: current };
      }
      return undefined;
    });
    renderAt('/issues/4');
    expect(await screen.findByText('Audio is out of sync')).toBeTruthy();
    expect(screen.getByText('S2E3')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Still broken in E4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Still broken in E4')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/issue/4/comment')?.body).toEqual({ message: 'Still broken in E4' });
    expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).value).toBe('');

    const first = screen.getAllByRole('listitem', { name: 'Comment by amy' })[0]!;
    fireEvent.click(within(first).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit comment'), { target: { value: 'Audio drifts after 10 minutes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Audio drifts after 10 minutes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/issue/4/status')?.body).toEqual({ status: 'resolved' });
  });
});
