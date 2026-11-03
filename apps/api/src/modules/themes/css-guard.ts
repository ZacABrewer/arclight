// A second, stricter look at a pack's theme.css before it is offered (sync and start-up both go
// through readPack). Packs can come from a configurable remote catalogue, so the stylesheet is
// treated as hostile: CSS cannot run script, but attribute selectors plus a background url() can
// leak what is typed into inputs, one request per guessed character, to whoever runs the URL.
// checkThemeCss (packages/shared) already refuses @import, escapes and url()s that are not the
// pack's own files; this guard closes what a regex over complete `url(...)` tokens cannot see:
//   - every `url(` must be a complete, well-formed token (an unterminated `url(https://…` at the
//     end of the file is still a URL to the browser);
//   - its target must be one of the pack's own files, i.e. a relative `fonts/…` / `images/…`
//     path served from the API origin (never absolute, protocol-relative, data: or another host);
//   - no other function that can load an image by URL string (image(), cross-fade(), element()).
// Packs that fail are refused whole, like every other theme.css problem.

const FETCHING_FUNCTIONS = /(?<![\w-])(-webkit-|-moz-)?(image|cross-fade|element)\(/i;

/** Problems with how theme.css references other resources; empty when it only uses its own files. */
export function externalReferenceProblems(css: string, assets: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\*/.test(text)) problems.push('unterminated comment');
  if (/@import/i.test(text)) problems.push('@import is not allowed');
  if (FETCHING_FUNCTIONS.test(text)) problems.push('image(), cross-fade() and element() are not allowed');
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('url('); at >= 0; at = lower.indexOf('url(', at + 4)) {
    const ref = readUrl(text, at + 4);
    if (ref === null) problems.push('a url() is not closed');
    else if (!assets.has(ref)) problems.push(`url(${ref.slice(0, 80)}) is not one of the pack's fonts or images`);
  }
  return problems;
}

/** The target of the url() whose argument starts at `i`, or null when the token is malformed. */
function readUrl(text: string, i: number): string | null {
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (ws(text[i])) i++;
  let value = '';
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, i + 1);
    if (end < 0) return null;
    value = text.slice(i + 1, end);
    if (/[\n\r\f\\]/.test(value)) return null;
    i = end + 1;
  } else {
    const start = i;
    while (i < text.length && text[i] !== ')' && !ws(text[i])) {
      if (text[i] === '"' || text[i] === "'" || text[i] === '(' || text[i] === '\\') return null;
      i++;
    }
    value = text.slice(start, i);
  }
  while (ws(text[i])) i++;
  return text[i] === ')' ? value : null;
}
