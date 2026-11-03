import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SECRET_MASK } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { navFor, sectionTabs } from '../../nav.js';
import { episodeQuery } from './podcast-episodes.js';
import { filterPodcasts } from './podcast-index.js';
import { plainText } from './podcast-details.js';
import { podcastTriggerLabel, supportedPodcastTriggers } from '../settings/notifications/notifications-page.js';
import { feedProxies, toPodcastSettingsBody, toPodcastSettingsDraft } from '../settings/podcasts/podcasts-settings-page.js';
import { POD_FEATURES_OFF, POD_FEATURES_ON, episodePage, makeEpisode, makePodcast, makeSuggestion, podSettings } from './podcast-fixtures.js';

// Podcast pages: library grid, details, all episodes, Add podcast (search / RSS / OPML),
// suggestions, Settings → Podcasts and the portal suggest page. Every name here is invented.

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const tide = makePodcast({ id: 1, title: 'Tide Pool Hour' });
const quiet = makePodcast({
  id: 2,
  title: 'Quiet Orchard',
  author: 'Fen Radio',
  monitored: false,
  status: 'error',
  lastError: 'HTTP 503',
  statistics: { episodeCount: 3, downloadedCount: 0, playedCount: 0, wantedCount: 2, sizeOnDisk: 0, lastEpisodeAt: null },
});

function podApi(extra: Record<string, unknown> = {}, features: Record<string, boolean> = POD_FEATURES_ON) {
  return stubApi({
    '/api/v1/settings/features': features,
    '/api/v1/tag': [],
    '/api/v1/settings/podcasts': podSettings(),
    ...extra,
  });
}

describe('podcast helpers', () => {
  it('filters by words and status, sorted by title', () => {
    expect(filterPodcasts([tide, quiet], '', 'all').map((p) => p.id)).toEqual([2, 1]);
    expect(filterPodcasts([tide, quiet], 'fen', 'all').map((p) => p.id)).toEqual([2]);
    expect(filterPodcasts([tide, quiet], '', 'error').map((p) => p.id)).toEqual([2]);
    expect(filterPodcasts([tide, quiet], '', 'active').map((p) => p.id)).toEqual([1]);
    expect(filterPodcasts([tide, quiet], '', 'wanted').map((p) => p.id)).toEqual([2]);
    expect(filterPodcasts([tide, quiet], '', 'unmonitored').map((p) => p.id)).toEqual([2]);
  });

  it('builds the episode query from the filters', () => {
    expect(episodeQuery({ status: '', played: 'all', term: ' ', sortKey: 'publishedAt', page: 2 })).toEqual({ page: 2, pageSize: 50, sortKey: 'publishedAt', sortDirection: 'desc' });
    expect(episodeQuery({ status: 'wanted', played: 'unplayed', term: 'kelp', sortKey: 'title', page: 1 })).toEqual({
      page: 1,
      pageSize: 50,
      sortKey: 'title',
      sortDirection: 'asc',
      status: 'wanted',
      played: false,
      term: 'kelp',
    });
  });

  it('shows feed HTML as plain text', () => {
    expect(plainText('<p>One &amp; two</p><script>x()</script><br/>Three')).toBe('One & two\nx()\nThree');
  });

  it('turns the settings draft into a body, keeping the secret mask and checking ranges', () => {
    const draft = toPodcastSettingsDraft(podSettings({ podcastIndexKey: 'abc', podcastIndexSecret: SECRET_MASK }));
    const ok = toPodcastSettingsBody(draft);
    expect(ok.ok && ok.body.podcastIndexSecret).toBe(SECRET_MASK);
    expect(ok.ok && ok.body.proxyId).toBeNull();
    const bad = toPodcastSettingsBody({ ...draft, refreshIntervalMinutes: '5' });
    expect(bad).toMatchObject({ ok: false, field: 'refreshIntervalMinutes' });
    expect(toPodcastSettingsBody({ ...draft, maxConcurrentDownloads: '9' })).toMatchObject({ ok: false, field: 'maxConcurrentDownloads' });
  });

  it('offers only http and socks5 proxies for feeds', () => {
    const proxy = (id: number, type: 'http' | 'socks5' | 'flaresolverr') => ({ id, name: `p${id}`, type, host: 'proxy.example.com', port: 8080, tags: [] });
    expect(feedProxies([proxy(1, 'http'), proxy(2, 'flaresolverr'), proxy(3, 'socks5')]).map((p) => p.id)).toEqual([1, 3]);
  });

  it('groups the podcast notification triggers the agent supports', () => {
    expect(supportedPodcastTriggers({ onGrab: true, onPodcastDownload: false })).toEqual(['onPodcastDownload']);
    expect(supportedPodcastTriggers({ onPodcastEpisodes: true, supportsOnPodcastDownload: true })).toEqual(['onPodcastEpisodes', 'onPodcastDownload']);
    expect(podcastTriggerLabel('onPodcastEpisodes')).toBe('New podcast episodes');
  });

  it('adds the Podcasts section to the library tabs only while the flag is on', () => {
    expect(sectionTabs('/library/tv', true, navFor(POD_FEATURES_OFF)).map((t) => t.to)).not.toContain('/podcasts');
    expect(sectionTabs('/library/tv', true, navFor(POD_FEATURES_ON)).map((t) => t.to)).toContain('/podcasts');
  });
});

describe('podcast pages', () => {
  it('answers 404 while the flag is off', async () => {
    podApi({ '/api/v1/podcast': [tide] }, POD_FEATURES_OFF);
    renderAt('/podcasts');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('lists podcasts as a grid with counts and filters them', async () => {
    const api = podApi({ '/api/v1/podcast': [tide, quiet], 'POST /api/v1/podcast/refresh': null });
    renderAt('/podcasts');
    const grid = await screen.findByTestId('podcast-grid');
    expect(within(grid).getByRole('link', { name: 'Tide Pool Hour' }).getAttribute('href')).toBe('/podcasts/1');
    expect(within(grid).getByText('12 episodes')).toBeTruthy();
    expect(within(grid).getByText('2 wanted')).toBeTruthy();
    expect(within(grid).getByText('Feed error')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter podcasts'), { target: { value: 'tide' } });
    await waitFor(() => expect(within(grid).queryByRole('link', { name: 'Quiet Orchard' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Export OPML' }).getAttribute('href')).toBe('/api/v1/podcast/opml?includePrivate=false');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/podcast/refresh')).toBe(true));
  });

  it('offers Jump back in, offline markers and a remembered list view', async () => {
    const api = podApi({
      '/api/v1/podcast': [tide, quiet],
      '/api/v1/podcast/episode': episodePage([makeEpisode({ id: 7, podcastId: 1, title: 'Kelp Forests', status: 'downloaded', durationSeconds: 1800 })]),
    });
    renderAt('/podcasts');
    const jump = await screen.findByTestId('jump-back-in');
    expect(within(jump).getByRole('link', { name: 'Kelp Forests, Tide Pool Hour' }).getAttribute('href')).toBe('/podcasts/1');
    const q = api.calls.find((c) => c.path === '/api/v1/podcast/episode');
    expect(q).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/podcast/episode'))!;
    expect(String(call[0])).toContain('status=downloaded');
    expect(String(call[0])).toContain('played=false');
    // Tide Pool Hour has files on disk, Quiet Orchard has none.
    const grid = screen.getByTestId('podcast-grid');
    expect(within(grid).getAllByTestId('offline-marker')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const list = await screen.findByTestId('podcast-list');
    expect(within(list).getByRole('link', { name: 'Quiet Orchard' }).getAttribute('href')).toBe('/podcasts/2');
    expect(within(list).getAllByText('Saved')).toHaveLength(1);
    expect(screen.queryByTestId('podcast-grid')).toBeNull();
    expect(localStorage.getItem('arclight.podcasts.view')).toBe('list');
  });

  it('shows the details header with the masked private feed, plain description and episodes', async () => {
    const priv = makePodcast({ id: 5, title: 'Members Cast', privateFeed: true, feedUrl: `https://example.com/feed?token=${SECRET_MASK}`, funding: [{ url: 'https://example.com/support', title: '' }] });
    const eps = [
      makeEpisode({ id: 51, podcastId: 5, title: 'Kelp Forests', status: 'downloaded', played: true, hasChapters: true, transcriptFiles: ['51.vtt'], sizeBytes: 30_000_000 }),
      makeEpisode({ id: 52, podcastId: 5, title: 'Sneak Peek', episodeType: 'trailer' }),
    ];
    const api = podApi({
      '/api/v1/podcast/5': priv,
      '/api/v1/podcast/episode': episodePage(eps),
      'POST /api/v1/podcast/episode/52/download': { ...eps[1], status: 'wanted' },
    });
    renderAt('/podcasts/5');
    expect(await screen.findByRole('heading', { name: 'Members Cast' })).toBeTruthy();
    expect(screen.getByTestId('private-feed')).toBeTruthy();
    expect(screen.getByTestId('feed-url').textContent).toContain(SECRET_MASK);
    expect(screen.getByText('Weekly talk about tide pools.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Support the show' }).getAttribute('href')).toBe('https://example.com/support');
    expect(await screen.findByText('Kelp Forests')).toBeTruthy();
    expect(screen.getAllByTestId('chapters-indicator').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('transcript-indicator').length).toBeGreaterThan(0);
    expect(screen.getByText('Trailer')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/podcast/episode')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download Sneak Peek' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/podcast/episode/52/download')).toBe(true));
  });

  it('renders feed links with a javascript: URL without an href', async () => {
    const evil = makePodcast({ id: 6, title: 'Poisoned Feed', link: 'javascript:alert(document.cookie)', funding: [{ url: ' javascript:alert(1)', title: 'Tip jar' }, { url: 'https://example.com/support', title: 'Real support' }] });
    podApi({ '/api/v1/podcast/6': evil, '/api/v1/podcast/episode': episodePage([]) });
    renderAt('/podcasts/6');
    expect(await screen.findByRole('heading', { name: 'Poisoned Feed' })).toBeTruthy();
    expect(screen.getByText('Website').closest('a')?.hasAttribute('href')).toBe(false);
    expect(screen.getByText('Tip jar').closest('a')?.hasAttribute('href')).toBe(false);
    expect(screen.getByRole('link', { name: 'Real support' }).getAttribute('href')).toBe('https://example.com/support');
  });

  it('shows the show header: kicker, author line, Following and the auto-download chip', async () => {
    const show = makePodcast({ id: 5, title: 'Members Cast' });
    const api = podApi({
      '/api/v1/podcast/5': show,
      '/api/v1/podcast/episode': episodePage([makeEpisode({ id: 51, podcastId: 5, title: 'Kelp Forests', season: 2, description: '<p>All about <i>kelp</i> &amp; otters.</p>', durationSeconds: 1800, sizeBytes: 30_000_000 })]),
      'PUT /api/v1/podcast/5': { ...show, monitored: false },
    });
    renderAt('/podcasts/5');
    expect(await screen.findByText('Podcast · Science')).toBeTruthy();
    expect(screen.getByText('Lantern Audio · 12 episodes')).toBeTruthy();
    // Episode rows: number, plain-text excerpt and the duration · size line.
    const rows = await screen.findByTestId('episode-list');
    expect(within(rows).getByText('S2 · #51')).toBeTruthy();
    expect(within(rows).getByText('All about kelp & otters.')).toBeTruthy();
    expect(within(rows).getByText(/^30m.*MB$/)).toBeTruthy();
    fireEvent.click(within(rows).getByLabelText('Select Kelp Forests'));
    expect(await screen.findByTestId('bulk-bar')).toBeTruthy();
    // Following is the monitored flag.
    const follow = screen.getByRole('button', { name: 'Following' });
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(follow);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/podcast/5')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ monitored: false });
    // The auto-download chip opens the settings dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Auto-download newest 3' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('edits a podcast without sending the unchanged masked feed URL', async () => {
    const priv = makePodcast({ id: 5, title: 'Members Cast', privateFeed: true, feedUrl: `https://example.com/feed?token=${SECRET_MASK}` });
    const api = podApi({ '/api/v1/podcast/5': priv, '/api/v1/podcast/episode': episodePage([]), 'PUT /api/v1/podcast/5': priv });
    renderAt('/podcasts/5');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/podcast/5')).toBe(true));
    const body = api.calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('feedUrl');
    expect(body).toMatchObject({ monitored: true, tags: [] });
  });

  it('unsubscribes, optionally deleting files', async () => {
    const api = podApi({ '/api/v1/podcast/1': tide, '/api/v1/podcast/episode': episodePage([]), 'DELETE /api/v1/podcast/1': null, '/api/v1/podcast': [] });
    renderAt('/podcasts/1');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/Also delete the files/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unsubscribe' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/podcast/1')).toBe(true));
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')!;
    expect(String(call[0])).toContain('deleteFiles=true');
  });

  it('lists every episode with filters and a bulk bar', async () => {
    const api = podApi({
      '/api/v1/podcast/episode': episodePage([makeEpisode({ id: 1, title: 'Kelp Forests' }), makeEpisode({ id: 2, title: 'Night Tides', podcastTitle: 'Quiet Orchard' })]),
    });
    renderAt('/podcasts/episodes');
    expect(await screen.findByText('Night Tides')).toBeTruthy();
    expect(screen.getAllByText('Quiet Orchard').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'wanted' } });
    await waitFor(() => {
      const last = vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/podcast/episode')).at(-1)!;
      expect(last).toContain('status=wanted');
    });
    fireEvent.click(screen.getByLabelText('Select Kelp Forests'));
    expect(await screen.findByTestId('bulk-bar')).toBeTruthy();
    expect(api.calls.length).toBeGreaterThan(0);
  });

  it('searches the directory and subscribes, marking podcasts already subscribed', async () => {
    const added = makePodcast({ id: 9, title: 'Salt Marsh Notes' });
    const result = (over: Record<string, unknown>) => ({
      source: 'itunes',
      title: 'x',
      author: 'Someone',
      feedUrl: 'https://example.com/x.xml',
      imageUrl: null,
      description: null,
      categories: [],
      episodeCount: 20,
      itunesId: 77,
      podcastIndexId: null,
      explicit: false,
      podcastId: null,
      ...over,
    });
    const api = podApi({
      '/api/v1/podcast/lookup': [result({ title: 'Salt Marsh Notes', feedUrl: 'https://example.com/salt.xml' }), result({ title: 'Tide Pool Hour', feedUrl: 'https://example.com/tide.xml', podcastId: 1 })],
      'POST /api/v1/podcast': added,
    });
    renderAt('/podcasts/add');
    const box = await screen.findByRole('searchbox', { name: 'Search podcasts' });
    fireEvent.change(box, { target: { value: 'marsh' } });
    fireEvent.click(within(box.closest('form')!).getByRole('button', { name: 'Search' }));
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByTestId('already-subscribed')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Subscribe to Salt Marsh Notes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/podcast')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/podcast')!.body).toEqual({ feedUrl: 'https://example.com/salt.xml', itunesId: 77 });
    expect(await within(list).findAllByTestId('already-subscribed')).toHaveLength(2);
  });

  it('previews an RSS URL and subscribes with the default settings', async () => {
    const added = makePodcast({ id: 9, title: 'Salt Marsh Notes' });
    const api = podApi({
      'POST /api/v1/podcast/preview': {
        title: 'Salt Marsh Notes',
        author: 'Marsh Desk',
        description: 'Birds and mud.',
        imageUrl: null,
        link: null,
        feedUrl: 'https://example.com/salt.xml',
        episodeCount: 40,
        latestEpisodes: [{ title: 'Herons', publishedAt: '2026-10-20T00:00:00.000Z', durationSeconds: 1800 }],
        podcastId: null,
      },
      'POST /api/v1/podcast': added,
      '/api/v1/podcast/9': added,
      '/api/v1/podcast/episode': episodePage([]),
    });
    renderAt('/podcasts/add');
    fireEvent.click(await screen.findByRole('tab', { name: 'RSS URL' }));
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://example.com/salt.xml' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('feed-preview')).toBeTruthy();
    expect(screen.getByText('Herons')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/podcast')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/podcast')!.body).toMatchObject({
      feedUrl: 'https://example.com/salt.xml',
      monitored: true,
      tags: [],
      settings: { autoDownload: true, backlog: 3 },
    });
  });

  it('imports pasted OPML and shows what was added, existing and failed', async () => {
    const api = podApi({
      'POST /api/v1/podcast/opml': {
        added: [{ id: 9, title: 'Salt Marsh Notes' }],
        existing: [{ id: 1, title: 'Tide Pool Hour' }],
        failed: [{ feedUrl: 'https://example.com/dead.xml', title: null, error: 'HTTP 404' }],
      },
    });
    renderAt('/podcasts/add');
    fireEvent.click(await screen.findByRole('tab', { name: 'OPML' }));
    fireEvent.change(screen.getByLabelText('Or paste OPML'), { target: { value: '<opml version="2.0"><body/></opml>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const res = await screen.findByTestId('opml-result');
    expect(within(res).getByText('1 added, 1 already subscribed, 1 failed.')).toBeTruthy();
    expect(within(res).getByRole('link', { name: 'Salt Marsh Notes' }).getAttribute('href')).toBe('/podcasts/9');
    expect(within(res).getByText('HTTP 404')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/podcast/opml')!.body).toMatchObject({ opml: '<opml version="2.0"><body/></opml>', tags: [] });
  });

  it('approves and declines suggestions', async () => {
    const api = podApi({
      '/api/v1/podcast/suggestion': [makeSuggestion({ id: 3, title: 'Fern Talk', note: 'Great show' }), makeSuggestion({ id: 4, title: 'Moss Weekly' })],
      'POST /api/v1/podcast/suggestion/3/approve': makeSuggestion({ id: 3, title: 'Fern Talk', status: 'approved', podcastId: 9 }),
      'POST /api/v1/podcast/suggestion/4/decline': makeSuggestion({ id: 4, title: 'Moss Weekly', status: 'declined' }),
    });
    renderAt('/podcasts/suggestions');
    expect(await screen.findByText('Great show')).toBeTruthy();
    expect(screen.getAllByText(/by river/).length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Fern Talk' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/podcast/suggestion/3/approve')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Decline Moss Weekly' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Already have one' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/podcast/suggestion/4/decline')?.body).toEqual({ reason: 'Already have one' }));
  });

  it('saves Settings → Podcasts with the secret left masked', async () => {
    const api = podApi({
      '/api/v1/settings/podcasts': podSettings({ podcastIndexKey: 'key1', podcastIndexSecret: SECRET_MASK }),
      'PUT /api/v1/settings/podcasts': podSettings(),
      '/api/v1/indexerproxy': [],
    });
    renderAt('/settings/podcasts');
    const interval = await screen.findByLabelText('Refresh every');
    fireEvent.change(interval, { target: { value: '120' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/settings/podcasts')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ refreshIntervalMinutes: 120, podcastIndexKey: 'key1', podcastIndexSecret: SECRET_MASK });
  });

  it('lets portal users suggest a podcast by URL and lists theirs', async () => {
    const api = podApi({
      '/api/v1/podcast/suggestion': [makeSuggestion({ id: 3, title: 'Fern Talk', status: 'declined', declineReason: 'Not this time' })],
      'POST /api/v1/podcast/suggestion': makeSuggestion({ id: 8, title: 'Salt Marsh Notes' }),
    });
    renderAt('/discover/podcasts');
    expect(await screen.findByText('Reason: Not this time')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://example.com/salt.xml' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/podcast/suggestion')?.body).toEqual({ feedUrl: 'https://example.com/salt.xml', note: 'Please' }));
    const mine = vi.mocked(fetch).mock.calls.map(([u]) => String(u)).find((u) => u.includes('/podcast/suggestion') && u.includes('mine'));
    expect(mine).toContain('mine=true');
  });
});
