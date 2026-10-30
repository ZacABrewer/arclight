import { describe, expect, it, vi } from 'vitest';
import { matchScore, rankMatches } from '@arclight/shared';
import { matchCommands, matchTargets, rawAfter, verbPrefix, actionWords } from './matcher.js';
import type { PaletteAction, PaletteItem } from './registry.js';

const act = (over: Partial<PaletteAction> & Pick<PaletteAction, 'id' | 'label'>): PaletteAction => ({ group: 'item', permission: 'admin', run: vi.fn(), ...over });
const video = { type: 'item', kinds: ['movie', 'series'] } as const;

const open = act({ id: 'item.open', label: 'Open', keywords: ['go', 'show'], target: { type: 'item', kinds: ['movie', 'series', 'artist'] }, permission: 'library' });
const upgrades = act({ id: 'item.searchUpgrades', label: 'Search for upgrades', keywords: ['upgrade', 'cutoff'], target: video });
const search = act({ id: 'item.search', label: 'Search', keywords: ['automatic'], target: { type: 'item', kinds: ['movie', 'series', 'artist'] } });
const refresh = act({ id: 'item.refresh', label: 'Refresh metadata', target: video });
const addMovie = act({ id: 'global.addMovie', label: 'Add movie', group: 'global', target: { type: 'text' } });
const approveAll = act({ id: 'global.approveAll', label: 'Approve all pending requests', group: 'global', destructive: true });
const actions = [open, upgrades, search, refresh, addMovie, approveAll];

const items: PaletteItem[] = [
  { kind: 'movie', id: 1, title: 'Dune', year: 2021 },
  { kind: 'movie', id: 2, title: 'Dune: Part Two', year: 2024 },
  { kind: 'series', id: 3, title: 'Severance', year: 2022 },
  { kind: 'artist', id: 4, title: 'Dune Rats' },
];

const top = (query: string, extra: Partial<Parameters<typeof matchCommands>[0]> = {}) => matchCommands({ query, actions, items, defaultItemActionId: 'item.open', ...extra });

describe('shared matcher', () => {
  it('ranks exact, then prefix, then substring, then loose matches', () => {
    const titles = ['The Dune Chronicles', 'Dune: Part Two', 'Dune', 'Dunkirk'];
    expect(rankMatches('dune', titles, (x) => x).map((m) => m.item)).toEqual(['Dune', 'Dune: Part Two', 'The Dune Chronicles']);
    expect(matchScore('dnkrk', 'Dunkirk')).toBeGreaterThan(0);
    expect(matchScore('zzz', 'Dunkirk')).toBe(0);
  });

  it('ignores case, accents and punctuation', () => {
    expect(matchScore('amelie', 'Amélie')).toBeGreaterThan(0);
    expect(matchScore('spider man', 'Spider-Man')).toBeGreaterThan(0);
  });
});

describe('command matcher', () => {
  it('reads "upg dune" as Search for upgrades → Dune', () => {
    const [first] = top('upg dune');
    expect(first?.action.id).toBe('item.searchUpgrades');
    expect(first?.item).toMatchObject({ kind: 'movie', id: 1 });
  });

  it('skips linking words and keeps the longest verb', () => {
    const [first] = top('search upgrades for dune part');
    expect(first?.action.id).toBe('item.searchUpgrades');
    expect(first?.item?.id).toBe(2);
  });

  it('only offers kinds an action accepts', () => {
    const rows = top('upg dune');
    expect(rows.some((r) => r.action.id === 'item.searchUpgrades' && r.item?.kind === 'artist')).toBe(false);
    expect(rows.some((r) => r.action.id === 'item.search' && r.item?.kind === 'artist')).toBe(false);
    expect(top('search dune rats').some((r) => r.action.id === 'item.search' && r.item?.kind === 'artist')).toBe(true);
  });

  it('opens a bare name', () => {
    const [first] = top('severance');
    expect(first).toMatchObject({ action: { id: 'item.open' }, item: { id: 3 } });
  });

  it('passes the rest of an add command as typed text', () => {
    const [first] = top('add movie The Matrix: Reloaded');
    expect(first).toMatchObject({ action: { id: 'global.addMovie' }, text: 'The Matrix: Reloaded' });
    expect(top('add movie')[0]).toMatchObject({ action: { id: 'global.addMovie' }, text: '' });
  });

  it('matches global commands by forgiving words', () => {
    expect(top('appr all')[0]?.action.id).toBe('global.approveAll');
    expect(top('nonsense words')).toEqual([]);
  });

  it('applies item verbs to the page subject first', () => {
    const subject: PaletteItem = { kind: 'series', id: 3, title: 'Severance' };
    const [first] = top('upgrades', { subjects: [subject] });
    expect(first).toMatchObject({ action: { id: 'item.searchUpgrades' }, item: { id: 3 }, contextual: true });
  });

  it('lists contextual actions before the rest', () => {
    const extra = act({ id: 'ctx.fix', label: 'Refresh this season', group: 'context' });
    const [first] = top('refresh', { contextActions: [extra] });
    expect(first?.action.id).toBe('ctx.fix');
  });

  it('splits verb words and finds targets', () => {
    expect(verbPrefix(['upg', 'dune'], actionWords(upgrades)).count).toBe(1);
    expect(matchTargets(upgrades, 'dun', items).map((i) => i.id)).toEqual([1, 2]);
    expect(matchTargets(upgrades, '', items)).toHaveLength(3);
    expect(rawAfter('add  movie Spider-Man 2', 2)).toBe('Spider-Man 2');
  });
});
