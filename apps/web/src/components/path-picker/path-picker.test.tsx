import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileSystemListing } from '@arclight/shared';
import { PathPickerDialog } from './path-picker.js';
import { breadcrumbs, isValidFolderName } from './path-utils.js';

describe('breadcrumbs', () => {
  it('splits Windows paths under the drive list', () => {
    expect(breadcrumbs('C:\\Media\\TV')).toEqual([
      { label: 'Computer', path: '' },
      { label: 'C:', path: 'C:\\' },
      { label: 'Media', path: 'C:\\Media' },
      { label: 'TV', path: 'C:\\Media\\TV' },
    ]);
    expect(breadcrumbs('d:\\')).toEqual([
      { label: 'Computer', path: '' },
      { label: 'D:', path: 'D:\\' },
    ]);
  });

  it('splits POSIX paths under /', () => {
    expect(breadcrumbs('/data/media/')).toEqual([
      { label: '/', path: '/' },
      { label: 'data', path: '/data' },
      { label: 'media', path: '/data/media' },
    ]);
    expect(breadcrumbs('')).toEqual([{ label: 'Computer', path: '' }]);
  });

  it('handles UNC shares and validates folder names', () => {
    expect(breadcrumbs('\\\\nas\\media\\tv').map((c) => c.label)).toEqual(['Computer', '\\\\nas\\media', 'tv']);
    expect(isValidFolderName('Season 01')).toBe(true);
    expect(isValidFolderName('..')).toBe(false);
    expect(isValidFolderName('a/b')).toBe(false);
    expect(isValidFolderName('what?')).toBe(false);
  });
});

const listings: Record<string, FileSystemListing> = {
  '': {
    path: '',
    parent: null,
    directories: [
      { name: 'C:', path: 'C:\\', type: 'drive' },
      { name: 'D:', path: 'D:\\', type: 'drive' },
    ],
    files: [],
  },
  'D:\\': {
    path: 'D:\\',
    parent: '',
    directories: [{ name: 'Media', path: 'D:\\Media', type: 'directory' }],
    files: [{ name: 'notes.txt', path: 'D:\\notes.txt', type: 'file', sizeBytes: 2048 }],
  },
  'D:\\Media': { path: 'D:\\Media', parent: 'D:\\', directories: [], files: [] },
  'D:\\New': { path: 'D:\\New', parent: 'D:\\', directories: [], files: [] },
};

let calls: Array<{ url: string; method: string; body: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const u = new URL(url, 'http://x');
      if (u.pathname === '/api/v1/filesystem/mkdir') {
        return new Response(JSON.stringify({ name: 'New', path: 'D:\\New', type: 'directory' }), { status: 201 });
      }
      if (u.pathname === '/api/v1/filesystem') {
        const listing = listings[u.searchParams.get('path') ?? ''];
        return listing ? new Response(JSON.stringify(listing), { status: 200 }) : new Response(JSON.stringify({ error: 'Cannot read' }), { status: 404 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPicker(props: Partial<Parameters<typeof PathPickerDialog>[0]> = {}) {
  const onSelect = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PathPickerDialog open onClose={() => {}} onSelect={onSelect} {...props} />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe('PathPickerDialog', () => {
  it('starts at the drive list and cannot select it', async () => {
    renderPicker();
    expect(await screen.findByRole('button', { name: /D:/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'New folder' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('navigates into folders, shows files when asked and selects the current folder', async () => {
    const { onSelect } = renderPicker({ includeFiles: true });
    fireEvent.click(await screen.findByRole('button', { name: /D:/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Media/ }));
    await screen.findByText('Empty folder');
    expect(screen.getByRole('navigation', { name: 'Breadcrumbs' }).textContent).toContain('Media');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith('D:\\Media');
    // files were requested and rendered (disabled) on D:\
    expect(calls.some((c) => c.url.includes('includeFiles=true'))).toBe(true);
  });

  it('creates a folder and opens it', async () => {
    renderPicker({ initialPath: 'D:\\' });
    await screen.findByRole('button', { name: /Media/ });
    expect(screen.queryByText('notes.txt')).toBeNull(); // files hidden unless asked for
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ parent: 'D:\\', name: 'New' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Folder path' }) as HTMLInputElement).value).toBe('D:\\New'));
  });

  it('shows the error and a way back when the start path cannot be read', async () => {
    renderPicker({ initialPath: 'Z:\\gone' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to Computer/ }));
    expect(await screen.findByRole('button', { name: /C:/ })).toBeTruthy();
  });
});
