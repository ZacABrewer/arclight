import { describe, expect, it } from 'vitest';
import {
  SelectorSyntaxError,
  getAttribute,
  matches,
  parseHtml,
  querySelector,
  querySelectorAll,
  removeMatching,
  textContent,
  type HtmlElement,
} from './index.js';

const ids = (els: HtmlElement[]): string[] => els.map((e) => getAttribute(e, 'id') ?? e.tagName);

const DOC = parseHtml(`
<div id="root" class="wrap main">
  <ul id="list" lang="en-US">
    <li id="l1" class="item first" data-k="Alpha">one</li>
    <li id="l2" class="item">two <b id="b2">bold</b></li>
    <li id="l3" class="item special" data-k="alpha beta">three</li>
    <li id="l4" class="item last" data-k="gamma"></li>
  </ul>
  <p id="p1">Seeders: <span id="s1">12</span></p>
  <p id="p2" class="note">Leechers</p>
  <form id="f">
    <input id="i1" type="checkbox" checked>
    <input id="i2" type="text" disabled>
    <select id="sel"><option id="o1">a</option><option id="o2" selected>b</option></select>
  </form>
</div>`);

const q = (sel: string): string[] => ids(querySelectorAll(DOC, sel));

describe('basic selectors', () => {
  it('matches type, universal, id, class and compounds', () => {
    expect(q('li')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(q('LI')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(q('#l2')).toEqual(['l2']);
    expect(q('.item.special')).toEqual(['l3']);
    expect(q('li.item#l4.last')).toEqual(['l4']);
    expect(q('p.note')).toEqual(['p2']);
    expect(q('ul > *')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(querySelectorAll(DOC, '*').length).toBeGreaterThan(15);
  });

  it('class matching uses whitespace-separated tokens', () => {
    const doc = parseHtml('<a class="  foo\tbar-baz ">x</a><a class="foobar">y</a>');
    expect(querySelectorAll(doc, '.foo')).toHaveLength(1);
    expect(querySelectorAll(doc, '.bar-baz')).toHaveLength(1);
    expect(querySelectorAll(doc, '.bar')).toHaveLength(0);
  });

  it('supports escaped identifiers', () => {
    const doc = parseHtml('<div class="a:b">x</div><div id="1x">y</div>');
    expect(querySelectorAll(doc, '.a\\:b')).toHaveLength(1);
    expect(querySelectorAll(doc, '#\\31 x')).toHaveLength(1);
  });
});

describe('combinators', () => {
  it('descendant', () => expect(q('#root b')).toEqual(['b2']));
  it('child', () => {
    expect(q('#root > p')).toEqual(['p1', 'p2']);
    expect(q('#root > b')).toEqual([]);
  });
  it('adjacent sibling', () => expect(q('#l1 + li')).toEqual(['l2']));
  it('general sibling', () => expect(q('#l2 ~ li')).toEqual(['l3', 'l4']));
  it('chains of combinators backtrack correctly', () => {
    expect(q('div ul > li + li ~ li')).toEqual(['l3', 'l4']);
    expect(q('div li b')).toEqual(['b2']);
  });
});

describe('attribute selectors', () => {
  it('presence and equality, quoted or not', () => {
    expect(q('[data-k]')).toEqual(['l1', 'l3', 'l4']);
    expect(q('[data-k=gamma]')).toEqual(['l4']);
    expect(q('[data-k="alpha beta"]')).toEqual(['l3']);
    expect(q("[data-k='Alpha']")).toEqual(['l1']);
  });

  it('~= |= ^= $= *= operators', () => {
    expect(q('[data-k~=beta]')).toEqual(['l3']);
    expect(q('[data-k~=alph]')).toEqual([]);
    expect(q('[lang|=en]')).toEqual(['list']);
    expect(q('[data-k^=alp]')).toEqual(['l3']);
    expect(q('[data-k$=ma]')).toEqual(['l4']);
    expect(q('[data-k*=amm]')).toEqual(['l4']);
    expect(q('[data-k^=""]')).toEqual([]);
  });

  it('!= matches absent or different values', () => {
    expect(q('li[data-k!=gamma]')).toEqual(['l1', 'l2', 'l3']);
  });

  it('i flag makes the value comparison case-insensitive', () => {
    expect(q('[data-k=alpha]')).toEqual([]);
    expect(q('[data-k=alpha i]')).toEqual(['l1']);
    expect(q('[data-k^="ALPHA" i]')).toEqual(['l1', 'l3']);
    expect(q('[DATA-K=gamma]')).toEqual(['l4']);
  });

  it('tolerates unquoted values with slashes and colons', () => {
    const doc = parseHtml('<a href="/torrent/1">t</a><a href="magnet:?xt=1">m</a><img alt=Freeleech>');
    expect(querySelectorAll(doc, 'a[href^=/torrent/]')).toHaveLength(1);
    expect(querySelectorAll(doc, 'a[href*="magnet:"]')).toHaveLength(1);
    expect(querySelectorAll(doc, 'img[alt=Freeleech]')).toHaveLength(1);
  });
});

describe('comma unions', () => {
  it('merges results in document order without duplicates', () => {
    expect(q('#p2, #l3, li.special, #l1')).toEqual(['l1', 'l3', 'p2']);
  });
});

describe('pseudo-classes', () => {
  it(':has with descendant and relative selectors', () => {
    expect(q('li:has(b)')).toEqual(['l2']);
    expect(q('p:has(> span)')).toEqual(['p1']);
    expect(q('li:has(+ .special)')).toEqual(['l2']);
    expect(q('li:has(~ .last)')).toEqual(['l1', 'l2', 'l3']);
    expect(q('div:has(li.special, #nothing) > ul')).toEqual(['list']);
  });

  it('nested :has(> td.x) on table rows', () => {
    const doc = parseHtml('<table><tr class=h><th>h</th></tr><tr><td class=x>1</td></tr><tr><td><table><tr><td class=x>n</td></tr></table></td></tr></table>');
    const rows = querySelectorAll(doc, 'tr:has(> td.x)');
    expect(rows.map((r) => textContent(r))).toEqual(['1', 'n']);
    expect(querySelectorAll(doc, 'tr:has(td:has(> table))')).toHaveLength(1);
  });

  it(':not with a selector list', () => {
    expect(q('li:not(.first, .last)')).toEqual(['l2', 'l3']);
    expect(q('li:not([data-k])')).toEqual(['l2']);
    expect(q('ul > :not(li)')).toEqual([]);
  });

  it(':is / :where', () => expect(q(':is(#l1, #p1)')).toEqual(['l1', 'p1']));

  it(':contains and :icontains', () => {
    expect(q('p:contains("Seeders")')).toEqual(['p1']);
    expect(q("p:contains('seeders')")).toEqual([]);
    expect(q('p:contains(Leech)')).toEqual(['p2']);
    expect(q('p:icontains(SEEDERS)')).toEqual(['p1']);
    expect(q('li:contains("two bold")')).toEqual(['l2']);
    expect(q('*:contains("a, b)")')).toEqual([]);
  });

  it(':nth-child with an+b, odd, even and negative a', () => {
    expect(q('li:nth-child(2)')).toEqual(['l2']);
    expect(q('li:nth-child(2n+1)')).toEqual(['l1', 'l3']);
    expect(q('li:nth-child(odd)')).toEqual(['l1', 'l3']);
    expect(q('li:nth-child(even)')).toEqual(['l2', 'l4']);
    expect(q('li:nth-child(-n+3)')).toEqual(['l1', 'l2', 'l3']);
    expect(q('li:nth-child(n)')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(q('li:nth-child( 3n - 1 )')).toEqual(['l2']);
  });

  it(':nth-last-child, :nth-of-type and :nth-last-of-type', () => {
    expect(q('li:nth-last-child(1)')).toEqual(['l4']);
    expect(q('#root > p:nth-of-type(2)')).toEqual(['p2']);
    expect(q('#root > p:nth-last-of-type(2)')).toEqual(['p1']);
    expect(q('#root > :nth-child(2)')).toEqual(['p1']);
  });

  it('first/last/only child and of-type', () => {
    expect(q('li:first-child')).toEqual(['l1']);
    expect(q('li:last-child')).toEqual(['l4']);
    expect(q('p > :only-child')).toEqual(['s1']);
    expect(q('#root > :first-of-type')).toEqual(['list', 'p1', 'f']);
    expect(q('#root > :last-of-type')).toEqual(['list', 'p2', 'f']);
    expect(q('form > :only-of-type')).toEqual(['sel']);
  });

  it(':empty, :root, :checked, :selected, :disabled', () => {
    expect(q('li:empty')).toEqual(['l4']);
    expect(q(':root')).toEqual(['root']);
    expect(q('input:checked')).toEqual(['i1']);
    expect(q(':checked')).toEqual(['i1', 'o2']);
    expect(q('option:selected')).toEqual(['o2']);
    expect(q(':disabled')).toEqual(['i2']);
  });

  it('jQuery :eq / :first / :last / :lt / :gt (set semantics in querySelectorAll)', () => {
    expect(q('li:eq(1)')).toEqual(['l2']);
    expect(q('li:eq(-1)')).toEqual(['l4']);
    expect(q('li:first')).toEqual(['l1']);
    expect(q('li:last')).toEqual(['l4']);
    expect(q('li:lt(2)')).toEqual(['l1', 'l2']);
    expect(q('li:gt(1)')).toEqual(['l3', 'l4']);
    expect(q('li.item:eq(2) ~ li')).toEqual(['l4']);
    expect(q('li:eq(9)')).toEqual([]);
    const doc = parseHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    const row = querySelectorAll(doc, 'tr')[1]!;
    expect(querySelectorAll(row, 'td:eq(1)').map((td) => textContent(td))).toEqual(['d']);
    expect(querySelectorAll(doc, 'td:eq(1)').map((td) => textContent(td))).toEqual(['b']);
  });

  it(':eq in matches() is sibling-relative', () => {
    const li2 = querySelector(DOC, '#l2')!;
    expect(matches(li2, 'li:eq(1)')).toBe(true);
    expect(matches(li2, 'li:eq(0)')).toBe(false);
  });
});

describe('matches()', () => {
  it('considers ancestor constraints', () => {
    const b = querySelector(DOC, '#b2')!;
    expect(matches(b, 'ul li > b')).toBe(true);
    expect(matches(b, 'p b')).toBe(false);
    expect(matches(b, '#root b, p b')).toBe(true);
    expect(matches(b, 'li + li b')).toBe(true);
  });

  it(':scope refers to the provided scope', () => {
    const ul = querySelector(DOC, 'ul')!;
    const li = querySelector(DOC, '#l1')!;
    expect(matches(li, ':scope > li', ul)).toBe(true);
    expect(querySelectorAll(ul, ':scope > li')).toHaveLength(4);
  });
});

describe('querySelectorAll scoping', () => {
  it('excludes the context but honours ancestors above it', () => {
    const ul = querySelector(DOC, 'ul')!;
    expect(ids(querySelectorAll(ul, 'ul'))).toEqual([]);
    expect(ids(querySelectorAll(ul, 'div li.special'))).toEqual(['l3']);
    expect(ids(querySelectorAll(ul, 'ul > li:first-child'))).toEqual(['l1']);
    expect(ids(querySelectorAll(ul, 'p'))).toEqual([]);
    expect(querySelector(ul, 'b')!.tagName).toBe('b');
    expect(querySelector(ul, 'table')).toBeNull();
  });
});

describe('removeMatching', () => {
  it('detaches all matches and returns the count', () => {
    const doc = parseHtml('<table><tr class=header><th>h</th></tr><tr><td>a</td></tr><tr class=header><th>h</th></tr><tr><td>b</td></tr></table>');
    expect(removeMatching(doc, 'tr.header')).toBe(2);
    expect(querySelectorAll(doc, 'tr')).toHaveLength(2);
    expect(querySelectorAll(doc, 'tr:not(.header)')).toHaveLength(2);
    expect(removeMatching(doc, 'tr.header')).toBe(0);
  });
});

describe('selector errors', () => {
  it.each([
    '',
    '   ',
    'div >',
    '> div',
    'a,',
    '[href',
    '[=x]',
    'a:bogus',
    ':nth-child(foo)',
    ':not(',
    'div::before',
    ':has()',
    'a:eq(x)',
    ':first-child(1)',
    ':contains("open',
    'a!b',
  ])('rejects %j with SelectorSyntaxError', (sel) => {
    expect(() => querySelectorAll(DOC, sel)).toThrow(SelectorSyntaxError);
  });

  it('error messages name the selector', () => {
    try {
      querySelectorAll(DOC, 'li:frobnicate');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SelectorSyntaxError);
      expect((e as Error).message).toContain('li:frobnicate');
      expect((e as Error).message).toContain(':frobnicate');
    }
  });
});

describe('realistic torrent table', () => {
  const page = parseHtml(`<!DOCTYPE html>
<html><head><title>Results</title></head><body>
<table id="torrents" class="list">
  <tr class="header"><td>Cat</td><td>Name</td><td>Size</td><td>Seeders</td><td>Leechers</td></tr>
  <tr><td><img src="/c/1.png" alt="Movies"></td><td class="name"><a href="/torrent/101/" title="Movie.One.2024.1080p">Movie.One.2024.1080p</a> <img src="/fl.png" alt=Freeleech><a href="magnet:?xt=urn:btih:AAA&amp;dn=Movie.One">M</a></td><td>1.4&nbsp;GB</td><td>120</td><td>4</td></tr>
  <tr><td><img src="/c/2.png" alt="TV"></td><td class="name"><a href="/torrent/102/">Show.S01E01.720p</a><a href="magnet:?xt=urn:btih:BBB">M</a></td><td>700 MB</td><td>55</td><td>10</td>
  <tr><td><img src="/c/1.png" alt="Movies"></td><td class=name><a href="/torrent/103/">Movie &amp; Two (2023)</a><a href="magnet:?xt=urn:btih:CCC">M</a></td><td>2.1 GB</td><td>0</td><td>1</td></tr>
  <tr><td><img src="/c/3.png" alt="Music"></td><td class="name"><a href="/torrent/104/">Album – Artist</a><img alt="Freeleech" src="/fl.png"><a href="magnet:?xt=urn:btih:DDD">M</a></td><td>320 MB</td><td>9</td><td>0</td></tr>
  <tr><td><img src="/c/2.png" alt="TV"></td><td class="name"><a href="/torrent/105/">Show.S01E02.720p</a><a href="magnet:?xt=urn:btih:EEE">M</a></td><td>710 MB</td><td>48</td><td>7</td></tr>
</table>
</body></html>`);

  it('extracts title/href/size/seeders/freeleech per row', () => {
    const rows = querySelectorAll(page, 'table#torrents > tbody > tr:has(td.name)');
    expect(rows).toHaveLength(5);
    const extracted = rows.map((tr) => {
      const link = querySelector(tr, 'td:nth-child(2) a[href^="/torrent/"]')!;
      return {
        title: textContent(link).trim(),
        href: getAttribute(link, 'href'),
        magnet: getAttribute(querySelector(tr, 'a[href*="magnet:"]')!, 'href'),
        size: textContent(querySelector(tr, 'td:nth-child(3)')!),
        seeders: Number(textContent(querySelector(tr, 'td:nth-child(4)')!)),
        freeleech: querySelector(tr, 'img[alt=Freeleech]') !== null,
        category: getAttribute(querySelector(tr, 'td:first-child img')!, 'alt'),
      };
    });
    expect(extracted[0]).toEqual({
      title: 'Movie.One.2024.1080p',
      href: '/torrent/101/',
      magnet: 'magnet:?xt=urn:btih:AAA&dn=Movie.One',
      size: '1.4 GB',
      seeders: 120,
      freeleech: true,
      category: 'Movies',
    });
    expect(extracted.map((r) => r.title)).toEqual([
      'Movie.One.2024.1080p',
      'Show.S01E01.720p',
      'Movie & Two (2023)',
      'Album – Artist',
      'Show.S01E02.720p',
    ]);
    expect(extracted.map((r) => r.seeders)).toEqual([120, 55, 0, 9, 48]);
    expect(extracted.map((r) => r.freeleech)).toEqual([true, false, false, true, false]);
  });

  it('finds the header row and column positions', () => {
    expect(querySelectorAll(page, 'tr:not(.header)')).toHaveLength(5);
    const header = querySelector(page, 'tr.header')!;
    const seedHeader = querySelector(header, 'td:contains("Seeders")')!;
    const cells = querySelectorAll(header, 'td');
    expect(cells.indexOf(seedHeader)).toBe(3);
    expect(querySelectorAll(page, 'tr:has(td:contains("Seeders")) ~ tr')).toHaveLength(5);
  });
});

describe('selector cache', () => {
  it('reuses compiled selectors across documents', () => {
    const a = parseHtml('<i class=z></i>');
    const b = parseHtml('<i class=z></i><i class=z></i>');
    expect(querySelectorAll(a, 'i.z')).toHaveLength(1);
    expect(querySelectorAll(b, 'i.z')).toHaveLength(2);
  });
});
