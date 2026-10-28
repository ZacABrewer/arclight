// The `naming` section's music and audiobook fields (docs/design/music-audiobooks.md 9.4).

import { beforeEach, describe, expect, it } from 'vitest';
import { NAMING_DEFAULTS } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { settings } from '../../db/schema.js';
import { getSection, setSection } from './service.js';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe('naming section: music and audiobooks', () => {
  it('fills the music/audiobook defaults into a stored video-only value', () => {
    // A value saved before music existed keeps its video settings and gains the new defaults.
    db.insert(settings)
      .values({ key: 'naming', value: { renameEpisodes: true, seriesFolderFormat: '{Series TitleYear}' }, updatedAt: '2026-01-01T00:00:00.000Z' })
      .run();
    const naming = getSection(db, 'naming');
    expect(naming.renameEpisodes).toBe(true);
    expect(naming.seriesFolderFormat).toBe('{Series TitleYear}');
    expect(naming).toMatchObject({
      renameTracks: false,
      artistFolderFormat: '{Artist Name}',
      albumFolderFormat: '{Album Title} ({Release Year})',
      trackFormat: '{track:00} - {Track Title}',
      multiDiscTrackFormat: '{medium:0}-{track:00} - {Track Title}',
      multiDiscStyle: 'prefix',
      renameAudiobooks: false,
      bookPartFormat: '{Part:00} - {Book Title}',
    });
  });

  it('persists music naming and rejects invalid formats', () => {
    setSection(db, 'naming', { ...NAMING_DEFAULTS, renameTracks: true, multiDiscStyle: 'subfolder', trackFormat: '{track:000} {Track Title}' });
    expect(getSection(db, 'naming')).toMatchObject({ renameTracks: true, multiDiscStyle: 'subfolder', trackFormat: '{track:000} {Track Title}' });

    expect(() => setSection(db, 'naming', { ...NAMING_DEFAULTS, trackFormat: '{Track Title}' })).toThrow(/Track format must contain \{track\}/);
    expect(() => setSection(db, 'naming', { ...NAMING_DEFAULTS, multiDiscTrackFormat: '{track:00}' })).toThrow(/\{medium\}/);
    expect(() => setSection(db, 'naming', { ...NAMING_DEFAULTS, albumFolderFormat: ' ' })).toThrow(/cannot be empty/);
    expect(() => setSection(db, 'naming', { ...NAMING_DEFAULTS, multiDiscStyle: 'nested' as never })).toThrow();
  });
});
