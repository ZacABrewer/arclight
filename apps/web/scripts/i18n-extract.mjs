#!/usr/bin/env node
// i18n extraction codemod: moves user-facing strings in src/ into src/i18n/locales/en.json
// and rewrites them as t('namespace.key') calls. Uses the TypeScript compiler API (already a
// dev dependency) to find strings by syntactic position, not by regex over source text.
//
//   node scripts/i18n-extract.mjs --dry     report what would change (scratch/i18n-report.json)
//   node scripts/i18n-extract.mjs           rewrite files and merge keys into en.json
//   node scripts/i18n-extract.mjs path/a.tsx path/b.ts   limit to some files
//
// What counts as user-facing:
//   - JSX text (adjacent text + simple {expressions} become one message with params)
//   - string/template values of JSX attributes and object properties with label-like names
//     (label, title, placeholder, aria-label, caption, description, ...Label, ...Title, ...)
//   - values of objects held in label-like containers (KIND_LABELS = { movie: 'Movie' })
//   - sentence-like strings in value positions elsewhere (returns, assignments, Error/confirm
//     and setX(...) arguments)
// `x === 1 ? 'file' : 'files'` inside a message becomes an ICU plural. Strings at module
// scope are made lazy by turning their property into a getter (`get label() { return t(..) }`)
// so a locale switch re-reads them. A line containing `i18n-ignore` (or the line above it)
// is skipped. The script is a bulk tool: review its output by hand.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const EN = path.join(SRC, 'i18n', 'locales', 'en.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));

// Files that are not UI copy: tests, the i18n layer itself, the canonical status vocabulary
// (tokens.ts), the design-system gallery (a dev reference page), and boot code.
const EXCLUDE = [
  /\.test\.tsx?$/,
  /\.d\.ts$/,
  /^test\//,
  /^i18n\//,
  /^arclight\/tokens\.ts$/,
  /^arclight\/gallery\.tsx$/,
  /^pages\/design\.tsx$/,
  /^main\.tsx$/,
  /^register-sw\.ts$/,
  /^arclight\/fonts\.ts$/,
  /test-utils\.tsx?$/,
  /fixtures?\//,
  /(^|\/)test-[\w-]+\.tsx?$/,
];

const TONE_WORDS = new Set(['default', 'accent', 'neutral', 'muted', 'warn', 'danger', 'ok', 'info', 'success', 'primary', 'secondary', 'ghost', 'error', 'warning']);
const IGNORED_CONTAINER = /SAMPLE|EXAMPLE|FIXTURE|DEMO|MOCK|PATHS|ICONS/i;

const STATUS = {
  Downloaded: 'downloaded',
  Downloading: 'downloading',
  Importing: 'importing',
  Monitored: 'monitored',
  Unmonitored: 'unmonitored',
  Unaired: 'unaired',
  Queued: 'queued',
  Paused: 'paused',
  'Waiting for air date': 'waiting',
  Missing: 'missing',
  'Cutoff unmet': 'cutoffUnmet',
  Stalled: 'stalled',
  Failed: 'failed',
};

// ---------------------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------------------

const STRONG_NAME =
  /^(header|meta|sub|fallback|aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|alt|title|label|placeholder|caption|description|heading|subtitle|tooltip|hint|help|helpText|legend|summary|text|message|body|cause|fix|fixes|reason|note|notes|detail|prompt|confirm|empty|lead|intro|headline|warning|explanation|blurb|steps|tip|tips|why|what|how)$|(Label|Title|Text|Caption|Message|Hint|Description|Placeholder|Heading|Tooltip|Help|Summary|Prompt|Copy|Labels|Titles|Hints|Messages|Note|Notes|Reason|Warning|Lead|Body|Detail|Explanation|Blurb)$/;
const EXCLUDED_NAME =
  /^(className|class|key|id|href|to|from|path|url|src|queryKey|mutationKey|method|type|kind|mode|variant|tone|icon|format|pattern|role|testId|htmlFor|rel|target|autoComplete|inputMode|accept|style|size|align|dir|lang|encType|as|level|unit|anchor|rail|code|value|defaultValue|field|sortKey|column|accessor|name|slug|search|hash|params|query|status|state|event|action|source|sources|category|protocol|implementation|scope|permission|permissions|token|cookie|storageKey|data-[\w-]+|[\w]*Class|[\w]*ClassName|[\w]*Id|[\w]*Ids|[\w]*Key|[\w]*Path|[\w]*Url|[\w]*Href|[\w]*Route|[\w]*Pattern|[\w]*Regex|[\w]*Format)$/;
const LABEL_CONTAINER = /(LABELS?|TITLES?|TEXTS?|COPY|MESSAGES?|CAPTIONS?|HINTS?|DESCRIPTIONS?|NAMES|HELP|Labels?|Titles?|Texts|Copy|Messages?|Captions?|Hints?|Descriptions?|Names|Help)$/;
const ALLOWED_CALLEE = /^(Error|TypeError|RangeError|confirm|alert|prompt|push|notify|toast|fail|reject|error|warn|warning|info|success|set[A-Z]\w*|[a-z]\w*Error)$/;
const LABELISH_FUNCTION = /(label|title|text|caption|message|describe|description|summary|reason|hint|copy|headline|explain|cause|word|phrase|sentence|blurb|note|verb|noun|tooltip|heading|subtitle|empty)/i;
const SKIP_TAGS = new Set(['code', 'kbd', 'pre', 'samp', 'style', 'script']);

function hasLetter(s) {
  return /[A-Za-z]/.test(s);
}

function looksLikeCode(raw) {
  const s = raw.trim();
  if (!s) return true;
  if (/^[Mm][\d\s.,-]/.test(s) && /^[MmLlHhVvCcSsQqTtAaZz\d\s.,-]+$/.test(s)) return true; // SVG path
  if (/^(https?:|mailto:|\/\/|data:)/.test(s) || s.includes('://')) return true;
  if (/^(SELECT|INSERT|UPDATE|DELETE)\s/.test(s)) return true;
  if (!/\s/.test(s)) {
    if (/^[\/\\~]|^\.\.?[\/\\]/.test(s)) return true;
    if (/^[A-Za-z]:[\\/]/.test(s)) return true;
    if (/[=<>{}\[\]\\|^`$]/.test(s)) return true;
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return true; // camelCase
    if (/^[a-z0-9]+([-_.][a-z0-9]+)+$/.test(s)) return true; // kebab / snake / dotted
    if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(s)) return true; // CONST_CASE
    if (/^[\w-]+\.(json|ya?ml|xml|txt|log|db|sqlite|zip|tar|gz|ts|tsx|js|css|html|nfo|srt|ass|mkv|mp4|torrent|nzb|ics)$/i.test(s)) return true;
    if (/^#[\w-]+$/.test(s)) return true;
    if (/^\w+:\S/.test(s)) return true;
    if (/^[\d.,:%x×+\-]+[a-z]{0,3}$/i.test(s) && /\d/.test(s)) return true;
    if (/^[YMDHhmsAa]{1,4}([-\/: .][YMDHhmsAa]{1,4})+$/.test(s)) return true; // date pattern
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(s)) return true;
    if (/^[a-z]{2,3}(-[A-Z]{2})?$/.test(s) && s.length <= 3 + 3 && /-/.test(s)) return true; // en-US
    if (/^[a-z0-9]+(,[a-z0-9]+)+$/.test(s)) return true; // srt,nfo
    if (/var\(--|^[a-z-]+\(/.test(s)) return true; // css functions
  } else {
    const tokens = s.split(/\s+/);
    if (tokens.every((tk) => /^[a-z0-9_:\/\[\].-]+$/.test(tk)) && tokens.some((tk) => /[-_:]/.test(tk) && !/^[-–]$/.test(tk))) return true; // class list
    if (tokens.every((tk) => /^[YMDHhmsAa]{1,4}[-\/:.,]?$/.test(tk))) return true; // "D MMM YYYY"
    if (/^[A-Za-z_][\w.-]*\s*(=|:=|=>)\s*\S*$/.test(s) && !/^[A-Z][a-z]/.test(s)) return true;
  }
  return false;
}

function words(s) {
  return s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
}

/** A sentence: ≥3 words, starts with a capital (or quote/digit), has lowercase. */
function isSentence(s) {
  const t = s.trim();
  return !looksLikeCode(t) && words(t).length >= 3 && /^[A-Z"'“0-9(]/.test(t) && /[a-z]/.test(t);
}

/** Prose: ≥2 words, capitalised or ending in sentence punctuation. */
function isProse(s) {
  const t = s.trim();
  if (looksLikeCode(t) || !/[a-z]/.test(t)) return false;
  const n = words(t).length;
  return n >= 2 && (/^[A-Z"'“(]/.test(t) || /[.!?…:]$/.test(t));
}

/** Anything textual (strong contexts). */
function isText(s) {
  return hasLetter(s) && !looksLikeCode(s);
}

// ---------------------------------------------------------------------------------------
// Namespaces and keys
// ---------------------------------------------------------------------------------------

const camel = (s) =>
  s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

export function namespaceOf(rel) {
  const parts = rel.replace(/\.(tsx?|mjs)$/, '').split('/');
  if (parts[0] === 'pages') parts.shift();
  if (parts[0] === 'arclight' && parts[1] === 'components') parts.splice(1, 1);
  let stem = parts.pop();
  stem = stem.replace(/(-page|-model|-data|-section-model)$/, '');
  const dir = parts[parts.length - 1];
  if (dir && stem.toLowerCase() === dir.toLowerCase()) stem = '';
  else if (dir && stem.toLowerCase().startsWith(`${dir.toLowerCase()}-`)) stem = stem.slice(dir.length + 1);
  if (stem === 'index') stem = parts.length ? '' : 'index';
  const segs = [...parts, stem].filter(Boolean).map(camel);
  return segs.join('.') || 'app';
}

function closeBrace(str, from) {
  let depth = 0;
  for (let j = from; j < str.length; j++) {
    if (str[j] === '{') depth++;
    else if (str[j] === '}' && --depth === 0) return j;
  }
  return str.length;
}

/** Plain text of an ICU-lite message: placeholders become their name, plurals their `other` branch. */
function icuText(m) {
  let out = '';
  let i = 0;
  while (i < m.length) {
    if (m[i] === "'" && m[i + 2] === "'" && '{}#'.includes(m[i + 1])) {
      i += 3;
      continue;
    }
    if (m[i] === '{') {
      const j = closeBrace(m, i);
      const body = m.slice(i + 1, j);
      const parts = body.split(',');
      if (parts.length >= 3 && /plural|select/.test(parts[1])) {
        const k = body.indexOf('other {');
        if (k >= 0) out += ` ${icuText(body.slice(k + 7, closeBrace(body, k + 6))).replace(/#/g, ' ')} `;
      } else out += ` ${parts[0].trim()} `;
      i = j + 1;
      continue;
    }
    out += m[i++];
  }
  return out;
}

function leafOf(message) {
  const ws = icuText(message)
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/'/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5);
  let leaf = camel(ws.join(' ').toLowerCase());
  if (!leaf) leaf = 'text';
  if (/^\d/.test(leaf)) leaf = `n${leaf}`;
  return leaf.slice(0, 48);
}

// ---------------------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  let bad = false;
  const out = s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    if (e in ENTITIES) return ENTITIES[e];
    bad = true;
    return m;
  });
  return bad ? null : out;
}

/** Babel's JSX whitespace rule (cleanJSXElementLiteralChild). */
function cleanJsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) lastNonEmpty = i;
  });
  let str = '';
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, ' ');
    if (i !== 0) t = t.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) t = t.replace(/[ ]+$/, '');
    if (t) {
      if (i !== lastNonEmpty) t += ' ';
      str += t;
    }
  });
  return str;
}

const escapeLiteral = (s, inPlural = false) => {
  let out = s.replace(/[{}]/g, (c) => `'${c}'`);
  if (inPlural) out = out.replace(/#/g, "'#'");
  return out;
};

function paramName(expr) {
  let e = expr;
  while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const n = e.name.text;
    if (n === 'length' || n === 'size') {
      const base = paramName(e.expression);
      return base === 'value' ? 'count' : `${base}Count`;
    }
    return n;
  }
  if (ts.isCallExpression(e)) {
    const c = e.expression;
    let n = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : 'value';
    if (['String', 'Number', 'toFixed', 'toLocaleString', 'toString', 'trim', 'join', 'toUpperCase', 'toLowerCase', 'round', 'floor', 'ceil', 'abs', 'max', 'min'].includes(n)) {
      const inner = ts.isPropertyAccessExpression(c) && n !== 'max' && n !== 'min' && n !== 'round' && n !== 'floor' && n !== 'ceil' && n !== 'abs' ? c.expression : e.arguments[0];
      return inner ? paramName(inner) : 'value';
    }
    n = n.replace(/^(format|get|to|use|render)(?=[A-Z])/, '');
    return n.charAt(0).toLowerCase() + n.slice(1);
  }
  if (ts.isTemplateExpression(e)) return 'value';
  return 'value';
}

/** `n === 1 ? 'file' : 'files'` → { count: n, one, other }. */
function pluralOf(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return null;
  let c = e.condition;
  while (ts.isParenthesizedExpression(c)) c = c.expression;
  if (!ts.isBinaryExpression(c)) return null;
  const op = c.operatorToken.kind;
  const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const gt = op === ts.SyntaxKind.GreaterThanToken; // n > 1 ? 'files' : 'file'
  if (!eq && !ne && !gt) return null;
  const isOne = (n) => ts.isNumericLiteral(n) && n.text === '1';
  const counted = isOne(c.right) ? c.left : isOne(c.left) && !gt ? c.right : null;
  if (!counted) return null;
  const lit = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null);
  const a = lit(e.whenTrue);
  const b = lit(e.whenFalse);
  if (a === null || b === null) return null;
  return eq ? { counted, one: a, other: b } : { counted, one: b, other: a };
}

/** The literal text of message parts; plural expressions count as their other branch. */
function textOf(parts, sep) {
  return parts.map((p) => ('lit' in p ? p.lit : (pluralOf(p.expr)?.other ?? sep))).join('');
}

// ---------------------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------------------

function isFunctionLike(n) {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isPropertyDeclaration(n) ||
    ts.isClassStaticBlockDeclaration(n)
  );
}

// Callbacks these run immediately, so at module scope their body still runs at import time.
const IMMEDIATE = new Set(['map', 'flatMap', 'filter', 'from', 'forEach', 'reduce', 'some', 'every', 'find', 'sort', 'fromEntries']);

function deferred(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (!isFunctionLike(p)) continue;
    const call = p.parent;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && call && ts.isCallExpression(call) && call.arguments.includes(p)) {
      const c = call.expression;
      const n = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
      if (IMMEDIATE.has(n)) continue;
    }
    return true;
  }
  return false;
}

function propName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function jsxAttrName(attr) {
  return attr.name.getText();
}

function exprName(e) {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return exprName(e.expression);
  return null;
}

/** Name of the variable/property an object or array literal is stored in. */
function containerName(lit) {
  let n = lit;
  for (;;) {
    const p = n.parent;
    if (!p) return null;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isArrayLiteralExpression(p) || ts.isTypeAssertionExpression(p)) {
      n = p;
      continue;
    }
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'freeze') {
      n = p;
      continue;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p)) return propName(p.name);
    return null;
  }
}

function functionNameOf(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p)) return propName(p.name);
  return null;
}

/**
 * Where a string value ends up. Walks up through transparent wrappers (parens, ?:, ||, ??,
 * arrays, `as`, template spans) to the node that consumes it.
 */
function valueContext(node) {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (!p) return null;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p)) {
      n = p;
      continue;
    }
    if (ts.isConditionalExpression(p)) {
      if (p.condition === n) return null;
      n = p;
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if ((k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) && p.right === n) {
        n = p;
        continue;
      }
      if (k === ts.SyntaxKind.EqualsToken && p.right === n) {
        return { kind: 'assign', name: exprName(p.left) };
      }
      if (k === ts.SyntaxKind.BarBarEqualsToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken) return { kind: 'assign', name: exprName(p.left) };
      return null;
    }
    if (ts.isArrayLiteralExpression(p)) {
      n = p;
      continue;
    }
    if (ts.isTemplateSpan(p)) {
      // Strings inside a template's ${} are handled with the template (plural detection);
      // anything else there stays a param expression with its own context.
      return { kind: 'span', template: p.parent };
    }
    if (ts.isJsxExpression(p)) {
      const pp = p.parent;
      if (ts.isJsxAttribute(pp)) return { kind: 'attr', name: jsxAttrName(pp), attr: pp };
      if (ts.isJsxElement(pp) || ts.isJsxFragment(pp)) return { kind: 'jsx-child' };
      return null;
    }
    if (ts.isJsxAttribute(p)) return { kind: 'attr', name: jsxAttrName(p), attr: p, direct: true };
    if (ts.isPropertyAssignment(p) && p.initializer === n) {
      const obj = p.parent;
      return { kind: 'prop', name: propName(p.name), container: ts.isObjectLiteralExpression(obj) ? containerName(obj) : null, pa: p };
    }
    if (ts.isVariableDeclaration(p) && p.initializer === n) return { kind: 'var', name: ts.isIdentifier(p.name) ? p.name.text : null, decl: p };
    if (ts.isReturnStatement(p)) {
      let f = p.parent;
      while (f && !isFunctionLike(f)) f = f.parent;
      return { kind: 'return', name: f ? functionNameOf(f) : null };
    }
    if (ts.isArrowFunction(p) && p.body === n) return { kind: 'return', name: functionNameOf(p) };
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n)) {
      const c = p.expression;
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'console') return null;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
      return { kind: 'call', name, isNew: ts.isNewExpression(p) };
    }
    if ((ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === n) return { kind: 'param', name: ts.isIdentifier(p.name) ? p.name.text : null };
    if (ts.isPropertyDeclaration(p) && p.initializer === n) return { kind: 'prop', name: propName(p.name), container: null, pa: null };
    return null;
  }
}

/** Decide whether a string with this context is UI copy. */
function wanted(text, ctx) {
  if (!ctx || !hasLetter(text)) return false;
  if (TONE_WORDS.has(text)) return false;
  if (ctx.container && IGNORED_CONTAINER.test(ctx.container)) return false;
  switch (ctx.kind) {
    case 'jsx-child':
      return isText(text);
    case 'attr':
      if (ctx.name === 'className' || ctx.name === 'key' || ctx.name.startsWith('data-')) return false;
      if (STRONG_NAME.test(ctx.name)) return isText(text);
      if (EXCLUDED_NAME.test(ctx.name)) return isSentence(text);
      return isProse(text);
    case 'prop': {
      const name = ctx.name ?? '';
      if (name && EXCLUDED_NAME.test(name) && !STRONG_NAME.test(name)) return isSentence(text);
      if (STRONG_NAME.test(name)) return isText(text);
      if (ctx.container && LABEL_CONTAINER.test(ctx.container)) return isText(text);
      return isProse(text);
    }
    case 'var':
    case 'assign':
    case 'param': {
      const name = ctx.name ?? '';
      if (name && EXCLUDED_NAME.test(name) && !STRONG_NAME.test(name)) return isSentence(text);
      if (STRONG_NAME.test(name) || /^(error|err|msg|title|label|caption|hint)$/i.test(name)) return isText(text) && (words(text).length > 1 || /^[A-Z]/.test(text));
      return isProse(text);
    }
    case 'return':
      if (ctx.name && /tone|variant|kind|class|color|colour|icon|attr|level|severity|mode/i.test(ctx.name)) return false;
      if (ctx.name && LABELISH_FUNCTION.test(ctx.name)) return isText(text) && (words(text).length > 1 || /^[A-Z]/.test(text.trim()));
      return isProse(text);
    case 'call':
      if (!ctx.name || !ALLOWED_CALLEE.test(ctx.name)) return false;
      return isProse(text) || (/^set[A-Z]/.test(ctx.name) && STRONG_NAME.test(ctx.name.slice(3)) && isText(text));
    default:
      return false;
  }
}

function lineIgnored(sf, node) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split('\n');
  return /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
}

function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function tagName(el) {
  if (ts.isJsxElement(el)) return el.openingElement.tagName.getText();
  return '';
}

function declaresT(sf) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isImportSpecifier(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === 't') {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Analyse one file. Returns edits whose `produce(keyOf)` builds replacement text; `keyOf`
 * maps a (namespace, message) pair to its key, so the caller can assign keys globally.
 */
let program;
let checker;
function loadProgram() {
  const cfg = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  program = ts.createProgram(parsed.fileNames, parsed.options);
  checker = program.getTypeChecker();
}

/** True when an expression renders as text (string/number/boolean/null), per the checker. */
function rendersAsText(expr) {
  const F = ts.TypeFlags;
  const ok = (t) => (t.isUnion() ? t.types.every(ok) : Boolean(t.flags & (F.StringLike | F.NumberLike | F.BooleanLike | F.Null | F.Undefined | F.Void | F.BigIntLike | F.Never)));
  return ok(checker.getTypeAtLocation(expr));
}

function analyse(file) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const sf = program.getSourceFile(file.split(path.sep).join('/')) ?? program.getSourceFile(file);
  if (!sf) throw new Error(`not in program: ${file}`);
  const text = sf.text;
  const ns = namespaceOf(rel);
  const tName = declaresT(sf) ? 'tr' : 't';
  const edits = [];
  const skipped = [];
  const consumed = new Set(); // string nodes handled by a parent edit (plural branches)
  const getters = new Map(); // PropertyAssignment → edit

  const render = (start, end, keyOf) => {
    // Apply the outermost edits inside [start, end).
    const inner = edits.filter((e) => e.start >= start && e.end <= end && !(e.start === start && e.end === end && e.wrapper === undefined && false));
    const top = inner.filter((e) => !inner.some((o) => o !== e && o.start <= e.start && o.end >= e.end && (o.start < e.start || o.end > e.end || o.rank > e.rank)));
    top.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = start;
    for (const e of top) {
      if (e.start < pos) continue;
      out += text.slice(pos, e.start) + e.produce(keyOf);
      pos = e.end;
    }
    return out + text.slice(pos, end);
  };

  /** Message + params from a list of parts: {lit} text or {expr} expression. */
  const buildMessage = (parts, keyOf) => {
    const params = []; // { name, code, exprText }
    let msg = '';
    const nameFor = (expr) => {
      const exprText = expr.getText(sf);
      const hit = params.find((p) => p.exprText === exprText);
      if (hit) return hit.name;
      let name = paramName(expr);
      let i = 2;
      const base = name;
      while (params.some((p) => p.name === name)) name = `${base}${i++}`;
      params.push({ name, exprText, code: render(expr.getStart(sf), expr.getEnd(), keyOf) });
      return name;
    };
    for (const part of parts) {
      if ('lit' in part) {
        msg += escapeLiteral(part.lit);
        continue;
      }
      const pl = pluralOf(part.expr);
      if (pl) {
        const name = nameFor(pl.counted);
        let one = pl.one;
        let other = pl.other;
        // "release${n === 1 ? '' : 's'}" → one {release} other {releases}
        const stem = /([A-Za-z]+)$/.exec(msg);
        if (stem && !msg.endsWith("'")) {
          msg = msg.slice(0, -stem[1].length);
          one = stem[1] + one;
          other = stem[1] + other;
        }
        let pound = '';
        const lead = `{${name}} `;
        if (msg.endsWith(lead)) {
          msg = msg.slice(0, -lead.length);
          pound = '# ';
        }
        msg += `{${name}, plural, one {${pound}${escapeLiteral(one, true)}} other {${pound}${escapeLiteral(other, true)}}}`;
        continue;
      }
      msg += `{${nameFor(part.expr)}}`;
    }
    return { msg, params };
  };

  const callText = (key, params) => {
    if (!params.length) return `${tName}('${key}')`;
    const body = params.map((p) => (p.code.trim() === p.name ? p.name : `${p.name}: ${p.code.trim()}`)).join(', ');
    return `${tName}('${key}', { ${body} })`;
  };

  const ensureLazy = (node) => {
    // Module scope: make the nearest property a getter so the text is read at render time.
    if (deferred(node)) return true;
    let pa = null;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isPropertyAssignment(p)) {
        pa = p;
        break;
      }
    }
    if (!pa || !propName(pa.name)) return false;
    if (!getters.has(pa)) {
      const init = pa.initializer;
      const nameText = pa.name.getText(sf);
      const edit = {
        start: pa.getStart(sf),
        end: pa.getEnd(),
        rank: 2,
        produce: (keyOf) => {
          const body = render(init.getStart(sf), init.getEnd(), keyOf);
          const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
          const obj = pa.parent;
          if (line(obj.getStart(sf)) === line(obj.getEnd()) && !body.includes('\n')) return `get ${nameText}() { return ${body}; }`;
          const ind = ' '.repeat(sf.getLineAndCharacterOfPosition(pa.getStart(sf)).character);
          return `get ${nameText}() {\n${ind}  return ${body};\n${ind}}`;
        },
      };
      getters.set(pa, edit);
      edits.push(edit);
    }
    return true;
  };

  const addMessage = (node, start, end, parts, wrapBraces, kind) => {
    if (lineIgnored(sf, node)) return;
    if (!ensureLazy(node)) {
      skipped.push({ file: rel, line: sf.getLineAndCharacterOfPosition(start).line + 1, text: parts.map((p) => ('lit' in p ? p.lit : '${…}')).join(''), why: 'module-level constant' });
      return;
    }
    edits.push({
      start,
      end,
      rank: 1,
      kind,
      produce: (keyOf) => {
        const { msg, params } = buildMessage(parts, keyOf);
        const key = keyOf(ns, msg, rel, kind);
        const call = callText(key, params);
        return wrapBraces ? `{${call}}` : call;
      },
      preview: () => buildMessage(parts, () => 'x').msg,
    });
  };

  const visit = (node) => {
    // JSX children runs.
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const tag = tagName(node);
      if (!SKIP_TAGS.has(tag)) {
        let run = [];
        const flush = () => {
          const r = run;
          run = [];
          if (!r.some((c) => (ts.isJsxText(c) && hasLetter(cleanJsxText(c.text))) || (ts.isJsxExpression(c) && pluralOf(c.expression)))) return;
          const parts = [];
          for (const c of r) {
            if (ts.isJsxText(c)) {
              const dec = decodeEntities(cleanJsxText(c.getFullText(sf)));
              if (dec === null) return skipped.push({ file: rel, text: c.text.trim(), why: 'unknown HTML entity' });
              parts.push({ lit: dec });
            } else {
              const e = c.expression;
              if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
                consumed.add(e);
                parts.push({ lit: e.text });
              } else {
                const pl = pluralOf(e);
                if (pl) {
                  consumed.add(e.whenTrue ?? pl);
                  let x = e;
                  while (ts.isParenthesizedExpression(x)) x = x.expression;
                  consumed.add(x.whenTrue);
                  consumed.add(x.whenFalse);
                }
                parts.push({ expr: e });
              }
            }
          }
          // Trim edges: whitespace outside the edit stays in the source with JSX semantics.
          while (parts.length && 'lit' in parts[0] && !parts[0].lit.trim()) parts.shift();
          while (parts.length && 'lit' in parts[parts.length - 1] && !parts[parts.length - 1].lit.trim()) parts.pop();
          if (!parts.length) return;
          if ('lit' in parts[0]) parts[0] = { lit: parts[0].lit.replace(/^\s+/, '') };
          const lastI = parts.length - 1;
          if ('lit' in parts[lastI]) parts[lastI] = { lit: parts[lastI].lit.replace(/\s+$/, '') };
          const litOnly = textOf(parts, ' ');
          if (looksLikeCode(litOnly) || !hasLetter(litOnly)) return;
          // Source range: first..last non-whitespace character of the run.
          const full = text.slice(r[0].getStart(sf), r[r.length - 1].getEnd());
          const base = r[0].getStart(sf);
          const lead = full.length - full.replace(/^\s+/, '').length;
          const trail = full.length - full.replace(/\s+$/, '').length;
          addMessage(r[0], base + lead, base + full.length - trail, parts, true, 'jsx');
        };
        for (const c of node.children) {
          if (ts.isJsxText(c)) run.push(c);
          else if (ts.isJsxExpression(c) && c.expression && !containsJsx(c.expression) && !ts.isSpreadElement(c.expression) && rendersAsText(c.expression)) run.push(c);
          else flush();
        }
        flush();
      }
    }

    // String literals in value positions.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !consumed.has(node)) {
      const ctx = valueContext(node);
      if (ctx && ctx.kind !== 'span' && !(ctx.kind === 'jsx-child' && insideRun(node))) {
        let value = node.text;
        if (ctx.kind === 'attr' && ctx.direct) value = decodeEntities(value) ?? value;
        if (wanted(value, ctx) && !isTCall(node)) {
          addMessage(node, node.getStart(sf), node.getEnd(), [{ lit: value }], ctx.kind === 'attr' && ctx.direct, `string:${ctx.kind}:${ctx.name ?? ''}`);
        }
      }
    }

    // Template literals in value positions.
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      const ctx = valueContext(node);
      const parts = [{ lit: node.head.text }];
      for (const span of node.templateSpans) {
        parts.push({ expr: span.expression });
        parts.push({ lit: span.literal.text });
      }
      const litOnly = textOf(parts, 'x');
      if (ctx && ctx.kind !== 'span' && !(ctx.kind === 'jsx-child' && insideRun(node)) && hasLetter(textOf(parts, '')) && wanted(litOnly, ctx) && !isTCall(node)) {
        for (const span of node.templateSpans) {
          const pl = pluralOf(span.expression);
          if (pl) {
            let x = span.expression;
            while (ts.isParenthesizedExpression(x)) x = x.expression;
            consumed.add(x.whenTrue);
            consumed.add(x.whenFalse);
          }
        }
        addMessage(node, node.getStart(sf), node.getEnd(), parts.filter((p) => !('lit' in p) || p.lit !== ''), false, `template:${ctx.kind}:${ctx.name ?? ''}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  // A string that is a direct JSX child expression inside a text run is part of that run.
  const insideRun = (node) => {
    const je = node.parent;
    if (!je || !ts.isJsxExpression(je) || je.expression !== node) return false;
    const parent = je.parent;
    if (!(ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return false;
    const idx = parent.children.indexOf(je);
    const isRunText = (c) => c && ts.isJsxText(c) && hasLetter(c.text);
    for (let i = idx - 1; i >= 0; i--) {
      const c = parent.children[i];
      if (isRunText(c)) return true;
      if (!(ts.isJsxText(c) || (ts.isJsxExpression(c) && c.expression && !containsJsx(c.expression) && rendersAsText(c.expression)))) break;
    }
    for (let i = idx + 1; i < parent.children.length; i++) {
      const c = parent.children[i];
      if (isRunText(c)) return true;
      if (!(ts.isJsxText(c) || (ts.isJsxExpression(c) && c.expression && !containsJsx(c.expression) && rendersAsText(c.expression)))) break;
    }
    return false;
  };

  const isTCall = (node) => {
    const p = node.parent;
    return p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && (p.expression.text === 't' || p.expression.text === 'tr');
  };

  visit(sf);

  const apply = (keyOf) => {
    if (!edits.some((e) => e.rank === 1)) return null;
    let out = render(0, text.length, keyOf);
    // Import t after the last import.
    const importPath = path.relative(path.dirname(file), path.join(SRC, 'i18n', 'index.js')).split(path.sep).join('/');
    const spec = importPath.startsWith('.') ? importPath : `./${importPath}`;
    const imp = tName === 't' ? `import { t } from '${spec}';` : `import { t as tr } from '${spec}';`;
    const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
    if (imports.length) {
      // Re-find the last import in the rewritten text (imports precede every edit).
      const last = imports[imports.length - 1];
      const endPos = last.getEnd();
      out = out.slice(0, endPos) + `\n${imp}` + out.slice(endPos);
    } else {
      const lead = /^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*\n))*/.exec(out)?.[0] ?? '';
      out = `${lead}${imp}\n${out.slice(lead.length)}`;
    }
    return out;
  };

  return { rel, file, ns, edits, skipped, apply };
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function main() {
  loadProgram();
  const files = (only.length ? only : walk(SRC)).filter((f) => {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    return !EXCLUDE.some((re) => re.test(rel));
  });
  const results = files.map(analyse);

  // Pass 1: collect messages per namespace.
  const seen = []; // { ns, msg, rel }
  for (const r of results) r.apply((ns, msg, rel, kind) => (seen.push({ ns, msg, rel, kind }), 'x'));

  // Assign keys: status vocabulary → status.*, short strings used in ≥3 files → common.*,
  // otherwise <namespace>.<leaf> with numeric suffixes for different text under one leaf.
  const filesByMsg = new Map();
  for (const s of seen) {
    if (!filesByMsg.has(s.msg)) filesByMsg.set(s.msg, new Set());
    filesByMsg.get(s.msg).add(s.rel);
  }
  const existing = fs.existsSync(EN) ? JSON.parse(fs.readFileSync(EN, 'utf8')) : {};
  const catalog = { ...existing };
  const byText = new Map(); // `${ns}\u0000${msg}` → key
  for (const [k, v] of Object.entries(existing)) {
    const ns = k.slice(0, k.lastIndexOf('.'));
    byText.set(`${ns}\u0000${v}`, k);
  }
  const keyOf = (ns, msg) => {
    let space = ns;
    if (Object.hasOwn(STATUS, msg)) return `status.${STATUS[msg]}`;
    const n = words(msg.replace(/\{[^}]*\}/g, 'x')).length;
    if (n <= 4 && !msg.includes('{') && (filesByMsg.get(msg)?.size ?? 0) >= 3) space = 'common';
    const id = `${space}\u0000${msg}`;
    const hit = byText.get(id);
    if (hit) return hit;
    const leaf = leafOf(msg);
    let key = `${space}.${leaf}`;
    let i = 2;
    while (key in catalog && catalog[key] !== msg) key = `${space}.${leaf}${i++}`;
    catalog[key] = msg;
    byText.set(id, key);
    return key;
  };
  for (const [label, k] of Object.entries(STATUS)) catalog[`status.${k}`] = label;

  const changed = [];
  const skipped = results.flatMap((r) => r.skipped);
  for (const r of results) {
    const out = r.apply(keyOf);
    if (out === null) continue;
    changed.push(r.rel);
    if (!DRY) fs.writeFileSync(r.file, out);
  }
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const report = { files: changed.length, keys: Object.keys(sorted).length, skipped, changed, seen };
  if (DRY) {
    const dest = path.join(ROOT, 'node_modules', '.i18n-report.json');
    fs.writeFileSync(dest, JSON.stringify({ ...report, catalog: sorted }, null, 2));
    console.log(`dry run: ${report.keys} keys from ${report.files} files, ${skipped.length} skipped → ${dest}`);
  } else {
    fs.writeFileSync(EN, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`extracted ${report.keys} keys; rewrote ${report.files} files; ${skipped.length} strings skipped`);
    for (const s of skipped) console.log(`  skipped ${s.file}${s.line ? `:${s.line}` : ''} (${s.why}): ${s.text}`);
  }
}

main();
