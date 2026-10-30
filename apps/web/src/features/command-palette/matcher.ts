import { bestWordScore, rankMatches, searchWords } from '@arclight/shared';
import { acceptsItem, type PaletteAction, type PaletteItem } from './registry.js';

// Pure parsing for the command palette: "upg dune" → "Search for upgrades → Dune". The leading
// words of the query select the verb (forgiving: prefixes and loose abbreviations count), the
// rest names the item (or the free text of an add flow). Plain data in, ranked rows out.

export interface PaletteRow {
  action: PaletteAction;
  item?: PaletteItem | undefined;
  /** Free text for `target: text` actions. */
  text?: string | undefined;
  /** From a page's subject or contextual actions. */
  contextual?: boolean | undefined;
  score: number;
}

/** Linking words skipped between the verb and the item ("search upgrades for Dune"). */
const LINK_WORDS = new Set(['for', 'of', 'on', 'in', 'to']);

/** Words of an action the verb part is matched against. */
export function actionWords(action: Pick<PaletteAction, 'label' | 'keywords'>): string[] {
  return [...searchWords(action.label), ...(action.keywords ?? []).flatMap((k) => searchWords(k))];
}

/**
 * How many leading tokens select the action, and their summed score. `count` is the longest run
 * of leading tokens that each match some action word.
 */
export function verbPrefix(tokens: readonly string[], words: readonly string[]): { count: number; scores: number[] } {
  const scores: number[] = [];
  for (const token of tokens) {
    const s = bestWordScore(token, words);
    if (s === 0) break;
    scores.push(s);
  }
  return { count: scores.length, scores };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function dropLinkWords(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length && LINK_WORDS.has(tokens[i]!)) i += 1;
  return tokens.slice(i);
}

export interface MatchInput {
  query: string;
  actions: readonly PaletteAction[];
  items: readonly PaletteItem[];
  /** Items of the open page (contextual): item actions apply to them with no name typed. */
  subjects?: readonly PaletteItem[] | undefined;
  /** Contextual actions registered by the page. */
  contextActions?: readonly PaletteAction[] | undefined;
  /** Action used for a bare item name ("dune" → Open → Dune). */
  defaultItemActionId?: string | undefined;
  /** Item rows per action. */
  itemsPerAction?: number | undefined;
  limit?: number | undefined;
}

const key = (r: Pick<PaletteRow, 'action' | 'item' | 'text'>) => `${r.action.id}|${r.item ? `${r.item.kind}:${r.item.id}` : ''}|${r.text ?? ''}`;

/** Ranked rows for a non-empty query (best first). */
export function matchCommands({ query, actions, items, subjects = [], contextActions = [], defaultItemActionId, itemsPerAction = 4, limit = 40 }: MatchInput): PaletteRow[] {
  const tokens = searchWords(query);
  if (tokens.length === 0) return [];
  const best = new Map<string, PaletteRow>();
  const add = (row: PaletteRow) => {
    const k = key(row);
    const have = best.get(k);
    if (!have || have.score < row.score) best.set(k, row);
  };

  const consider = (action: PaletteAction, contextual: boolean) => {
    const words = actionWords(action);
    const { count, scores } = verbPrefix(tokens, words);
    const boost = contextual ? 400 : 0;
    const target = action.target;
    if (!target) {
      if (count === tokens.length) add({ action, score: sum(scores) * 10 + boost, contextual });
      return;
    }
    if (target.type === 'text') {
      if (count === 0) return;
      const rest = dropLinkWords(tokens.slice(count));
      // The original words keep their case and punctuation for the add flow's search box.
      const text = rest.length ? rawAfter(query, tokens.length - rest.length) : '';
      add({ action, text, score: sum(scores) * 10 + boost, contextual });
      return;
    }
    // Item actions: the page's subject when the whole query is the verb…
    if (count === tokens.length) {
      for (const s of subjects) if (acceptsItem(action, s)) add({ action, item: s, contextual: true, score: sum(scores) * 10 + 400 });
      add({ action, score: sum(scores) * 10 + boost - 1, contextual });
    }
    // …else every split of verb / item name, longest verb first.
    for (let k = count; k >= 1; k -= 1) {
      const rest = dropLinkWords(tokens.slice(k));
      if (rest.length === 0) continue;
      const candidates = items.filter((i) => acceptsItem(action, i));
      for (const { item, score } of rankMatches(rest.join(' '), candidates, (i) => i.title).slice(0, itemsPerAction)) {
        add({ action, item, score: sum(scores.slice(0, k)) * 10 + score / 10 + boost, contextual });
      }
    }
  };

  for (const a of contextActions) consider(a, true);
  for (const a of actions) consider(a, false);

  // A bare name: open (or the default action on) the matching items.
  const fallback = defaultItemActionId ? actions.find((a) => a.id === defaultItemActionId) : undefined;
  if (fallback) {
    const candidates = items.filter((i) => acceptsItem(fallback, i));
    for (const { item, score } of rankMatches(query, candidates, (i) => i.title).slice(0, 6)) add({ action: fallback, item, score: score / 10 });
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The raw query after its first `skip` normalized words, as typed. */
export function rawAfter(query: string, skip: number): string {
  const parts = query.trim().split(/\s+/);
  let seen = 0;
  let i = 0;
  while (i < parts.length && seen < skip) {
    seen += searchWords(parts[i]!).length;
    i += 1;
  }
  return parts.slice(i).join(' ');
}

/** Items an item action can target, best match first (the "pick a target" step). */
export function matchTargets(action: PaletteAction, query: string, items: readonly PaletteItem[], limit = 20): PaletteItem[] {
  const candidates = items.filter((i) => acceptsItem(action, i));
  if (!query.trim()) return candidates.slice(0, limit);
  return rankMatches(query, candidates, (i) => i.title)
    .slice(0, limit)
    .map((m) => m.item);
}
