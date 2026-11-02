import { describe, expect, it } from 'vitest';
import { AudioImportSettings } from '@arclight/shared';
import { toAudioImportUpdate } from './audio-import-section.js';

describe('toAudioImportUpdate', () => {
  it('sends the cue, tagging, cover and ReplayGain choices with the rest of the stored section', () => {
    const saved = AudioImportSettings.parse({});
    const body = toAudioImportUpdate(saved, {
      threshold: '75',
      tolerance: String(saved.audiobookDurationTolerance),
      renameParts: saved.renameAudiobookParts,
      sidecars: saved.writeAbsSidecars,
      cueHandling: 'keepImage',
      writeTags: true,
      embedCoverArt: true,
      saveCoverArt: false,
      replayGain: true,
    });
    expect(body).toEqual({ ...saved, trackMatchThreshold: 0.75, cueHandling: 'keepImage', writeTags: true, embedCoverArt: true, replayGain: true });
  });
});
