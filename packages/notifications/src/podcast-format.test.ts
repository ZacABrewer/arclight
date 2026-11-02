import { describe, expect, it } from 'vitest';
import { formatEvent } from './format.js';
import type { PodcastDownloadEvent, PodcastEpisodesEvent } from './types.js';

const base = { instanceName: 'Arclight', applicationUrl: 'https://arclight.example.com/', timestamp: '2026-10-28T12:00:00.000Z' };
const podcast = { id: 4, title: 'The Example Hour', author: 'Example Studios', imageUrl: 'https://example.com/hour/art.png' };

describe('podcast notifications', () => {
  it('lists new episodes, truncating to the items sent', () => {
    const event: PodcastEpisodesEvent = {
      ...base,
      type: 'podcastEpisodes',
      podcast,
      items: [
        { id: 11, title: 'Episode Two', publishedAt: '2026-10-27T08:00:00.000Z' },
        { id: 10, title: 'Episode One' },
      ],
      total: 3,
    };
    const f = formatEvent(event);
    expect(f.subject).toBe('New Podcast Episodes');
    expect(f.title).toBe('The Example Hour');
    expect(f.posterUrl).toBe(podcast.imageUrl);
    expect(f.fields.find((x) => x.name === 'Episodes')?.value).toBe('2026-10-27: Episode Two\nEpisode One\n...and 1 more');
    expect(f.fields.find((x) => x.name === 'Author')?.value).toBe('Example Studios');
    expect(f.link).toBe('https://arclight.example.com/podcasts/4');
    expect(f.actions).toEqual([{ label: 'Open podcast', url: 'https://arclight.example.com/podcasts/4' }]);
  });

  it('uses the singular for one episode', () => {
    const f = formatEvent({ ...base, type: 'podcastEpisodes', podcast, items: [{ id: 1, title: 'Solo' }], total: 1 });
    expect(f.subject).toBe('New Podcast Episode');
    expect(f.fields[0]).toMatchObject({ name: 'Episode', value: 'Solo' });
  });

  it('describes a download', () => {
    const event: PodcastDownloadEvent = {
      ...base,
      type: 'podcastDownload',
      podcast,
      item: { id: 11, title: 'Episode Two', publishedAt: '2026-10-27T08:00:00.000Z', durationSeconds: 3723 },
      path: '/podcasts/The Example Hour/2026/2026-10-27 - Episode Two.mp3',
      sizeBytes: 52_428_800,
    };
    const f = formatEvent(event);
    expect(f.subject).toBe('Podcast Episode Downloaded');
    expect(f.severity).toBe('success');
    expect(f.title).toBe('The Example Hour - Episode Two');
    expect(f.fields.map((x) => x.name)).toEqual(['Published', 'Duration', 'Size', 'Path']);
    expect(f.fields.find((x) => x.name === 'Size')?.value).toMatch(/50(\.0)? MB/);
    expect(f.link).toBe('https://arclight.example.com/podcasts/4');
  });

  it('has no links without an application URL', () => {
    const f = formatEvent({ instanceName: 'Arclight', timestamp: base.timestamp, type: 'podcastEpisodes', podcast, items: [], total: 0 });
    expect(f.link).toBeUndefined();
    expect(f.actions ?? []).toEqual([]);
  });
});
