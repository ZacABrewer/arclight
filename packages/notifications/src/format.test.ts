import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, HEALTH_RESTORED, IMPORT, MANUAL_INTERACTION, UPGRADE } from '../fixtures/events.js';
import { episodeLabel, formatBytes, formatEvent, healthDocsLink, mediaLink } from './format.js';

describe('formatBytes', () => {
  it('picks a sensible unit and precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(3_221_225_472)).toBe('3.00 GB');
    expect(formatBytes(123_456_789_012)).toBe('115 GB');
  });
});

describe('episodeLabel', () => {
  it('formats a single episode', () => {
    expect(episodeLabel([{ id: 1, seasonNumber: 1, episodeNumber: 2, title: '' }])).toBe('S01E02');
  });

  it('collapses contiguous runs and lists gaps', () => {
    const ep = (s: number, e: number) => ({ id: e, seasonNumber: s, episodeNumber: e, title: '' });
    expect(episodeLabel([ep(2, 3), ep(2, 4), ep(2, 5)])).toBe('S02E03-E05');
    expect(episodeLabel([ep(2, 3), ep(2, 7)])).toBe('S02E03,E07');
    expect(episodeLabel([ep(1, 10), ep(2, 1)])).toBe('S01E10 S02E01');
  });

  it('is empty for movies', () => {
    expect(episodeLabel(undefined)).toBe('');
    expect(episodeLabel([])).toBe('');
  });
});

describe('formatEvent', () => {
  it('builds a grab headline with episode range and release fields', () => {
    const f = formatEvent(GRAB);
    expect(f.subject).toBe('Episode Grabbed');
    expect(f.title).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(f.severity).toBe('info');
    expect(f.fields).toEqual(
      expect.arrayContaining([
        { name: 'Quality', value: 'WEBDL-1080p', inline: true },
        { name: 'Size', value: '3.00 GB', inline: true },
        { name: 'Indexer', value: 'Example Indexer', inline: true },
        { name: 'Custom Formats', value: 'x264, Streaming Service' },
        { name: 'Release', value: GRAB.release.title },
      ]),
    );
    expect(f.link).toBe('https://mt.example.com/series/7');
    expect(f.posterUrl).toBe('https://img.example/poster.jpg');
    expect(f.body).toContain('Quality: WEBDL-1080p');
  });

  it('describes movie imports and upgrades', () => {
    const imported = formatEvent(IMPORT);
    expect(imported.subject).toBe('Movie Imported');
    expect(imported.title).toBe('Harbour Lights (2021)');
    expect(imported.severity).toBe('success');
    expect(imported.fields).toEqual(expect.arrayContaining([{ name: 'Codecs', value: 'x264 / DTS 5.1', inline: true }]));

    const upgraded = formatEvent(UPGRADE);
    expect(upgraded.subject).toBe('Movie Upgraded');
    expect(upgraded.severity).toBe('upgrade');
    expect(upgraded.fields.find((f) => f.name === 'Replaced')?.value).toBe('Harbour Lights (2021) WEBDL-720p.mkv (WEBDL-720p)');
  });

  it('maps health status to severity', () => {
    expect(formatEvent(HEALTH_ISSUE)).toMatchObject({ subject: 'Health Issue: Error', severity: 'error', title: 'Health Issue: Error' });
    expect(formatEvent({ ...HEALTH_ISSUE, health: { ...HEALTH_ISSUE.health, status: 'warning' } }).severity).toBe('warning');
    expect(formatEvent(HEALTH_RESTORED)).toMatchObject({ subject: 'Health Issue Resolved', severity: 'success' });
    expect(formatEvent(HEALTH_ISSUE).body).toContain('Message: Unable to communicate with qBittorrent.');
  });

  it('shows status messages for manual interaction', () => {
    const f = formatEvent(MANUAL_INTERACTION);
    expect(f.severity).toBe('warning');
    expect(f.fields).toEqual(
      expect.arrayContaining([{ name: MANUAL_INTERACTION.downloadTitle, value: 'No files found are eligible for import' }]),
    );
  });

  it('falls back to TMDB links without an application URL', () => {
    expect(mediaLink(GRAB.media)).toBe('https://www.themoviedb.org/tv/123456');
    expect(mediaLink({ ...GRAB.media, tmdbId: 0 })).toBe('https://www.imdb.com/title/tt1234567/');
  });
});

describe('healthDocsLink', () => {
  it('makes in-app docs links absolute with the instance URL, and drops them without one', () => {
    expect(healthDocsLink('/docs/system/health#vpn-leak', 'https://arclight.example.com/')).toBe('https://arclight.example.com/docs/system/health#vpn-leak');
    expect(healthDocsLink('/docs/system/health#vpn-leak', undefined)).toBeUndefined();
    expect(healthDocsLink('https://docs.example.com/x', undefined)).toBe('https://docs.example.com/x');
    expect(healthDocsLink(undefined, 'https://arclight.example.com')).toBeUndefined();
  });
});
