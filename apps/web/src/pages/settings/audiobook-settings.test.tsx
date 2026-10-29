import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AUDNEXUS_DEFAULT_BASE_URL, AudibleRegion, NAMING_DEFAULTS, ReleasesSettings } from '@arclight/shared';
import { MEDIA_MANAGEMENT_WIRE_DEFAULTS } from '../../api/settings.js';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { audibleRegionLabel, toAudiobookMetadataUpdate } from './general/audiobook-metadata-section.js';
import { rootKindLabel } from '../../components/media/root-kind.js';
import { rootFolderKinds } from './media-management/media-management-page.js';
import { audiobookPreview, renderPreview } from './media-management/naming-preview.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ON = { music: false, audiobooks: true };
const OFF = { music: false, audiobooks: false };

const metadata = {
  audibleRegion: 'us',
  audnexusBaseUrl: AUDNEXUS_DEFAULT_BASE_URL,
  openLibraryFallback: true,
  languages: ['english'],
  audnexusRateLimitPerSecond: 1,
  audibleRateLimitPerSecond: 2,
  openLibraryRateLimitPerSecond: 1,
};

const audio = { trackMatchThreshold: 0.8, audiobookDurationTolerance: 5, renameAudiobookParts: true, writeAbsSidecars: false };
const releases = ReleasesSettings.parse({});

function settingsApi(features = ON, extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/features': features,
    '/api/v1/settings/metadata': { tmdbApiKey: null, language: 'en-US', region: 'US' },
    '/api/v1/settings/audiobookmetadata': metadata,
    '/api/v1/settings/naming': NAMING_DEFAULTS,
    '/api/v1/settings/mediamanagement': MEDIA_MANAGEMENT_WIRE_DEFAULTS,
    '/api/v1/settings/audio': audio,
    '/api/v1/settings/releases': releases,
    '/api/v1/rootfolder': [],
    '/api/v1/tag': [],
    ...extra,
  });
}

describe('audiobook settings helpers', () => {
  it('labels every Audible marketplace with its store domain', () => {
    expect(audibleRegionLabel('us')).toBe('United States (audible.com)');
    expect(audibleRegionLabel('uk')).toBe('United Kingdom (audible.co.uk)');
    expect(AudibleRegion.options.map(audibleRegionLabel).every((l) => /\(audible\./.test(l))).toBe(true);
  });

  it('turns the metadata form into a PUT body', () => {
    expect(
      toAudiobookMetadataUpdate({ ...metadata, audibleRegion: 'de', languages: 'English, German ', audnexusBaseUrl: ' ', audibleRateLimitPerSecond: '3' }),
    ).toEqual({ ...metadata, audibleRegion: 'de', languages: ['english', 'german'], audibleRateLimitPerSecond: 3 });
  });

  it('previews the audiobook formats', () => {
    expect(renderPreview(NAMING_DEFAULTS.seriesBookFolderFormat, 'seriesBookFolder')).toBe('Lantern Tales/Book 3 - The Glass Orchard');
    expect(renderPreview(NAMING_DEFAULTS.bookPartFormat, 'bookPart')).toBe('01 - The Glass Orchard.mp3');
    expect(audiobookPreview(NAMING_DEFAULTS, 'series')).toBe('Mara Quill/Lantern Tales/Book 3 - The Glass Orchard/The Glass Orchard.m4b');
    expect(audiobookPreview(NAMING_DEFAULTS, 'parts')).toBe('Mara Quill/The Glass Orchard/01 - The Glass Orchard.mp3');
  });
});

describe('Settings → General: audiobooks', () => {
  it('turns audiobooks on from the Features section', async () => {
    const api = settingsApi(OFF, { 'PUT /api/v1/settings/features': ON });
    renderAt('/settings/general');
    const toggle = (await screen.findByRole('switch', { name: /Audiobooks/ })) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Audiobook metadata' })).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/features')?.body).toEqual(ON));
    expect(await screen.findByRole('region', { name: 'Audiobook metadata' })).toBeTruthy();
  });

  it('picks the Audible region and saves the metadata section', async () => {
    const api = settingsApi(ON, { 'PUT /api/v1/settings/audiobookmetadata': (init: RequestInit | undefined) => ({ ...metadata, ...(JSON.parse(String(init?.body)) as object) }) });
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'Audiobook metadata' });
    const region = (await within(section).findByLabelText('Audible marketplace')) as HTMLSelectElement;
    expect([...region.options].map((o) => o.value)).toEqual([...AudibleRegion.options]);
    expect(within(region).getByRole('option', { name: 'Germany (audible.de)' })).toBeTruthy();
    fireEvent.change(region, { target: { value: 'de' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/settings/audiobookmetadata')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/audiobookmetadata')?.body).toMatchObject({
      audibleRegion: 'de',
      openLibraryFallback: true,
      languages: ['english'],
    });
  });
});

describe('Settings → Media management: audiobooks', () => {
  it('shows audiobook naming with live samples and saves the audiobook fields', async () => {
    const api = settingsApi(ON, { 'PUT /api/v1/settings/naming': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as object });
    renderAt('/settings/mediamanagement');
    const part = (await screen.findByLabelText('Book part format')) as HTMLInputElement;
    expect(screen.getByTestId('sample-bookPartFormat').textContent).toBe('→ 01 - The Glass Orchard.mp3');
    expect(screen.getByTestId('sample-audiobookSeriesPath').textContent).toBe('Mara Quill/Lantern Tales/Book 3 - The Glass Orchard/The Glass Orchard.m4b');
    fireEvent.change(part, { target: { value: 'Part {Part:000}' } });
    expect(screen.getByTestId('sample-bookPartFormat').textContent).toBe('→ Part 001.mp3');
    fireEvent.click(screen.getByLabelText('Rename audiobooks'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/settings/naming')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/naming')?.body).toMatchObject({ renameAudiobooks: true, bookPartFormat: 'Part {Part:000}' });
  });

  it('hides the audiobook sections while the flag is off', async () => {
    const api = settingsApi(OFF);
    renderAt('/settings/mediamanagement');
    await screen.findByLabelText('Standard episode format');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/settings/features')).toBe(true));
    expect(screen.queryByText('Audiobook naming')).toBeNull();
    expect(screen.queryByText('Audiobook releases')).toBeNull();
    expect(screen.queryByLabelText('Duration tolerance')).toBeNull();
  });

  it('saves the audiobook import options with the stored music field', async () => {
    const api = settingsApi(ON, { 'PUT /api/v1/settings/audio': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as object });
    renderAt('/settings/mediamanagement');
    const tolerance = await screen.findByLabelText('Duration tolerance');
    // Music is off: the track threshold stays out of sight but goes back unchanged.
    expect(screen.queryByLabelText('Track match threshold')).toBeNull();
    fireEvent.change(tolerance, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('switch', { name: /Write Audiobookshelf sidecars/ }));
    const section = screen.getByRole('region', { name: 'Audio import' });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/settings/audio')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/audio')?.body).toEqual({
      trackMatchThreshold: 0.8,
      audiobookDurationTolerance: 8,
      renameAudiobookParts: true,
      writeAbsSidecars: true,
    });
  });

  it('saves book packs and abridged with the rest of the releases section', async () => {
    const api = settingsApi(ON, { 'PUT /api/v1/settings/releases': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as object });
    renderAt('/settings/mediamanagement');
    const section = await screen.findByRole('region', { name: 'Audiobook releases' });
    fireEvent.click(await within(section).findByRole('switch', { name: 'Allow book packs' }));
    fireEvent.click(within(section).getByRole('switch', { name: 'Allow abridged' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/settings/releases')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/releases')?.body).toEqual({ ...releases, allowBookPacks: true, allowAbridged: true });
  });

  it('offers the audiobook root folder type while the flag is on', () => {
    expect(rootFolderKinds({ music: false, audiobooks: true })).toEqual(['series', 'movie', 'audiobook']);
    expect(rootFolderKinds({ music: true, audiobooks: false })).toEqual(['series', 'movie', 'music']);
    expect(rootKindLabel('audiobook')).toBe('Audiobooks');
  });
});

describe('Settings → Profiles: audiobook domain', () => {
  const videoProfile = { id: 1, name: 'HD', upgradeAllowed: true, cutoff: 3, items: [{ kind: 'quality', qualityId: 3, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [], mediaDomain: 'video' };
  const routes = (features: typeof ON) => ({
    '/api/v1/settings/features': features,
    '/api/v1/qualityprofile': [videoProfile],
    '/api/v1/qualityprofile/schema': { ...videoProfile, id: undefined, name: '' },
    '/api/v1/customformat': [],
    '/api/v1/delayprofile': [],
    '/api/v1/releaseprofile': [],
    '/api/v1/tag': [],
    '/api/v1/rootfolder': [],
    '/api/v1/albumtypeprofile': [],
    '/api/v1/profilemigration/profiles': [],
  });

  it('shows the Audiobook domain once the flag is on', async () => {
    stubApi(routes(ON));
    renderAt('/settings/profiles');
    expect(await screen.findByTestId('profiles-audiobook')).toBeTruthy();
    expect(screen.queryByTestId('profiles-music')).toBeNull();
  });

  it('keeps one video grid while the flag is off', async () => {
    const api = stubApi(routes(OFF));
    renderAt('/settings/profiles');
    await screen.findByText('HD');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/settings/features')).toBe(true));
    expect(screen.queryByTestId('profiles-audiobook')).toBeNull();
  });
});
