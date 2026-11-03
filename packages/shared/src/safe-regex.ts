// Guard for regular expressions written by admins or imported from outside (custom formats,
// release-profile terms, TRaSH guides, *arr databases, indexer definitions, subtitle filters).
// Those patterns run against release titles that anyone on an indexer controls, on the API's
// main thread, so a pattern that backtracks catastrophically ("(a+)+$") would freeze the
// server. JavaScript has no regex timeout, so patterns are checked statically instead:
//
// - length is capped (MAX_REGEX_PATTERN_LENGTH);
// - a repeated group may not contain a variable-length repeat unless every pass through the
//   group must also consume a character the inner repeat cannot ("(\w+\s?)+" is refused,
//   "(\d{1,3}\.){3}" and "(?:[ .-]+\w+)+" are fine);
// - a repeated alternation may not offer two one-character branches that overlap ("(\w|\d)+");
// - two unbounded repeats over overlapping characters may not sit next to each other with
//   only optional items between them (".*.*", "\s*\s+").
//
// The check is a heuristic, not a proof: it refuses the shapes behind real-world ReDoS and
// accepts the patterns the TRaSH guides publish.

/** Longest pattern accepted on save or import. TRaSH's longest patterns are just under 500. */
export const MAX_REGEX_PATTERN_LENGTH = 1000;

export type RegexPatternProblem = 'empty' | 'tooLong' | 'invalid' | 'nestedQuantifier' | 'overlappingAlternation' | 'adjacentQuantifiers';

const PROBLEM_TEXT: Record<RegexPatternProblem, string> = {
  empty: 'pattern is empty',
  tooLong: `pattern is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`,
  invalid: 'pattern is not a valid regular expression',
  nestedQuantifier: 'pattern nests a repeat inside a repeat (catastrophic backtracking)',
  overlappingAlternation: 'pattern repeats alternatives that match the same characters (catastrophic backtracking)',
  adjacentQuantifiers: 'pattern has adjacent repeats over the same characters (slow backtracking)',
};

/** A human-readable explanation of a problem. */
export function describeRegexProblem(problem: RegexPatternProblem): string {
  return PROBLEM_TEXT[problem];
}

// ---------------------------------------------------------------------------------------
// Pattern tree

/** Characters used to compare character sets (sampling, not exact set algebra). */
const SAMPLE: string[] = (() => {
  const out: string[] = [];
  for (let c = 0; c < 128; c++) out.push(String.fromCharCode(c));
  for (const ch of [' ', 'é', 'É', 'ß', 'ö', 'ñ', '–', '—', '’', ' ', '　', 'я', 'Ж', 'α', '中', '日', 'ア', '한', '\u{1F600}']) out.push(ch);
  return out;
})();

type CharSet = Uint8Array;
const FULL: CharSet = new Uint8Array(SAMPLE.length).fill(1);

type Node =
  | { k: 'atom'; set: CharSet }
  | { k: 'zero' }
  | { k: 'backref' }
  | { k: 'group'; body: Node; look: boolean }
  | { k: 'alt'; branches: Node[]; srcs: string[] }
  | { k: 'seq'; items: Node[] }
  | { k: 'quant'; child: Node; min: number; max: number };

class Parser {
  i = 0;
  constructor(
    private readonly src: string,
    private readonly flags: string,
  ) {}

  private readonly setCache = new Map<string, CharSet>();

  parse(): Node {
    const n = this.alt();
    return n;
  }

  private alt(): Node {
    const start = this.i;
    const branches: Node[] = [];
    const srcs: string[] = [];
    let bStart = start;
    branches.push(this.seq());
    srcs.push(this.src.slice(bStart, this.i));
    while (this.src[this.i] === '|') {
      this.i++;
      bStart = this.i;
      branches.push(this.seq());
      srcs.push(this.src.slice(bStart, this.i));
    }
    return branches.length === 1 ? branches[0]! : { k: 'alt', branches, srcs };
  }

  private seq(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
      const atom = this.atom();
      items.push(this.quantifier(atom));
    }
    return { k: 'seq', items };
  }

  private quantifier(atom: Node): Node {
    const c = this.src[this.i];
    let min: number;
    let max: number;
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) return atom;
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      this.i += m[0].length - 1;
    } else return atom;
    this.i++;
    if (this.src[this.i] === '?') this.i++;
    return { k: 'quant', child: atom, min, max };
  }

  private atom(): Node {
    const s = this.src;
    const c = s[this.i]!;
    if (c === '(') {
      this.i++;
      let look = false;
      if (s.startsWith('?:', this.i)) this.i += 2;
      else if (s.startsWith('?=', this.i) || s.startsWith('?!', this.i)) [this.i, look] = [this.i + 2, true];
      else if (s.startsWith('?<=', this.i) || s.startsWith('?<!', this.i)) [this.i, look] = [this.i + 3, true];
      else if (s.startsWith('?<', this.i)) this.i = s.indexOf('>', this.i) + 1;
      else if (s[this.i] === '?') {
        // Modifier group "(?i:...)" / "(?-i:...)".
        const m = /^\?[a-z]*(?:-[a-z]*)?:/.exec(s.slice(this.i));
        this.i += m ? m[0].length : 1;
      }
      const body = this.alt();
      this.i++; // ')'
      return { k: 'group', body, look };
    }
    if (c === '[') {
      const start = this.i;
      this.i++;
      if (s[this.i] === '^') this.i++;
      if (s[this.i] === ']' && !this.unicodeSets()) this.i++;
      let depth = 1;
      while (this.i < s.length && depth > 0) {
        const d = s[this.i]!;
        if (d === '\\') this.i += 2;
        else {
          if (d === '[' && this.unicodeSets()) depth++;
          else if (d === ']') depth--;
          this.i++;
        }
      }
      return { k: 'atom', set: this.setOf(s.slice(start, this.i)) };
    }
    if (c === '\\') {
      const start = this.i;
      const d = s[this.i + 1] ?? '';
      if (d === 'b' || d === 'B') {
        this.i += 2;
        return { k: 'zero' };
      }
      if (/[1-9]/.test(d)) {
        this.i++;
        while (/\d/.test(s[this.i] ?? '')) this.i++;
        return { k: 'backref' };
      }
      if (d === 'k' && s[this.i + 2] === '<') {
        this.i = s.indexOf('>', this.i) + 1;
        return { k: 'backref' };
      }
      if ((d === 'p' || d === 'P') && s[this.i + 2] === '{') this.i = s.indexOf('}', this.i) + 1;
      else if (d === 'x') this.i += 4;
      else if (d === 'u' && s[this.i + 2] === '{') this.i = s.indexOf('}', this.i) + 1;
      else if (d === 'u') this.i += 6;
      else if (d === 'c') this.i += 3;
      else this.i += 2;
      return { k: 'atom', set: this.setOf(s.slice(start, this.i)) };
    }
    this.i++;
    if (c === '^' || c === '$') return { k: 'zero' };
    return { k: 'atom', set: this.setOf(c === '.' ? '.' : escapeLiteral(c)) };
  }

  private unicodeSets(): boolean {
    return this.flags.includes('v');
  }

  /** Which sample characters a one-character atom matches. */
  private setOf(atomSrc: string): CharSet {
    const cached = this.setCache.get(atomSrc);
    if (cached) return cached;
    let set: CharSet;
    try {
      const f = [...new Set(this.flags.replace(/[gyd]/g, '') + 's')].join('');
      const re = new RegExp(`^(?:${atomSrc})$`, f);
      set = new Uint8Array(SAMPLE.length);
      for (let j = 0; j < SAMPLE.length; j++) set[j] = re.test(SAMPLE[j]!) ? 1 : 0;
    } catch {
      set = FULL;
    }
    this.setCache.set(atomSrc, set);
    return set;
  }
}

function escapeLiteral(c: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c;
}

function overlaps(a: CharSet, b: CharSet): boolean {
  for (let j = 0; j < a.length; j++) if (a[j] && b[j]) return true;
  return false;
}

function union(into: Uint8Array, b: CharSet): void {
  for (let j = 0; j < into.length; j++) if (b[j]) into[j] = 1;
}

/** Every character any atom under the node can consume (a backreference: anything). */
function charsOf(n: Node, into = new Uint8Array(SAMPLE.length)): Uint8Array {
  switch (n.k) {
    case 'atom':
      union(into, n.set);
      break;
    case 'backref':
      union(into, FULL);
      break;
    case 'group':
      if (!n.look) charsOf(n.body, into);
      break;
    case 'alt':
      for (const b of n.branches) charsOf(b, into);
      break;
    case 'seq':
      for (const it of n.items) charsOf(it, into);
      break;
    case 'quant':
      if (n.max > 0) charsOf(n.child, into);
      break;
  }
  return into;
}

/** Can the node match without consuming anything? */
function canBeEmpty(n: Node): boolean {
  switch (n.k) {
    case 'atom':
      return false;
    case 'zero':
    case 'backref':
      return true;
    case 'group':
      return n.look || canBeEmpty(n.body);
    case 'alt':
      return n.branches.some(canBeEmpty);
    case 'seq':
      return n.items.every(canBeEmpty);
    case 'quant':
      return n.min === 0 || canBeEmpty(n.child);
  }
}

/** Does every match of the node consume at least one character outside `s`? */
function mustConsumeOutside(n: Node, s: CharSet): boolean {
  switch (n.k) {
    case 'atom':
      return !overlaps(n.set, s);
    case 'zero':
    case 'backref':
      return false;
    case 'group':
      return !n.look && mustConsumeOutside(n.body, s);
    case 'alt':
      return n.branches.every((b) => mustConsumeOutside(b, s));
    case 'seq':
      return n.items.some((it) => mustConsumeOutside(it, s));
    case 'quant':
      return n.min >= 1 && mustConsumeOutside(n.child, s);
  }
}

const isVariableRepeat = (n: Node): n is Extract<Node, { k: 'quant' }> => n.k === 'quant' && n.max > 1 && n.min !== n.max;
const isUnbounded = (n: Node): boolean => n.k === 'quant' && n.max === Infinity;

function* walk(n: Node): Generator<Node> {
  yield n;
  if (n.k === 'group') yield* walk(n.body);
  else if (n.k === 'alt') for (const b of n.branches) yield* walk(b);
  else if (n.k === 'seq') for (const it of n.items) yield* walk(it);
  else if (n.k === 'quant') yield* walk(n.child);
}

/** A branch that is one character class, possibly repeated: its character set. */
function singleCharBranch(n: Node): CharSet | null {
  let cur = n;
  while (true) {
    if (cur.k === 'seq' && cur.items.length === 1) cur = cur.items[0]!;
    else if (cur.k === 'group' && !cur.look) cur = cur.body;
    else if (cur.k === 'quant') cur = cur.child;
    else break;
  }
  return cur.k === 'atom' ? cur.set : null;
}

function analyse(root: Node): RegexPatternProblem | null {
  for (const n of walk(root)) {
    if (n.k === 'quant' && n.max > 1) {
      // A repeated body that holds a variable-length repeat, with nothing to pin where one
      // pass ends and the next begins: the input can be split exponentially many ways.
      for (const inner of walk(n.child)) {
        if (!isVariableRepeat(inner)) continue;
        if (!mustConsumeOutside(n.child, charsOf(inner.child))) return 'nestedQuantifier';
      }
      for (const inner of walk(n.child)) {
        if (inner.k !== 'alt') continue;
        const seen = new Set<string>();
        for (const src of inner.srcs) {
          if (seen.has(src)) return 'overlappingAlternation';
          seen.add(src);
        }
        const singles = inner.branches.map(singleCharBranch);
        for (let a = 0; a < singles.length; a++) {
          for (let b = a + 1; b < singles.length; b++) {
            if (singles[a] && singles[b] && overlaps(singles[a]!, singles[b]!)) return 'overlappingAlternation';
          }
        }
      }
    }
    if (n.k === 'seq') {
      // ".*.*", "\s*\s+": two unbounded repeats that can trade the same characters.
      for (let a = 0; a < n.items.length; a++) {
        const first = n.items[a]!;
        if (!isUnbounded(first)) continue;
        const firstSet = charsOf(first);
        for (let b = a + 1; b < n.items.length; b++) {
          const next = n.items[b]!;
          if (isUnbounded(next) && overlaps(firstSet, charsOf(next))) return 'adjacentQuantifiers';
          if (!canBeEmpty(next)) break;
        }
      }
    }
  }
  return null;
}

/**
 * Why a pattern is refused, or null when it is acceptable. `flags` are the flags it will be
 * compiled with (only `i`, `u`, `v` and `s` matter for the check).
 */
export function regexPatternProblem(pattern: string, flags = ''): RegexPatternProblem | null {
  if (pattern.length === 0) return 'empty';
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return 'tooLong';
  try {
    new RegExp(pattern, flags.replace(/[gyd]/g, ''));
  } catch {
    return 'invalid';
  }
  try {
    return analyse(new Parser(pattern, flags).parse());
  } catch {
    // The engine accepted it but the checker could not follow it: refuse rather than guess.
    return 'invalid';
  }
}

export function isSafeRegexPattern(pattern: string, flags = ''): boolean {
  return regexPatternProblem(pattern, flags) === null;
}

// ---------------------------------------------------------------------------------------
// Match-time guard for patterns stored before the check existed

type UnsafePatternListener = (info: { pattern: string; problem: RegexPatternProblem; where: string }) => void;

let unsafeListener: UnsafePatternListener = ({ pattern, problem, where }) => {
  console.warn(`[arclight] ${where}: regex disabled, ${describeRegexProblem(problem)}: ${pattern.slice(0, 120)}`);
};

/** Route "stored pattern disabled" warnings to the app's logger (default: console.warn). */
export function setUnsafeRegexListener(listener: UnsafePatternListener): void {
  unsafeListener = listener;
}

/**
 * Report a stored pattern that is skipped at match time. Callers report once per pattern
 * (their compile cache remembers the verdict).
 */
export function reportUnsafeRegex(pattern: string, problem: RegexPatternProblem, where: string): void {
  try {
    unsafeListener({ pattern, problem, where });
  } catch {
    // A broken logger must not break matching.
  }
}

/** A small least-recently-used map for compiled patterns, so caches cannot grow without bound. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
