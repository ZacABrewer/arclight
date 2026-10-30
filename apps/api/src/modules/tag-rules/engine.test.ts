import { describe, expect, it } from 'vitest';
import { TagRuleInput, sanitizeTagLabel, templateVariables, unknownTemplateVariables, type TagRuleConditionInput } from '@arclight/shared';
import { diffPlan, evaluateCondition, planItem, renderTemplate, ruleMatches, type EngineRule, type EvalContext, type ItemFacts } from './engine.js';
import { audioLanguagesOf, channelsLabel, decadeOf, hdrFormatsOf, ratingOf, resolutionOf, videoCodecOf } from './facts.js';
import { QUALITIES, TagRuleCondition, type QualityModel } from '@arclight/shared';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const ctx: EvalContext = { now: NOW, tagLabels: new Map([[1, 'kids'], [2, 'keep'], [3, 'ghost']]) };

function facts(over: Partial<ItemFacts> = {}): ItemFacts {
  return {
    entityType: 'movie',
    id: 1,
    title: 'Alien (1979)',
    addedAt: '2026-05-22T00:00:00.000Z',
    sets: {
      genre: ['Horror', 'Science Fiction'],
      resolution: ['2160p'],
      quality: ['Remux-2160p'],
      source: ['blurayRaw'],
      hdr: ['dv', 'hdr10'],
      videoCodec: ['hevc'],
      audioCodec: ['truehd atmos'],
      audioLanguage: ['eng', 'english'],
      originalLanguage: ['en'],
      certification: ['R'],
      studio: ['20th Century Fox'],
      status: ['released'],
      rootFolder: ['/movies'],
      collection: ['Alien Collection'],
      releaseGroup: ['FraMeSToR'],
    },
    nums: { year: 1979, rating: 8.2, audioChannels: 7.1, sizeGb: 60, runtime: 117 },
    bools: { monitored: true, hasFile: true },
    qualityProfileIds: [4],
    requestedByIds: [7],
    vars: { genre: ['Horror', 'Science Fiction'], resolution: ['2160p'], requester: ['Sam'], decade: ['1970s'], studio: ['20th Century Fox'] },
    ...over,
  };
}

const cond = (c: TagRuleConditionInput) => TagRuleCondition.parse(c);
const holds = (c: TagRuleConditionInput, f = facts(), labels: string[] = []) => evaluateCondition(cond(c), f, new Set(labels), ctx);

function rule(over: Partial<EngineRule> & { id: number }): EngineRule {
  return { appliesTo: ['movie', 'series'], match: 'all', conditions: [], addTags: [], removeLabels: [], removeWhenUnmatched: true, ...over };
}

describe('set conditions', () => {
  it.each([
    ['genre', 'any', ['horror'], true],
    ['genre', 'any', ['comedy'], false],
    ['genre', 'all', ['Horror', 'science fiction'], true],
    ['genre', 'all', ['Horror', 'Comedy'], false],
    ['genre', 'none', ['comedy'], true],
    ['genre', 'none', ['HORROR'], false],
    ['resolution', 'any', ['2160p'], true],
    ['quality', 'any', ['remux-2160p'], true],
    ['source', 'any', ['bluray'], false],
    ['hdr', 'any', ['dv'], true],
    ['videoCodec', 'any', ['h264'], false],
    ['audioCodec', 'any', ['TrueHD Atmos'], true],
    ['audioLanguage', 'any', ['eng'], true],
    ['originalLanguage', 'any', ['ja'], false],
    ['certification', 'any', ['R'], true],
    ['studio', 'any', ['20th century fox'], true],
    ['status', 'any', ['released'], true],
    ['rootFolder', 'any', ['/movies'], true],
    ['collection', 'any', ['alien collection'], true],
    ['releaseGroup', 'any', ['framestor'], true],
  ] as const)('%s %s %j → %s', (field, op, values, expected) => {
    expect(holds({ kind: 'set', field, op, values: [...values] })).toBe(expected);
  });

  it('present / absent look at whether the field has any value', () => {
    expect(holds({ kind: 'set', field: 'hdr', op: 'present' })).toBe(true);
    expect(holds({ kind: 'set', field: 'network', op: 'present' })).toBe(false);
    expect(holds({ kind: 'set', field: 'network', op: 'absent' })).toBe(true);
    expect(holds({ kind: 'set', field: 'hdr', op: 'absent' }, facts({ sets: { hdr: [] } }))).toBe(true);
  });

  it('covers the music and audiobook fields', () => {
    const artist = facts({ entityType: 'artist', sets: { genre: ['Jazz'], albumType: ['Album', 'Live'], artistType: ['Group'] } });
    expect(holds({ kind: 'set', field: 'albumType', op: 'any', values: ['live'] }, artist)).toBe(true);
    expect(holds({ kind: 'set', field: 'artistType', op: 'any', values: ['person'] }, artist)).toBe(false);
    const author = facts({ entityType: 'author', sets: { author: ['Ann Leckie'], narrator: ['Adjoa Andoh'], bookSeries: ['Imperial Radch'] } });
    expect(holds({ kind: 'set', field: 'author', op: 'any', values: ['ann leckie'] }, author)).toBe(true);
    expect(holds({ kind: 'set', field: 'narrator', op: 'any', values: ['Adjoa Andoh'] }, author)).toBe(true);
    expect(holds({ kind: 'set', field: 'bookSeries', op: 'none', values: ['Imperial Radch'] }, author)).toBe(false);
    const series = facts({ entityType: 'series', sets: { network: ['HBO'], seriesType: ['anime'] } });
    expect(holds({ kind: 'set', field: 'network', op: 'any', values: ['hbo'] }, series)).toBe(true);
    expect(holds({ kind: 'set', field: 'seriesType', op: 'any', values: ['anime'] }, series)).toBe(true);
  });
});

describe('range conditions', () => {
  it.each([
    ['year', 1970, 1979, true],
    ['year', 1980, null, false],
    ['rating', 8, null, true],
    ['audioChannels', 5.1, null, true],
    ['audioChannels', null, 2, false],
    ['sizeGb', 50, 100, true],
    ['runtime', null, 90, false],
    ['addedDays', null, 14, true],
    ['addedDays', 30, null, false],
  ] as const)('%s [%s, %s] → %s', (field, min, max, expected) => {
    expect(holds({ kind: 'range', field, min, max })).toBe(expected);
  });

  it('never matches an unknown value', () => {
    expect(holds({ kind: 'range', field: 'rating', min: 0, max: 10 }, facts({ nums: {} }))).toBe(false);
    expect(holds({ kind: 'range', field: 'addedDays', min: 0, max: 10 }, facts({ addedAt: null }))).toBe(false);
  });
});

describe('bool and id conditions', () => {
  it('monitored and has-file', () => {
    expect(holds({ kind: 'bool', field: 'monitored', value: true })).toBe(true);
    expect(holds({ kind: 'bool', field: 'hasFile', value: false })).toBe(false);
  });

  it('quality profile and requester', () => {
    expect(holds({ kind: 'ids', field: 'qualityProfile', op: 'any', ids: [4] })).toBe(true);
    expect(holds({ kind: 'ids', field: 'qualityProfile', op: 'none', ids: [4] })).toBe(false);
    expect(holds({ kind: 'ids', field: 'requestedBy', op: 'present' })).toBe(true);
    expect(holds({ kind: 'ids', field: 'requestedBy', op: 'any', ids: [8] })).toBe(false);
    expect(holds({ kind: 'ids', field: 'requestedBy', op: 'absent' }, facts({ requestedByIds: [] }))).toBe(true);
  });

  it('tag conditions see the tags at that point of the pass', () => {
    expect(holds({ kind: 'ids', field: 'tag', op: 'any', ids: [1] }, facts(), ['kids'])).toBe(true);
    expect(holds({ kind: 'ids', field: 'tag', op: 'any', ids: [1] }, facts(), [])).toBe(false);
    expect(holds({ kind: 'ids', field: 'tag', op: 'none', ids: [2] }, facts(), ['kids'])).toBe(true);
    // A tag id that no longer exists cannot be "any"-matched.
    expect(holds({ kind: 'ids', field: 'tag', op: 'any', ids: [99] }, facts(), ['kids'])).toBe(false);
  });
});

describe('rule matching', () => {
  const horror = cond({ kind: 'set', field: 'genre', op: 'any', values: ['horror'] });
  const comedy = cond({ kind: 'set', field: 'genre', op: 'any', values: ['comedy'] });

  it('all / any / no conditions / other item types', () => {
    expect(ruleMatches(rule({ id: 1, conditions: [horror, comedy] }), facts(), new Set(), ctx)).toBe(false);
    expect(ruleMatches(rule({ id: 1, match: 'any', conditions: [horror, comedy] }), facts(), new Set(), ctx)).toBe(true);
    expect(ruleMatches(rule({ id: 1 }), facts(), new Set(), ctx)).toBe(true);
    expect(ruleMatches(rule({ id: 1, appliesTo: ['artist'] }), facts(), new Set(), ctx)).toBe(false);
  });
});

describe('templates', () => {
  it('makes one sanitised, lower-case tag per value', () => {
    expect(renderTemplate('genre:{genre}', facts())).toEqual(['genre:horror', 'genre:science-fiction']);
    expect(renderTemplate('res:{resolution}', facts())).toEqual(['res:2160p']);
    expect(renderTemplate('requested:{requester}', facts())).toEqual(['requested:sam']);
    expect(renderTemplate('decade:{decade}', facts())).toEqual(['decade:1970s']);
    expect(renderTemplate('studio:{ Studio }', facts())).toEqual(['studio:20th-century-fox']);
  });

  it('fixed labels, missing values, combinations and the cap', () => {
    expect(renderTemplate('4K HDR!', facts())).toEqual(['4k-hdr']);
    expect(renderTemplate('net:{network}', facts())).toEqual([]);
    expect(renderTemplate('{genre}-{resolution}', facts())).toEqual(['horror-2160p', 'science-fiction-2160p']);
    const many = facts({ vars: { genre: Array.from({ length: 40 }, (_, i) => `g${i}`) } });
    expect(renderTemplate('genre:{genre}', many)).toHaveLength(25);
    expect(renderTemplate('genre:{genre}', facts({ vars: { genre: ['Drama', 'drama', ' '] } }))).toEqual(['genre:drama']);
  });

  it('sanitises labels and validates variables', () => {
    expect(sanitizeTagLabel('  Science   Fiction ')).toBe('science-fiction');
    expect(sanitizeTagLabel('Rock & Roll / Live')).toBe('rock-&-roll-live');
    expect(sanitizeTagLabel('HDR10+')).toBe('hdr10+');
    expect(sanitizeTagLabel('Amélie')).toBe('amélie');
    expect(sanitizeTagLabel('***')).toBe('');
    expect(sanitizeTagLabel('x'.repeat(150))).toHaveLength(100);
    expect(templateVariables('a:{Genre}-{genre}-{year}')).toEqual(['genre', 'year']);
    expect(unknownTemplateVariables('{genre}:{bogus}')).toEqual(['bogus']);
    expect(TagRuleInput.safeParse({ name: 'x', appliesTo: ['movie'], addTags: ['{bogus}'] }).success).toBe(false);
    expect(TagRuleInput.safeParse({ name: 'x', appliesTo: ['movie'], addTags: [] }).success).toBe(false);
    expect(TagRuleInput.safeParse({ name: 'x', appliesTo: ['movie'], addTags: ['a'], conditions: [{ kind: 'set', field: 'genre', op: 'any', values: [] }] }).success).toBe(false);
    expect(TagRuleInput.safeParse({ name: 'x', appliesTo: ['movie'], addTags: ['a'], conditions: [{ kind: 'range', field: 'year', min: 2000, max: 1990 }] }).success).toBe(false);
    expect(TagRuleInput.safeParse({ name: 'x', appliesTo: ['movie'], addTags: ['a'], conditions: [{ kind: 'eval', code: '1' }] }).success).toBe(false);
  });
});

describe('planItem: ownership and removal', () => {
  const genre = rule({ id: 10, addTags: ['genre:{genre}'] });
  const noOwners = new Map<string, Set<number>>();

  it('adds tags and records which rule owns them', () => {
    const state = { labels: new Set(['favourite']), owners: noOwners };
    const plan = planItem([genre], facts(), state, ctx);
    expect([...plan.labels].sort()).toEqual(['favourite', 'genre:horror', 'genre:science-fiction']);
    expect(diffPlan(state, plan)).toEqual({
      add: ['genre:horror', 'genre:science-fiction'],
      remove: [],
      own: [
        ['genre:horror', 10],
        ['genre:science-fiction', 10],
      ],
      disown: [],
    });
  });

  it('never takes ownership of (or removes) a tag the user added by hand', () => {
    const state = { labels: new Set(['genre:horror']), owners: noOwners };
    const plan = planItem([genre], facts(), state, ctx);
    expect(plan.owners.has('genre:horror')).toBe(false);
    // Later the genre goes away: the hand-added tag stays.
    const after = planItem([genre], facts({ vars: { genre: [] } }), { labels: plan.labels, owners: plan.owners }, ctx);
    expect(after.labels.has('genre:horror')).toBe(true);
    expect(after.labels.has('genre:science-fiction')).toBe(false);
  });

  it('removes its own tags when the rule stops matching, unless told not to', () => {
    const owned = { labels: new Set(['genre:horror', 'mine']), owners: new Map([['genre:horror', new Set([10])]]) };
    const changed = facts({ vars: { genre: ['Comedy'] } });
    const plan = planItem([genre], changed, owned, ctx);
    expect([...plan.labels].sort()).toEqual(['genre:comedy', 'mine']);
    expect(diffPlan(owned, plan).disown).toEqual([['genre:horror', 10]]);

    const sticky = rule({ id: 10, addTags: ['genre:{genre}'], removeWhenUnmatched: false });
    const kept = planItem([sticky], changed, owned, ctx);
    expect(kept.labels.has('genre:horror')).toBe(true);
    expect(kept.owners.get('genre:horror')).toEqual(new Set([10]));
  });

  it('a tag two rules added stays until neither produces it', () => {
    const a = rule({ id: 1, addTags: ['scary'], conditions: [cond({ kind: 'set', field: 'genre', op: 'any', values: ['horror'] })] });
    const b = rule({ id: 2, addTags: ['scary'], conditions: [cond({ kind: 'range', field: 'year', min: 1970, max: 1989 })] });
    const first = planItem([a, b], facts(), { labels: new Set(), owners: noOwners }, ctx);
    expect(first.owners.get('scary')).toEqual(new Set([1, 2]));
    const noHorror = facts({ sets: { genre: ['Drama'] } });
    const second = planItem([a, b], noHorror, first, ctx);
    expect(second.labels.has('scary')).toBe(true);
    expect(second.owners.get('scary')).toEqual(new Set([2]));
    const third = planItem([a, b], facts({ sets: { genre: ['Drama'] }, nums: { year: 2020 } }), second, ctx);
    expect(third.labels.has('scary')).toBe(false);
  });

  it('runs rules in order: later rules see earlier tags, removals win, rules outside the run are untouched', () => {
    const kids = rule({ id: 1, addTags: ['kids'], conditions: [cond({ kind: 'set', field: 'certification', op: 'any', values: ['R'] })] });
    const family = rule({ id: 2, addTags: ['family'], conditions: [cond({ kind: 'ids', field: 'tag', op: 'any', ids: [1] })] });
    const strip = rule({ id: 3, removeLabels: ['kids'] });
    const plan = planItem([kids, family, strip], facts(), { labels: new Set(), owners: noOwners }, ctx);
    expect([...plan.labels].sort()).toEqual(['family']);
    expect(plan.owners.has('kids')).toBe(false);
    expect(plan.matched).toEqual([1, 2, 3]);

    const other = { labels: new Set(['old']), owners: new Map([['old', new Set([99])]]) };
    const untouched = planItem([kids], facts(), other, ctx);
    expect(untouched.labels.has('old')).toBe(true);
    expect(untouched.owners.get('old')).toEqual(new Set([99]));
  });

  it('re-adds an owned tag the user removed while the rule still matches', () => {
    const state = { labels: new Set<string>(), owners: new Map([['genre:horror', new Set([10])]]) };
    const plan = planItem([genre], facts(), state, ctx);
    expect(plan.labels.has('genre:horror')).toBe(true);
  });
});

describe('fact normalisers', () => {
  it('resolution from the quality, else the probed size', () => {
    const qm = (def: (typeof QUALITIES)[keyof typeof QUALITIES]) => ({ quality: def, revision: { version: 1, real: 0, isRepack: false } }) as unknown as QualityModel;
    expect(resolutionOf(qm(QUALITIES['Bluray-2160p']), null)).toBe('2160p');
    expect(resolutionOf(qm(QUALITIES.Unknown), { width: 1920, height: 800 })).toBe('1080p');
    expect(resolutionOf(qm(QUALITIES.Unknown), { resolution: '1280x720' })).toBe('720p');
    expect(resolutionOf(qm(QUALITIES.Unknown), null)).toBeNull();
  });

  it('HDR formats, codecs, languages, channels, decades, ratings', () => {
    expect(hdrFormatsOf({ videoDynamicRangeType: 'DV HDR10' })).toEqual(['dv', 'hdr10']);
    expect(hdrFormatsOf({ videoDynamicRangeType: 'HDR10Plus' })).toEqual(['hdr10+']);
    expect(hdrFormatsOf({ videoDynamicRange: 'HDR' })).toEqual(['hdr']);
    expect(hdrFormatsOf({ videoDynamicRangeType: 'SDR' })).toEqual([]);
    expect(hdrFormatsOf({ videoDynamicRange: 'HLG' })).toEqual(['hlg']);
    expect(videoCodecOf({ videoCodec: 'x265' })).toBe('hevc');
    expect(videoCodecOf({ videoFormat: 'h264' })).toBe('h264');
    expect(videoCodecOf({ videoCodec: 'Theora' })).toBe('theora');
    expect(
      audioLanguagesOf({
        quality: { quality: QUALITIES.DVD, revision: { version: 1, real: 0, isRepack: false } } as unknown as QualityModel,
        mediaInfo: { audioLanguages: ['English'], audioStreams: [{ codec: 'aac', language: 'JPN' }] },
        sizeBytes: 0,
        releaseGroup: null,
        languages: ['French', 'Unknown'],
      }),
    ).toEqual(['english', 'jpn', 'french']);
    expect(channelsLabel(5.1)).toBe('5.1');
    expect(channelsLabel(2)).toBe('2.0');
    expect(decadeOf(1987)).toBe('1980s');
    expect(ratingOf({ imdb: { value: 7.5 } })).toBe(7.5);
    expect(ratingOf({ tmdb: { value: 0 } })).toBeNull();
  });
});
