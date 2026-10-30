import type { TagRuleInputRaw } from '@arclight/shared';

// Starter rules, added once per database and switched off: they show what rules can do and
// are one toggle away from use. Deleting one keeps it gone (see TagRulesService.seedStarterRules).

export interface StarterRule {
  key: string;
  rule: TagRuleInputRaw;
}

export const STARTER_RULES: readonly StarterRule[] = [
  {
    key: 'genre',
    rule: {
      name: 'Genre tags',
      enabled: false,
      appliesTo: ['movie', 'series', 'artist', 'author'],
      conditions: [],
      addTags: ['genre:{genre}'],
    },
  },
  {
    key: 'resolution',
    rule: {
      name: 'Resolution tags',
      enabled: false,
      appliesTo: ['movie', 'series'],
      conditions: [{ kind: 'bool', field: 'hasFile', value: true }],
      addTags: ['res:{resolution}'],
    },
  },
  {
    key: 'requested-by',
    rule: {
      name: 'Requested-by tags',
      enabled: false,
      appliesTo: ['movie', 'series', 'artist', 'author'],
      conditions: [{ kind: 'ids', field: 'requestedBy', op: 'present' }],
      addTags: ['requested:{requester}'],
    },
  },
  {
    key: '4k-hdr',
    rule: {
      name: '4K HDR',
      enabled: false,
      appliesTo: ['movie', 'series'],
      match: 'all',
      conditions: [
        { kind: 'set', field: 'resolution', op: 'any', values: ['2160p'] },
        { kind: 'set', field: 'hdr', op: 'present' },
      ],
      addTags: ['4k-hdr'],
    },
  },
  {
    key: 'kids',
    rule: {
      name: 'Kids',
      enabled: false,
      appliesTo: ['movie', 'series'],
      conditions: [{ kind: 'set', field: 'certification', op: 'any', values: ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'U'] }],
      addTags: ['kids'],
    },
  },
];
