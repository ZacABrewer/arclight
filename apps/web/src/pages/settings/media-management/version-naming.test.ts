import { describe, expect, it } from 'vitest';
import { NAMING_DEFAULTS, NamingConfig } from '@arclight/shared';
import { hasVersionToken, renderPreview, versionedPreview } from './naming-preview.js';
import { versionSamples } from './version-naming.js';

const movie = { format: '{Movie Title} ({Release Year})', kind: 'movie' as const };
const folder = [{ format: '{Movie Title} ({Release Year})', kind: 'movieFolder' as const }];

describe('version naming preview', () => {
  it('renders {Version} only for a versioned file and drops a dangling separator otherwise', () => {
    expect(renderPreview('{Movie Title} - {Version}', 'movie', { version: '4K' })).toBe('Dune Part Two - 4K.mkv');
    expect(renderPreview('{Movie Title} - {Version}', 'movie')).toBe('Dune Part Two.mkv');
    expect(renderPreview('{Movie Title} [{Version}]', 'movie')).toBe('Dune Part Two.mkv');
    expect(hasVersionToken('{Movie Title} {version}')).toBe(true);
    expect(hasVersionToken('{Movie Title}')).toBe(false);
  });

  it('side by side appends " - <tag>" when the format has no token, and keeps the token placement when it has one', () => {
    expect(versionedPreview(movie, folder, 'sideBySide', '4K')).toBe('Dune Part Two (2024)/Dune Part Two (2024) - 4K.mkv');
    expect(versionedPreview({ ...movie, format: '{Movie Title} [{Version}]' }, folder, 'sideBySide', '4K')).toBe('Dune Part Two (2024)/Dune Part Two [4K].mkv');
  });

  it('subfolder puts each version in a <tag> folder without renaming the file', () => {
    expect(versionedPreview(movie, folder, 'subfolder', '4K')).toBe('Dune Part Two (2024)/4K/Dune Part Two (2024).mkv');
    const samples = versionSamples(NamingConfig.parse({ ...NAMING_DEFAULTS, versionLayout: 'subfolder' }), 'subfolder');
    expect(samples.episode.split('/')).toHaveLength(4);
    expect(samples.episode.split('/')[2]).toBe('4K');
  });
});
