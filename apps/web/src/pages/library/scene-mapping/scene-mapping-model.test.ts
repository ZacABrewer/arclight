import { describe, expect, it } from 'vitest';
import { SceneMapping, SceneMappingInput } from '@arclight/shared';
import { draftFromMapping, draftToInput, emptyDraft, librarySide, orderMappings, sceneSide } from './scene-mapping-model.js';

const mapping =(over: Partial<SceneMapping>): SceneMapping =>
  SceneMapping.parse({
    id: 1,
    seriesId: 1,
    kind: 'season',
    sceneSeason: 2,
    sceneEpisode: 1,
    sceneAbsolute: null,
    tvdbSeason: 1,
    tvdbEpisode: 13,
    tvdbAbsolute: null,
    sceneTitle: null,
    source: 'manual',
    comment: '',
    ...over,
  });

describe('scene mapping draft', () => {
  it('builds a season rule body and nulls the fields the kind does not use', () => {
    const r = draftToInput({ ...emptyDraft('season'), sceneSeason: '2', sceneEpisode: '1', tvdbSeason: '1', tvdbEpisode: '13', sceneAbsolute: '99', sceneTitle: 'stale', comment: ' split cour ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      kind: 'season',
      sceneSeason: 2,
      sceneEpisode: 1,
      sceneAbsolute: null,
      tvdbSeason: 1,
      tvdbEpisode: 13,
      tvdbAbsolute: null,
      sceneTitle: null,
      comment: 'split cour',
    });
    expect(SceneMappingInput.safeParse(r.value).success).toBe(true);
  });

  it('mirrors the contract refinements per kind with field errors', () => {
    const season = draftToInput(emptyDraft('season'));
    expect(season.ok).toBe(false);
    if (!season.ok) expect(Object.keys(season.errors).sort()).toEqual(['sceneSeason', 'tvdbSeason']);

    const absolute = draftToInput({ ...emptyDraft('absolute'), sceneAbsolute: '27', tvdbSeason: '2' });
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) expect(absolute.errors.tvdbAbsolute).toMatch(/library absolute number, or a library season and episode/);

    const title = draftToInput({ ...emptyDraft('title'), sceneTitle: '   ' });
    expect(title.ok).toBe(false);
    if (!title.ok) expect(title.errors.sceneTitle).toBeTruthy();

    const bad = draftToInput({ ...emptyDraft('season'), sceneSeason: '-1', tvdbAbsolute: '3' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.sceneSeason).toBe('Enter a whole number, 0 or more.');
  });

  it('accepts absolute and title rules the contract accepts', () => {
    const abs = draftToInput({ ...emptyDraft('absolute'), sceneAbsolute: '27', tvdbAbsolute: '40' });
    expect(abs.ok && abs.value).toMatchObject({ kind: 'absolute', sceneAbsolute: 27, tvdbAbsolute: 40 });
    const title = draftToInput({ ...emptyDraft('title'), sceneTitle: ' Show Kai ', tvdbSeason: '3' });
    expect(title.ok && title.value).toMatchObject({ kind: 'title', sceneTitle: 'Show Kai', tvdbSeason: 3, sceneSeason: null });
  });

  it('round-trips a stored rule into the form', () => {
    const m = mapping({ comment: 'from AniDB' });
    const draft = draftFromMapping(m);
    expect(draft).toMatchObject({ kind: 'season', sceneSeason: '2', sceneEpisode: '1', tvdbAbsolute: '', comment: 'from AniDB' });
    const back = draftToInput(draft);
    expect(back.ok && back.value).toMatchObject({ sceneSeason: 2, tvdbEpisode: 13, comment: 'from AniDB' });
  });
});

describe('scene mapping summaries', () => {
  it('describes both sides of each kind', () => {
    expect(sceneSide(mapping({}))).toBe('S02E01');
    expect(sceneSide(mapping({ sceneEpisode: null }))).toBe('S02');
    expect(librarySide(mapping({}))).toBe('S01E13');
    expect(sceneSide(mapping({ kind: 'absolute', sceneSeason: null, sceneAbsolute: 27 }))).toBe('#27');
    expect(sceneSide(mapping({ kind: 'absolute', sceneSeason: 3, sceneAbsolute: 27 }))).toBe('#27 in S3');
    expect(librarySide(mapping({ tvdbSeason: null, tvdbEpisode: null, tvdbAbsolute: 40 }))).toBe('#40');
    expect(sceneSide(mapping({ kind: 'title', sceneTitle: 'Show Kai', sceneSeason: null }))).toBe('“Show Kai”');
    expect(librarySide(mapping({ kind: 'title', tvdbSeason: 3, tvdbEpisode: null }))).toBe('S03');
    expect(librarySide(mapping({ tvdbSeason: null, tvdbEpisode: null }))).toBe('—');
  });

  it('lists manual rules before feed rules', () => {
    const rows = [
      mapping({ id: 1, source: 'feed', kind: 'title', sceneTitle: 'A' }),
      mapping({ id: 2, source: 'manual', sceneSeason: 3 }),
      mapping({ id: 3, source: 'manual', sceneSeason: 1 }),
    ];
    expect(orderMappings(rows).map((m) => m.id)).toEqual([3, 2, 1]);
  });
});
