import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { QUALITIES, TagRuleInput, type TagRuleInputRaw } from '@arclight/shared';
import * as s from '../../db/schema.js';
import { deleteTag } from '../library/service.js';
import { STARTER_RULES } from './starters.js';
import { addArtist, addAuthor, addEpisodeFile, addMovie, addMovieFile, addRequest, addSeries, addTag, addUser, labelsOf, setup } from './test-support.js';

const input = (raw: TagRuleInputRaw) => TagRuleInput.parse(raw);
const GENRES = input({ name: 'Genres', appliesTo: ['movie', 'series'], addTags: ['genre:{genre}'] });

describe('TagRulesService: rules', () => {
  it('creates, orders, updates and deletes rules', async () => {
    const fx = await setup();
    const a = fx.service.createRule(GENRES);
    const b = fx.service.createRule(input({ name: 'Kids', appliesTo: ['movie'], addTags: ['kids'] }));
    expect(fx.service.listRules().map((r) => r.name)).toEqual(['Genres', 'Kids']);
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
    expect(fx.service.reorder([b.id]).map((r) => r.name)).toEqual(['Kids', 'Genres']);
    expect(() => fx.service.reorder([999])).toThrow(/unknown rule/);
    const updated = fx.service.updateRule(a.id, input({ ...GENRES, name: 'Genre tags', enabled: false }));
    expect(updated).toMatchObject({ name: 'Genre tags', enabled: false, appliedCount: 0, lastRun: null });
    fx.service.deleteRule(b.id, { removeTags: false });
    expect(() => fx.service.getRule(b.id)).toThrow(/not found/);
  });

  it('rejects unknown tag ids in conditions and removals', async () => {
    const fx = await setup();
    expect(() => fx.service.createRule(input({ name: 'x', appliesTo: ['movie'], removeTagIds: [42] }))).toThrow(/unknown tag ids: 42/);
  });

  it('seeds the starter rules once, all switched off', async () => {
    const fx = await setup();
    expect(fx.service.seedStarterRules()).toBe(STARTER_RULES.length);
    const rules = fx.service.listRules();
    expect(rules.map((r) => r.starterKey)).toEqual(['genre', 'resolution', 'requested-by', '4k-hdr', 'kids']);
    expect(rules.every((r) => !r.enabled)).toBe(true);
    fx.service.deleteRule(rules[0]!.id, { removeTags: false });
    expect(fx.service.seedStarterRules()).toBe(0);
    expect(fx.service.listRules()).toHaveLength(STARTER_RULES.length - 1);
  });
});

describe('TagRulesService: running', () => {
  it('previews without writing, then applies only the differences', async () => {
    const fx = await setup();
    const horror = addMovie(fx, { genres: ['Horror'] });
    const both = addMovie(fx, { genres: ['Horror', 'Comedy'] });
    const none = addMovie(fx, { genres: [] });
    const show = addSeries(fx, { genres: ['Drama'] });

    const preview = fx.service.preview(GENRES);
    expect(preview).toMatchObject({ dryRun: true, itemsEvaluated: 4, itemsMatched: 4, itemsChanged: 3 });
    expect(preview.add).toEqual([
      { label: 'genre:horror', count: 2, isNew: true },
      { label: 'genre:comedy', count: 1, isNew: true },
      { label: 'genre:drama', count: 1, isNew: true },
    ]);
    expect(preview.samples.map((x) => x.title)).toHaveLength(3);
    expect(fx.db.select().from(s.tags).all()).toEqual([]);
    expect(labelsOf(fx, 'movie', horror)).toEqual([]);

    const rule = fx.service.createRule(GENRES);
    const run = fx.service.run();
    expect(run).toMatchObject({ dryRun: false, itemsChanged: 3 });
    expect(labelsOf(fx, 'movie', horror)).toEqual(['genre:horror']);
    expect(labelsOf(fx, 'movie', both)).toEqual(['genre:comedy', 'genre:horror']);
    expect(labelsOf(fx, 'movie', none)).toEqual([]);
    expect(labelsOf(fx, 'series', show)).toEqual(['genre:drama']);
    expect(fx.service.getRule(rule.id)).toMatchObject({ appliedCount: 3, lastRun: { itemsChanged: 3, tagsAdded: 4 } });

    // Second pass: nothing to do.
    expect(fx.service.run().itemsChanged).toBe(0);
    // A dry run of an enabled rule set reports but does not write.
    fx.db.update(s.movies).set({ genres: ['Thriller'] }).where(eq(s.movies.id, horror)).run();
    const dry = fx.service.run({ dryRun: true });
    expect(dry.add).toEqual([{ label: 'genre:thriller', count: 1, isNew: true }]);
    expect(dry.remove).toEqual([{ label: 'genre:horror', count: 1, isNew: false }]);
    expect(labelsOf(fx, 'movie', horror)).toEqual(['genre:horror']);
    fx.service.run();
    expect(labelsOf(fx, 'movie', horror)).toEqual(['genre:thriller']);
  });

  it('leaves hand-added tags alone and removes only its own when no longer matching', async () => {
    const fx = await setup();
    const manual = addTag(fx, 'genre:horror');
    const fav = addTag(fx, 'favourite');
    const m = addMovie(fx, { genres: ['Horror'], tags: [manual, fav] });
    const n = addMovie(fx, { genres: ['Horror'] });
    fx.service.createRule(GENRES);
    fx.service.run();
    expect(fx.service.applied('movie', m)).toEqual([]);
    expect(fx.service.applied('movie', n)).toEqual([expect.objectContaining({ tagId: manual, ruleName: 'Genres' })]);

    fx.db.update(s.movies).set({ genres: [] }).run();
    const r = fx.service.run();
    expect(r.remove).toEqual([{ label: 'genre:horror', count: 1, isNew: false }]);
    expect(labelsOf(fx, 'movie', m)).toEqual(['favourite', 'genre:horror']);
    expect(labelsOf(fx, 'movie', n)).toEqual([]);
  });

  it('keeps its tags when "remove when no longer matching" is off', async () => {
    const fx = await setup();
    const m = addMovie(fx, { genres: ['Horror'] });
    fx.service.createRule(input({ ...GENRES, removeWhenUnmatched: false }));
    fx.service.run();
    fx.db.update(s.movies).set({ genres: [] }).run();
    fx.service.run();
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:horror']);
  });

  it('runs one rule on its own (even when disabled) and leaves other rules alone', async () => {
    const fx = await setup();
    const m = addMovie(fx, { genres: ['Horror'], certification: 'PG' });
    const genres = fx.service.createRule(GENRES);
    const kids = fx.service.createRule(input({ name: 'Kids', enabled: false, appliesTo: ['movie'], conditions: [{ kind: 'set', field: 'certification', op: 'any', values: ['pg'] }], addTags: ['kids'] }));
    fx.service.run();
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:horror']);
    fx.service.run({ ruleIds: [kids.id] });
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:horror', 'kids']);
    fx.db.update(s.movies).set({ genres: [] }).run();
    fx.service.run({ ruleIds: [kids.id] });
    expect(labelsOf(fx, 'movie', m)).toEqual(['genre:horror', 'kids']);
    fx.service.run({ ruleIds: [genres.id] });
    expect(labelsOf(fx, 'movie', m)).toEqual(['kids']);
    expect(() => fx.service.run({ ruleIds: [999] })).toThrow(/not found/);
  });

  it('evaluates file, request, music and audiobook facts', async () => {
    const fx = await setup();
    const uhd = addMovie(fx, { title: 'UHD' });
    addMovieFile(fx, uhd, { quality: QUALITIES['Remux-2160p'], mediaInfo: { videoDynamicRangeType: 'DV HDR10', videoCodec: 'x265', audioChannels: 7.1 }, releaseGroup: 'GRP' });
    const hd = addMovie(fx, { title: 'HD' });
    addMovieFile(fx, hd, { quality: QUALITIES['WEBDL-1080p'] });
    const show = addSeries(fx, { network: 'HBO' });
    addEpisodeFile(fx, show, { quality: QUALITIES['WEBDL-720p'] });
    addEpisodeFile(fx, show, { quality: QUALITIES['WEBDL-1080p'] });
    const sam = addUser(fx, 'Sam');
    const tmdb = fx.db.select().from(s.movies).where(eq(s.movies.id, hd)).get()!.tmdbId;
    addRequest(fx, { type: 'movie', tmdbId: tmdb, userId: sam });
    const declined = addUser(fx, 'Lee');
    addRequest(fx, { type: 'movie', tmdbId: tmdb, userId: declined, status: 'declined' });
    const artist = addArtist(fx, { genres: ['Jazz'], albums: [{ primaryType: 'Album', secondaryTypes: ['Live'] }] });
    const author = addAuthor(fx, { books: [{ title: 'B1', narrators: ['Ann Reader'], series: 'Saga' }] });

    fx.service.createRule(input({ name: 'Res', appliesTo: ['movie', 'series'], addTags: ['res:{resolution}'] }));
    fx.service.createRule(
      input({
        name: '4K HDR',
        appliesTo: ['movie', 'series'],
        conditions: [
          { kind: 'set', field: 'resolution', op: 'any', values: ['2160p'] },
          { kind: 'set', field: 'hdr', op: 'present' },
          { kind: 'set', field: 'videoCodec', op: 'any', values: ['hevc'] },
          { kind: 'range', field: 'audioChannels', min: 5.1, max: null },
        ],
        addTags: ['4k-hdr', 'hdr:{hdr}', 'grp:{releasegroup}'],
      }),
    );
    fx.service.createRule(input({ name: 'Requested', appliesTo: ['movie', 'series', 'artist', 'author'], conditions: [{ kind: 'ids', field: 'requestedBy', op: 'present' }], addTags: ['requested:{requester}'] }));
    fx.service.createRule(input({ name: 'Net', appliesTo: ['series'], addTags: ['network:{network}'] }));
    fx.service.createRule(input({ name: 'Music', appliesTo: ['artist'], conditions: [{ kind: 'set', field: 'albumType', op: 'any', values: ['live'] }], addTags: ['genre:{genre}', 'live'] }));
    fx.service.createRule(input({ name: 'Books', appliesTo: ['author'], addTags: ['narrator:{narrator}', 'series:{bookseries}'] }));
    fx.service.run();

    expect(labelsOf(fx, 'movie', uhd)).toEqual(['4k-hdr', 'grp:grp', 'hdr:dv', 'hdr:hdr10', 'res:2160p']);
    expect(labelsOf(fx, 'movie', hd)).toEqual(['requested:sam', 'res:1080p']);
    expect(labelsOf(fx, 'series', show)).toEqual(['network:hbo', 'res:1080p', 'res:720p']);
    expect(labelsOf(fx, 'artist', artist)).toEqual(['genre:jazz', 'live']);
    expect(labelsOf(fx, 'author', author)).toEqual(['narrator:ann-reader', 'series:saga']);
  });

  it('processes large libraries in pages and only for the listed items on events', async () => {
    const fx = await setup({ batchSize: 3 });
    const ids = Array.from({ length: 10 }, () => addMovie(fx, { genres: ['Drama'] }));
    fx.service.createRule(GENRES);
    expect(fx.service.run().itemsChanged).toBe(10);
    fx.db.update(s.movies).set({ genres: ['Western'] }).run();
    const r = fx.service.runForItems({ movie: [ids[0]!, ids[1]!] });
    expect(r?.itemsEvaluated).toBe(2);
    expect(labelsOf(fx, 'movie', ids[0]!)).toEqual(['genre:western']);
    expect(labelsOf(fx, 'movie', ids[5]!)).toEqual(['genre:drama']);
  });

  it('deleting a rule can take its tags off (but not tags another rule also added)', async () => {
    const fx = await setup();
    const m = addMovie(fx, { genres: ['Horror'], certification: 'R' });
    const a = fx.service.createRule(input({ name: 'A', appliesTo: ['movie'], addTags: ['scary', 'a-only'] }));
    fx.service.createRule(input({ name: 'B', appliesTo: ['movie'], conditions: [{ kind: 'set', field: 'certification', op: 'any', values: ['r'] }], addTags: ['scary'] }));
    fx.service.run();
    expect(labelsOf(fx, 'movie', m)).toEqual(['a-only', 'scary']);
    fx.service.deleteRule(a.id, { removeTags: true });
    expect(labelsOf(fx, 'movie', m)).toEqual(['scary']);
    expect(fx.service.applied('movie', m).map((x) => x.ruleName)).toEqual(['B']);
  });

  it('prunes ownership of deleted items', async () => {
    const fx = await setup();
    const m = addMovie(fx, { genres: ['Horror'] });
    fx.service.createRule(GENRES);
    fx.service.run();
    fx.db.delete(s.movies).where(eq(s.movies.id, m)).run();
    expect(fx.service.pruneOrphans()).toBe(1);
  });

  it('flags tags that drive behaviour', async () => {
    const fx = await setup();
    const t = addTag(fx, 'kids');
    fx.db.insert(s.delayProfiles).values({ enableUsenet: true, enableTorrent: true, preferredProtocol: 'usenet', usenetDelay: 0, torrentDelay: 0, order: 1, tags: [t] } as never).run();
    addMovie(fx, { certification: 'G' });
    const r = fx.service.preview(input({ name: 'Kids', appliesTo: ['movie'], conditions: [{ kind: 'set', field: 'certification', op: 'any', values: ['G'] }], addTags: ['kids'] }));
    expect(r.add).toEqual([{ label: 'kids', count: 1, isNew: false }]);
    expect(r.behaviour).toEqual([{ label: 'kids', uses: { delayProfile: 1 } }]);
  });

  it('offers picker values from the library', async () => {
    const fx = await setup();
    addMovie(fx, { genres: ['Horror'], certification: 'R', studio: 'A24' });
    addSeries(fx, { genres: ['horror', 'Drama'], network: 'HBO' });
    addUser(fx, 'Sam');
    const o = fx.service.options();
    expect(o.values['genre']).toEqual(['Drama', 'Horror']);
    expect(o.values['network']).toEqual(['HBO']);
    expect(o.values['studio']).toEqual(['A24']);
    expect(o.values['resolution']).toContain('2160p');
    expect(o.users).toEqual([{ id: expect.any(Number), name: 'Sam' }]);
    expect(o.qualityProfiles).toEqual([{ id: fx.profileId, name: 'HD', domain: 'video' }]);
  });
});

describe('TagRulesService: tag management', () => {
  it('counts usage per kind, behaviour uses, auto-applied items and the rules behind a tag', async () => {
    const fx = await setup();
    const t = addTag(fx, 'kids');
    addTag(fx, 'unused');
    addMovie(fx, { tags: [t], certification: 'G' });
    addMovie(fx, { certification: 'G' });
    fx.db.insert(s.releaseProfiles).values({ name: 'RP', enabled: true, required: [], ignored: [], tags: [t] } as never).run();
    fx.db.insert(s.settings).values({ key: 'requests', value: { movie: { tags: [t] } }, updatedAt: 'x' }).run();
    const rule = fx.service.createRule(input({ name: 'Kids', appliesTo: ['movie'], conditions: [{ kind: 'set', field: 'certification', op: 'any', values: ['g'] }], addTags: ['kids'] }));
    fx.service.run();
    const usage = fx.service.usage();
    expect(usage.find((u) => u.label === 'kids')).toEqual({
      id: t,
      label: 'kids',
      counts: { movie: 2, releaseProfile: 1, settings: 1 },
      total: 4,
      behaviourUses: 2,
      autoApplied: 1,
      rules: [{ id: rule.id, name: 'Kids' }],
    });
    expect(usage.find((u) => u.label === 'unused')).toMatchObject({ total: 0, counts: {} });
  });

  it('merges a tag into another everywhere it is used', async () => {
    const fx = await setup();
    const from = addTag(fx, 'scifi');
    const into = addTag(fx, 'sci-fi');
    const m1 = addMovie(fx, { tags: [from] });
    const m2 = addMovie(fx, { tags: [from, into] });
    fx.db.insert(s.releaseProfiles).values({ name: 'RP', enabled: true, required: [], ignored: [], tags: [from] } as never).run();
    fx.db.insert(s.settings).values({ key: 'importLists', value: { cleanLibraryTags: [from] }, updatedAt: 'x' }).run();
    const rule = fx.service.createRule(input({ name: 'R', appliesTo: ['movie'], conditions: [{ kind: 'ids', field: 'tag', op: 'any', ids: [from] }], addTags: ['scifi', 'x:{genre}'], removeTagIds: [from] }));

    expect(fx.service.mergeTag(from, into)).toEqual({ id: into, label: 'sci-fi' });
    expect(labelsOf(fx, 'movie', m1)).toEqual(['sci-fi']);
    expect(labelsOf(fx, 'movie', m2)).toEqual(['sci-fi']);
    expect(fx.db.select().from(s.releaseProfiles).get()!.tags).toEqual([into]);
    expect(fx.db.select().from(s.settings).where(eq(s.settings.key, 'importLists')).get()!.value).toEqual({ cleanLibraryTags: [into] });
    expect(fx.service.getRule(rule.id)).toMatchObject({ addTags: ['sci-fi', 'x:{genre}'], removeTagIds: [into], conditions: [{ ids: [into] }] });
    expect(fx.db.select().from(s.tags).all().map((t) => t.label)).toEqual(['sci-fi']);
    expect(() => fx.service.mergeTag(into, into)).toThrow(/itself/);
  });

  it('bulk-deletes tags, refusing tags in use unless forced, and cleans every reference', async () => {
    const fx = await setup();
    const used = addTag(fx, 'used');
    const free = addTag(fx, 'free');
    const m = addMovie(fx, { tags: [used] });
    fx.db.insert(s.releaseProfiles).values({ name: 'RP', enabled: true, required: [], ignored: [], tags: [used] } as never).run();
    expect(() => fx.service.deleteTags([used, free], false)).toThrow(/in use: used/);
    expect(fx.service.deleteTags([free], false)).toEqual({ deleted: 1 });
    expect(fx.service.deleteTags([used], true)).toEqual({ deleted: 1 });
    expect(labelsOf(fx, 'movie', m)).toEqual([]);
    expect(fx.db.select().from(s.releaseProfiles).get()!.tags).toEqual([]);
    expect(() => fx.service.deleteTags([used], true)).toThrow(/not found/);
  });

  it('the library DELETE /tag/:id path also strips settings entities now', async () => {
    const fx = await setup();
    const t = addTag(fx, 'x');
    fx.db.insert(s.releaseProfiles).values({ name: 'RP', enabled: true, required: [], ignored: [], tags: [t] } as never).run();
    const m = addMovie(fx, { tags: [t] });
    deleteTag(fx.db, t);
    expect(fx.db.select().from(s.releaseProfiles).get()!.tags).toEqual([]);
    expect(labelsOf(fx, 'movie', m)).toEqual([]);
  });
});
