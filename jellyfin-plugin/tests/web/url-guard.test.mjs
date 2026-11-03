// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the url-guard block of Web/arclight.js (isHttpUrl, safeUrl, el) against a tiny fake DOM and
// checks that links and images built from server data never get a javascript: or data: URL.
//   node --test tests/web/url-guard.test.mjs
// Also run by the .NET test suite (ClientAndWebTests) when node is on the PATH.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/Jellyfin.Plugin.Arclight/Web/arclight.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('// url-guard:start'), source.indexOf('// url-guard:end'));
assert.ok(block.length > 100, 'url-guard block found in arclight.js');

function fakeElement(tag) {
  return {
    tag,
    attributes: {},
    children: [],
    className: '',
    textContent: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    addEventListener() {},
    appendChild(c) { this.children.push(c); },
  };
}

const context = vm.createContext({
  URL,
  location: { href: 'https://jellyfin.example.com/web/index.html#/home' },
  document: { createElement: fakeElement, createTextNode: (t) => ({ text: t }) },
});
vm.runInContext(block + '\n;globalThis.guard = { isHttpUrl, safeUrl, el };', context);
const { isHttpUrl, el } = context.guard;

test('isHttpUrl accepts only absolute http(s) URLs', () => {
  assert.equal(isHttpUrl('https://www.justwatch.com/us/movie/x'), true);
  assert.equal(isHttpUrl('http://example.com'), true);
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example', '/relative', '', null, undefined, 42]) {
    assert.equal(isHttpUrl(bad), false, String(bad));
  }
});

test('a javascript: link renders without an href', () => {
  for (const bad of ['javascript:alert(document.domain)', '  javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const a = el('a', { class: 'arclight-attribution', href: bad, target: '_blank', text: 'JustWatch' });
    assert.equal(a.hasAttribute('href'), false, bad);
    assert.equal(a.attributes.target, '_blank');
    assert.equal(a.textContent, 'JustWatch');
    const img = el('img', { src: bad, alt: '' });
    assert.equal(img.hasAttribute('src'), false, bad);
  }
});

test('http(s), relative, fragment and blob URLs are kept as given', () => {
  for (const ok of ['https://www.youtube.com/watch?v=abc', 'http://example.com/a', '#/details?id=0123', '#/home?arclight=discover', '/Arclight/Theme.css?theme=abyss', 'blob:https://jellyfin.example.com/1234']) {
    assert.equal(el('a', { href: ok }).attributes.href, ok, ok);
  }
});
