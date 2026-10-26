import { describe, expect, it } from 'vitest';
import {
  appendChild,
  decodeEntities,
  detach,
  elementChildren,
  encodeEntities,
  getAttribute,
  outerHtml,
  parseHtml,
  parseXml,
  previousElementSibling,
  querySelector,
  querySelectorAll,
  textContent,
  type HtmlElement,
} from './index.js';

function first(html: string, sel: string): HtmlElement {
  const el = querySelector(parseHtml(html), sel);
  if (el === null) throw new Error(`no match for ${sel}`);
  return el;
}

function tags(els: HtmlElement[]): string[] {
  return els.map((e) => e.tagName);
}

describe('entities', () => {
  it('decodes named, numeric and hex references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities('&#65;&#x42;&#X43;&#x1F600;')).toBe('ABC\u{1F600}');
    expect(decodeEntities('&copy; &reg; &hellip; &mdash; &ndash; &laquo;x&raquo; &eacute;&Eacute;')).toBe(
      '© ® … — – «x» éÉ',
    );
    expect(decodeEntities('&alpha;&Omega;&euro;&trade;&sigmaf;')).toBe('αΩ€™ς');
  });

  it('decodes nbsp and tolerates missing semicolons on legacy names', () => {
    expect(decodeEntities('1&nbsp;GB')).toBe('1 GB');
    expect(decodeEntities('a &amp b &lt c &nbspd')).toBe('a & b < c  d');
  });

  it('leaves unknown or malformed references alone', () => {
    expect(decodeEntities('&bogus; & &#; &#xZZ; a&b')).toBe('&bogus; & &#; &#xZZ; a&b');
    expect(decodeEntities('&#0; &#150;')).toBe('� –');
  });

  it('encodes the five special characters', () => {
    expect(encodeEntities(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
    expect(encodeEntities('plain')).toBe('plain');
  });
});

describe('parseHtml basics', () => {
  it('builds a tree with lower-cased names and parent links', () => {
    const doc = parseHtml('<DIV Class="a"><SPAN>hi</SPAN></DIV>');
    const div = doc.children[0] as HtmlElement;
    expect(div.tagName).toBe('div');
    expect(div.attributes.get('class')).toBe('a');
    expect(div.parent).toBe(doc);
    const span = div.children[0] as HtmlElement;
    expect(span.parent).toBe(div);
    expect(textContent(span)).toBe('hi');
    expect(doc.xml).toBe(false);
  });

  it('parses quoted, unquoted, valueless and duplicate attributes', () => {
    const el = first(
      `<input type=checkbox value='a "b"' data-x="1 &amp; 2" disabled NAME=foo name=bar href=/x/y?a=1&copy=2>`,
      'input',
    );
    expect(getAttribute(el, 'type')).toBe('checkbox');
    expect(getAttribute(el, 'value')).toBe('a "b"');
    expect(getAttribute(el, 'data-x')).toBe('1 & 2');
    expect(getAttribute(el, 'disabled')).toBe('');
    expect(getAttribute(el, 'name')).toBe('foo');
    expect(getAttribute(el, 'href')).toBe('/x/y?a=1&copy=2');
    expect(getAttribute(el, 'NAME')).toBe('foo');
    expect(getAttribute(el, 'missing')).toBeUndefined();
  });

  it('handles void elements and self-closing syntax', () => {
    const doc = parseHtml('<p>a<br>b<img src=x.png>c<hr/>d</p><div/>inside<custom-tag/>after');
    const p = querySelector(doc, 'p')!;
    expect(tags(elementChildren(p))).toEqual(['br', 'img']);
    // <div/> is a normal start tag in HTML; custom elements honour />
    const div = querySelector(doc, 'div')!;
    expect(textContent(div)).toBe('insideafter');
    expect(querySelector(doc, 'custom-tag')!.children).toHaveLength(0);
  });

  it('honours self-closing inside svg', () => {
    const doc = parseHtml('<svg><path d="M0"/><circle r=1 /></svg><b>x</b>');
    expect(tags(elementChildren(querySelector(doc, 'svg')!))).toEqual(['path', 'circle']);
    expect(querySelector(doc, 'b')!.parent).toBe(doc);
  });

  it('keeps script/style content as raw text', () => {
    const doc = parseHtml(
      '<script>if (a < b && c > d) { x = "</div>"; }</SCRIPT ><style>p > a { color: red }</style><p>ok</p>',
    );
    const script = querySelector(doc, 'script')!;
    expect(script.children).toHaveLength(1);
    expect(textContent(script)).toBe('if (a < b && c > d) { x = "</div>"; }');
    expect(textContent(querySelector(doc, 'style')!)).toBe('p > a { color: red }');
    expect(querySelector(doc, 'p')!.parent).toBe(doc);
  });

  it('decodes entities in textarea/title but not script', () => {
    const doc = parseHtml('<title>A &amp; B</title><textarea>&lt;x&gt;</textarea><script>a &amp; b</script>');
    expect(textContent(querySelector(doc, 'title')!)).toBe('A & B');
    expect(textContent(querySelector(doc, 'textarea')!)).toBe('<x>');
    expect(textContent(querySelector(doc, 'script')!)).toBe('a &amp; b');
  });

  it('parses comments, including unterminated ones, and skips doctype/PIs', () => {
    const doc = parseHtml('<!DOCTYPE html><?php echo 1 ?><!-- c1 --><p>x</p><!-- open <b>never');
    expect(doc.children.map((c) => c.type)).toEqual(['comment', 'element', 'comment']);
    expect(doc.children[0]!.type === 'comment' && doc.children[0]!.data).toBe(' c1 ');
    expect(doc.children[2]!.type === 'comment' && doc.children[2]!.data).toBe(' open <b>never');
    expect(querySelector(doc, 'b')).toBeNull();
  });

  it('decodes entities in text and treats stray < as text', () => {
    const doc = parseHtml('<p>Size: 1.5&nbsp;GB &amp; 3 < 4 <3 &copy</p>');
    expect(textContent(doc)).toBe('Size: 1.5 GB & 3 < 4 <3 ©');
  });

  it('closes unclosed tags at EOF', () => {
    const doc = parseHtml('<div><span><b>bold');
    expect(textContent(querySelector(doc, 'div > span > b')!)).toBe('bold');
  });

  it('never throws on garbage input', () => {
    const inputs = ['', '<', '</', '<<<>>>', '<a href="unterminated', '<!', '<!--', '</>', '<?', '<a b c=', '\u0000<\u0000>', '<table><td><tr></table></td>', '<![CDATA[x'];
    for (const s of inputs) expect(() => parseHtml(s)).not.toThrow();
    for (const s of inputs) expect(() => parseXml(s)).not.toThrow();
  });
});

describe('implied end tags and recovery', () => {
  it('closes td/th/tr implicitly', () => {
    const doc = parseHtml('<table><tr><td>a<td>b<th>c<tr><td>d</table>');
    const rows = querySelectorAll(doc, 'tr');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => tags(elementChildren(r)))).toEqual([['td', 'td', 'th'], ['td']]);
  });

  it('inserts an implicit tbody (and tr for bare cells)', () => {
    const doc = parseHtml('<table id=t><tr><td>1</td></tr><tr><td>2</td></tr></table><table id=u><td>x</td></table>');
    expect(querySelectorAll(doc, 'table#t > tbody > tr')).toHaveLength(2);
    expect(querySelectorAll(doc, 'table#t > tr')).toHaveLength(0);
    expect(querySelector(doc, 'table#u > tbody > tr > td')).not.toBeNull();
  });

  it('closes thead/tbody/tfoot by each other and keeps explicit tbody', () => {
    const doc = parseHtml('<table><thead><tr><th>h<tbody><tr><td>b<tfoot><tr><td>f</table>');
    const table = querySelector(doc, 'table')!;
    expect(tags(elementChildren(table))).toEqual(['thead', 'tbody', 'tfoot']);
  });

  it('closes li, dt/dd, option and p implicitly', () => {
    const doc = parseHtml(
      '<ul><li>a<li>b<ul><li>c</ul><li>d</ul><dl><dt>t<dd>d1<dd>d2</dl><select><option>1<option>2<optgroup><option>3</select><p>one<p>two<div>three</div>',
    );
    const outer = querySelector(doc, 'ul')!;
    expect(elementChildren(outer).map((li) => textContent(li))).toEqual(['a', 'bc', 'd']);
    expect(tags(elementChildren(querySelector(doc, 'dl')!))).toEqual(['dt', 'dd', 'dd']);
    expect(tags(elementChildren(querySelector(doc, 'select')!))).toEqual(['option', 'option', 'optgroup']);
    expect(querySelectorAll(doc, 'p').map((p) => textContent(p))).toEqual(['one', 'two']);
    expect(querySelector(doc, 'div')!.parent!.type).toBe('document');
  });

  it('ignores stray end tags', () => {
    const doc = parseHtml('</div></span><p>a</b>b</p></p></table>');
    expect(doc.children).toHaveLength(1);
    expect(textContent(doc)).toBe('ab');
  });

  it('recovers from mis-nested tags by popping intermediates', () => {
    const doc = parseHtml('<div><b><i>x</b>y</i>z</div>w');
    const div = querySelector(doc, 'div')!;
    expect(textContent(div)).toBe('xyz');
    expect(querySelector(doc, 'div > b > i')).not.toBeNull();
    expect(textContent(doc)).toBe('xyzw');
  });

  it('does not let end tags escape a table cell', () => {
    const doc = parseHtml('<div><table><tr><td>a</div>b</td><td>c</td></tr></table>d</div>');
    expect(querySelectorAll(doc, 'td').map((td) => textContent(td))).toEqual(['ab', 'c']);
    expect(textContent(querySelector(doc, 'div')!)).toBe('abcd');
  });

  it('handles nested tables', () => {
    const doc = parseHtml('<table><tr><td><table><tr><td>in</td></tr></table></td><td>out2</td></tr><tr><td>row2</table>');
    const outerRows = querySelectorAll(doc, 'table:not(td table) > tbody > tr');
    expect(outerRows).toHaveLength(2);
    expect(textContent(outerRows[0]!)).toBe('inout2');
  });
});

describe('XML mode', () => {
  it('preserves case, self-closes, decodes CDATA and skips the prolog', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><!DOCTYPE rss [ <!ENTITY x "y"> ]><rss xmlns:torznab="http://x"><channel><Item><title><![CDATA[A <b> & B]]></title><torznab:attr name="seeders" value="12"/><torznab:attr name="peers" value="3"/><desc>x &amp; y</desc></Item></channel></rss>',
    );
    expect(doc.xml).toBe(true);
    expect(querySelector(doc, 'Item')).not.toBeNull();
    expect(querySelector(doc, 'item')).toBeNull();
    expect(textContent(querySelector(doc, 'title')!)).toBe('A <b> & B');
    expect(textContent(querySelector(doc, 'desc')!)).toBe('x & y');
    const attrs = querySelectorAll(doc, 'attr');
    expect(attrs.map((a) => a.tagName)).toEqual(['torznab:attr', 'torznab:attr']);
    expect(getAttribute(querySelector(doc, 'attr[name=seeders]')!, 'value')).toBe('12');
    expect(querySelectorAll(doc, 'torznab\\:attr')).toHaveLength(2);
  });

  it('applies no HTML implied rules', () => {
    const doc = parseXml('<root><p>a<p>b</p></p><br>x</br><td/></root>');
    expect(querySelector(doc, 'p > p')).not.toBeNull();
    expect(textContent(querySelector(doc, 'br')!)).toBe('x');
  });
});

describe('textContent and serialization', () => {
  it('concatenates text without separators and keeps whitespace nodes', () => {
    const doc = parseHtml('<td>\n  <a>Name</a>\n  <span>1.2 GB</span>\n</td>');
    expect(textContent(querySelector(doc, 'td')!)).toBe('\n  Name\n  1.2 GB\n');
    expect(textContent(parseHtml('<b>a</b><i>b</i><!-- c -->d'))).toBe('abd');
  });

  it('round-trips through outerHtml', () => {
    const src = '<div class="x" data-q="a &quot;b&quot; &amp; c"><p>1 &lt; 2 &amp; 3</p><br><img src="a.png"><!-- note --><script>if (a<b) {}</script></div>';
    const once = outerHtml(parseHtml(src));
    expect(once).toBe(src);
    expect(outerHtml(parseHtml(once))).toBe(once);
  });

  it('serializes XML empty elements as self-closing', () => {
    const doc = parseXml('<a><b x="1"/><c>t</c></a>');
    expect(outerHtml(doc)).toBe('<a><b x="1"/><c>t</c></a>');
  });
});

describe('tree mutation helpers', () => {
  it('detach removes a node from its parent', () => {
    const doc = parseHtml('<ul><li>a</li><li>b</li></ul>');
    const li = querySelector(doc, 'li')!;
    detach(li);
    expect(li.parent).toBeNull();
    expect(querySelectorAll(doc, 'li')).toHaveLength(1);
    detach(li); // no-op
  });

  it('appendChild moves a node to a new parent', () => {
    const doc = parseHtml('<div id=a><span>x</span></div><div id=b></div>');
    const span = querySelector(doc, 'span')!;
    const b = querySelector(doc, '#b')!;
    appendChild(b, span);
    expect(span.parent).toBe(b);
    expect(querySelector(doc, '#a')!.children).toHaveLength(0);
    expect(querySelector(doc, '#b > span')).toBe(span);
    expect(() => appendChild(span, b)).toThrow();
  });

  it('previousElementSibling skips text and comments', () => {
    const doc = parseHtml('<p><a>1</a> text <!-- c --><b>2</b></p>');
    const b = querySelector(doc, 'b')!;
    expect(previousElementSibling(b)!.tagName).toBe('a');
    expect(previousElementSibling(previousElementSibling(b)!)).toBeNull();
  });
});

describe('performance', () => {
  it('parses a ~1 MB table and queries 2000 rows quickly', () => {
    const rows: string[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(
        `<tr class="${i % 2 ? 'odd' : 'even'}"><td class="cat"><img src="/c/${i % 7}.png" alt="Cat ${i % 7}"></td>` +
          `<td class="name"><a href="/torrent/${i}" title="Some.Release.Name.${i}.1080p.WEB-DL.x264">Some.Release.Name.${i}.1080p.WEB-DL.x264-GROUP</a>` +
          `<a href="magnet:?xt=urn:btih:${i.toString(16).padStart(40, '0')}&amp;dn=Some.Release.${i}">M</a>` +
          `<span class="desc">${'lorem ipsum dolor sit amet '.repeat(12)}</span></td>` +
          `<td>${(i % 50) + 1}.${i % 10} GB</td><td class="s">${i % 300}</td><td class="l">${i % 40}</td></tr>`,
      );
    }
    const html = `<html><body><table id="torrents"><thead><tr><th>Cat</th><th>Name</th></tr></thead><tbody>${rows.join('\n')}</tbody></table></body></html>`;
    expect(html.length).toBeGreaterThan(1_000_000);
    const t0 = performance.now();
    const doc = parseHtml(html);
    const found = querySelectorAll(doc, 'table#torrents > tbody > tr:has(td.name)');
    const links = found.map((tr) => getAttribute(querySelector(tr, 'td:nth-child(2) a[href^="/torrent/"]')!, 'href'));
    const elapsed = performance.now() - t0;
    expect(found).toHaveLength(2000);
    expect(links[1999]).toBe('/torrent/1999');
    expect(elapsed).toBeLessThan(1000);
  });
});
