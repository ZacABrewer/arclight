import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  AdditionalLanguageRequest,
  AdditionalLanguageResult,
  ItemLanguages,
  type AdditionalLanguageItemResult,
  type AdditionalLanguageOutcome,
  type AdditionalLanguageTarget,
} from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi, type FakeApi } from '../../test/route-harness.js';
import { AddAdditionalDialog } from './add-additional-dialog.js';
import { ItemLanguageChips, recordsForChip } from './item-language-chips.js';
import { EMPTY_AUDIO, EMPTY_SUBTITLE, buildRequest, subtitleKeyLabel, versionTagError } from './model.js';

configure({ asyncUtilTimeout: 4000 });
afterEach(() => vi.unstubAllGlobals());

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
];

function item(outcome: AdditionalLanguageOutcome, extra: Partial<AdditionalLanguageItemResult> = {}): AdditionalLanguageItemResult {
  return {
    key: 'movie:1',
    mediaType: 'movie',
    movieId: 1,
    seriesId: null,
    seasonNumber: null,
    episodeIds: [],
    title: 'Dune (2021)',
    outcome,
    message: 'English message from the server',
    files: 1,
    currentAudio: ['en'],
    unanalysedFiles: 0,
    currentSubtitles: ['en'],
    requiredAudio: [],
    versionTag: null,
    subtitles: [],
    ...extra,
  };
}

function result(kind: 'audio' | 'subtitle', applied: boolean, items: AdditionalLanguageItemResult[], whisperAvailable = false) {
  return AdditionalLanguageResult.parse({ kind, applied, items, whisperAvailable, jobId: applied ? 7 : null, message: '' });
}

function setup(routes: Record<string, unknown>): FakeApi {
  return stubApi({ '/api/v1/subtitle/languages': LANGUAGES, '/api/v1/qualityprofile': [], ...routes });
}

function renderDialog(targets: AdditionalLanguageTarget[] = [{ movieId: 1 }], initialTab?: 'audio' | 'subtitle') {
  const toasts = createToastStore();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <AddAdditionalDialog open targets={targets} title="Dune (2021)" onClose={onClose} initialTab={initialTab} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Add additional language · Dune (2021)' }) };
}

async function pickLanguage(dialog: HTMLElement, label: string, query: string, option: RegExp) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value: query } });
  fireEvent.click(await within(dialog).findByRole('option', { name: option }));
}

const posts = (api: FakeApi, path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

describe('additional language model', () => {
  const targets = [{ movieId: 1 }];
  it('builds nothing until a language is picked', () => {
    expect(buildRequest('audio', targets, EMPTY_AUDIO, EMPTY_SUBTITLE)).toBeNull();
    expect(buildRequest('subtitle', targets, EMPTY_AUDIO, EMPTY_SUBTITLE)).toBeNull();
    expect(buildRequest('audio', [], { ...EMPTY_AUDIO, language: 'es' }, EMPTY_SUBTITLE)).toBeNull();
  });

  it('builds contract-valid audio and subtitle requests', () => {
    const replace = buildRequest('audio', targets, { ...EMPTY_AUDIO, language: 'es', versionTag: 'ignored' }, EMPTY_SUBTITLE);
    expect(replace).toEqual({ kind: 'audio', targets, language: 'es', mode: 'replace' });
    const version = buildRequest('audio', targets, { language: 'es', mode: 'version', versionTag: ' Castellano ', qualityProfileId: '4' }, EMPTY_SUBTITLE);
    expect(version).toEqual({ kind: 'audio', targets, language: 'es', mode: 'version', versionTag: 'Castellano', qualityProfileId: 4 });
    const subs = buildRequest('subtitle', targets, EMPTY_AUDIO, { languages: [{ code: 'fr', forced: 'also', hi: 'never' }], searchNow: true, useWhisper: true });
    expect(subs).toEqual({ kind: 'subtitle', targets, languages: [{ code: 'fr', forced: 'also', hi: 'never' }], searchNow: true, useWhisper: true });
    for (const body of [replace, version, subs]) expect(AdditionalLanguageRequest.safeParse(body).success).toBe(true);
  });

  it('labels subtitle keys and rejects path characters in version names', () => {
    const name = (c: string) => ({ en: 'English' })[c] ?? c;
    expect(subtitleKeyLabel('en', name)).toBe('English');
    expect(subtitleKeyLabel('en:forced', name)).toBe('English (forced)');
    expect(subtitleKeyLabel('en:hi', name)).toBe('English (HI)');
    expect(versionTagError('Spanish')).toBeNull();
    expect(versionTagError('a/b')).toMatch(/cannot contain/);
  });
});

describe('add additional dialog', () => {
  it('previews an audio language, switches to a separate version and confirms', async () => {
    const api = setup({
      'POST /api/v1/additional-language/preview': (init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { mode: string };
        return body.mode === 'version'
          ? result('audio', false, [item('willAddVersion', { versionTag: 'Spanish' })])
          : result('audio', false, [item('willSearch', { requiredAudio: ['en', 'es'] })]);
      },
      'POST /api/v1/additional-language': result('audio', true, [item('versionAdded', { versionTag: 'Spanish' })]),
    });
    const { dialog } = renderDialog();
    expect(within(dialog).getByText('Pick a language to see what happens to each item.')).toBeTruthy();
    expect(within(dialog).getByText(/never merged into one file/)).toBeTruthy();
    await pickLanguage(dialog, 'Find an audio language', 'span', /Spanish/);

    expect(await within(dialog).findByText('Will search')).toBeTruthy();
    expect(within(dialog).getByText('Needs English + Spanish')).toBeTruthy();
    expect(posts(api, '/api/v1/additional-language/preview')[0]).toEqual({ kind: 'audio', targets: [{ movieId: 1 }], language: 'es', mode: 'replace' });

    fireEvent.click(within(dialog).getByRole('radio', { name: /Add it as a separate version/ }));
    expect(await within(dialog).findByText('Will add a version')).toBeTruthy();
    expect(within(dialog).getByText('Version: Spanish')).toBeTruthy();
    expect(posts(api, '/api/v1/additional-language/preview').at(-1)).toMatchObject({ mode: 'version' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Version added')).toBeTruthy();
    expect(posts(api, '/api/v1/additional-language')[0]).toEqual({ kind: 'audio', targets: [{ movieId: 1 }], language: 'es', mode: 'version' });
    expect(within(dialog).getByText(/runs as a task/)).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).some((b) => b.classList.contains('al-btn--primary'))).toBe(true);
  });

  it('blocks a version name with path characters', async () => {
    setup({ 'POST /api/v1/additional-language/preview': result('audio', false, [item('willAddVersion')]) });
    const { dialog } = renderDialog();
    await pickLanguage(dialog, 'Find an audio language', 'span', /Spanish/);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Add it as a separate version/ }));
    fireEvent.change(within(dialog).getByLabelText('Version name'), { target: { value: 'ES/LAT' } });
    expect(within(dialog).getByText(/cannot contain/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps Whisper off when it is not set up and shows per-item subtitle results', async () => {
    const api = setup({
      'POST /api/v1/additional-language/preview': result('subtitle', false, [item('willSearch')], false),
      'POST /api/v1/additional-language': result('subtitle', true, [
        item('notFound', {
          subtitles: [
            { language: 'fr', forced: false, hi: false, outcome: 'notFound' },
            { language: 'fr', forced: true, hi: false, outcome: 'found' },
          ],
        }),
      ]),
    });
    const { dialog } = renderDialog([{ seriesId: 3, seasonNumber: 1 }], 'subtitle');
    expect(within(dialog).getByText(/shared language profile does not change/)).toBeTruthy();
    await pickLanguage(dialog, 'Find a subtitle language', 'fre', /French/);
    fireEvent.change(within(dialog).getByLabelText('Forced for French'), { target: { value: 'also' } });
    expect(await within(dialog).findByText(/Whisper is not set up/)).toBeTruthy();
    expect((within(dialog).getByRole('checkbox', { name: /Generate with Whisper/ }) as HTMLInputElement).disabled).toBe(true);
    await waitFor(() =>
      expect(posts(api, '/api/v1/additional-language/preview').at(-1)).toEqual({
        kind: 'subtitle',
        targets: [{ seriesId: 3, seasonNumber: 1 }],
        languages: [{ code: 'fr', forced: 'also', hi: 'also' }],
        searchNow: true,
        useWhisper: false,
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Will keep searching on the normal schedule.')).toBeTruthy();
    expect(within(dialog).getByText('French (forced): Found')).toBeTruthy();
    expect(within(dialog).queryByText('English message from the server')).toBeNull();
  });

  it('enables Whisper when the server says it is available', async () => {
    setup({ 'POST /api/v1/additional-language/preview': result('subtitle', false, [item('willSearch')], true) });
    const { dialog } = renderDialog([{ movieId: 1 }], 'subtitle');
    await pickLanguage(dialog, 'Find a subtitle language', 'fre', /French/);
    const box = within(dialog).getByRole('checkbox', { name: /Generate with Whisper/ }) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });
});

describe('item language chips', () => {
  const languages = ItemLanguages.parse({
    audio: [
      { language: 'en', present: true, added: false },
      { language: 'es', present: false, added: true },
    ],
    subtitles: [{ language: 'fr:forced', present: true, added: true }],
    records: [
      {
        id: 5,
        kind: 'audio',
        mediaType: 'movie',
        movieId: 1,
        seriesId: null,
        seasonNumber: null,
        episodeId: null,
        language: 'es',
        forced: 'never',
        hi: 'also',
        mode: 'replace',
        versionTag: null,
        status: 'notFound',
        message: '',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 6,
        kind: 'subtitle',
        mediaType: 'movie',
        movieId: 1,
        seriesId: null,
        seasonNumber: null,
        episodeId: null,
        language: 'fr',
        forced: 'only',
        hi: 'also',
        mode: null,
        versionTag: null,
        status: 'found',
        message: '',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });

  it('matches saved records to chips', () => {
    expect(recordsForChip(languages.records, 'audio', { language: 'es', present: false, added: true }).map((r) => r.id)).toEqual([5]);
    expect(recordsForChip(languages.records, 'subtitle', { language: 'fr:forced', present: true, added: true }).map((r) => r.id)).toEqual([6]);
    expect(recordsForChip(languages.records, 'subtitle', { language: 'fr', present: true, added: true })).toEqual([]);
  });

  it('marks added languages and removes one after confirming', async () => {
    const api = setup({ '/api/v1/additional-language': languages, 'DELETE /api/v1/additional-language/5': null });
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <ItemLanguageChips query={{ movieId: 1 }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const audio = await screen.findByRole('group', { name: 'Audio' });
    await waitFor(() => expect(within(audio).getByText('Spanish · wanted')).toBeTruthy());
    expect(within(audio).getByText('English')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Subtitles' })).getByText('French (forced) · added')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/additional-language')).toBeTruthy();

    fireEvent.click(within(audio).getByRole('button', { name: 'Stop wanting Spanish' }));
    const confirm = await screen.findByRole('dialog', { name: 'Stop wanting Spanish?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/additional-language/5')).toBe(true));
  });
});
