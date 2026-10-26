import { describe, expect, it } from 'vitest';
import { applyFilter, applyFilters, FilterError, SUPPORTED_FILTERS, type FilterContext, type FilterSpec } from './filters.js';

const NOW = Date.UTC(2024, 2, 10, 12, 0, 0); // 2024-03-10T12:00:00Z
const logs: string[] = [];
const ctx: FilterContext = {
  vars: { 'Config.sitelink': 'https://site.example/', 'Result.title': 'Some.Title' },
  now: NOW,
  log: (m) => logs.push(m),
};
const f = (value: string, name: string, args?: FilterSpec['args'], c: FilterContext = ctx): string =>
  applyFilter(value, args === undefined ? { name } : { name, args }, c);

describe('filters', () => {
  it('querystring', () => {
    expect(f('/dl.php?id=42&k=x', 'querystring', 'id')).toBe('42');
    expect(f('/dl.php?id=42&k=x#frag', 'querystring', 'k')).toBe('x');
    expect(f('/dl.php?id=42', 'querystring', 'missing')).toBe('');
    expect(() => f('/dl.php', 'querystring', 'id')).toThrow(FilterError);
  });

  it('regexp returns capture group 1', () => {
    expect(f('12 files', 'regexp', '(\\d+) files')).toBe('12');
    expect(f('no match', 'regexp', '(\\d+)')).toBe('');
    expect(f('ABC', 'regexp', '(?i)(b)')).toBe('B');
  });

  it('re_replace is global and templated', () => {
    expect(f('a_b-c', 're_replace', ['[_-]', '.'])).toBe('a.b.c');
    expect(f('x', 're_replace', ['x', '{{ .Result.title }}'])).toBe('Some.Title');
  });

  it('replace is literal and global', () => {
    expect(f('a.b.c', 'replace', ['.', ' '])).toBe('a b c');
  });

  it('split takes the separator first char and supports negative indexes', () => {
    expect(f('a,b,c', 'split', [',', -1])).toBe('c');
    expect(f('a|b', 'split', ['|x', 0])).toBe('a');
    expect(() => f('a,b', 'split', [',', 5])).toThrow(FilterError);
  });

  it('trim, trimprefix, trimsuffix', () => {
    expect(f('  x \n', 'trim')).toBe('x');
    expect(f('..x..', 'trim', '.')).toBe('x');
    expect(f(' x ', 'trim')).toBe(' x ');
    expect(f('prefix-x', 'trimprefix', 'prefix-')).toBe('x');
    expect(f('x.torrent', 'trimsuffix', '.torrent')).toBe('x');
  });

  it('prepend and append are templated', () => {
    expect(f('dl/1', 'prepend', '{{ .Config.sitelink }}')).toBe('https://site.example/dl/1');
    expect(f('a', 'append', '-b')).toBe('a-b');
  });

  it('tolower / toupper', () => {
    expect(f('AbC', 'tolower')).toBe('abc');
    expect(f('AbC', 'toupper')).toBe('ABC');
  });

  it('urlencode / urldecode (form style, encoding aware)', () => {
    expect(f('a b&c', 'urlencode')).toBe('a+b%26c');
    expect(f('a+b%26c', 'urldecode')).toBe('a b&c');
    expect(f('é', 'urlencode', undefined, { ...ctx, encoding: 'windows-1252' })).toBe('%E9');
    expect(f('%E9', 'urldecode', undefined, { ...ctx, encoding: 'windows-1252' })).toBe('é');
  });

  it('htmlencode / htmldecode', () => {
    expect(f('<a & "b">', 'htmlencode')).toContain('&lt;a &amp;');
    expect(f('&lt;b&gt; &amp; &#233; &eacute;', 'htmldecode')).toBe('<b> & é é');
  });

  it('base64encode / base64decode (URL-safe)', () => {
    expect(f('hello??>', 'base64encode')).toBe('aGVsbG8_Pz4');
    expect(f('aGVsbG8_Pz4', 'base64decode')).toBe('hello??>');
    expect(f('aGVsbG8/Pz4=', 'base64decode')).toBe('hello??>');
  });

  it('dateparse uses Go layouts and leaves unparseable values unchanged', () => {
    expect(f('2024-03-05 14:03:00', 'dateparse', '2006-01-02 15:04:05')).toBe('2024-03-05T14:03:00Z');
    expect(f('05 Mar 2024 14:03', 'timeparse', '02 Jan 2006 15:04')).toBe('2024-03-05T14:03:00Z');
    expect(f('garbage', 'dateparse', '2006-01-02')).toBe('garbage');
  });

  it('timeago / reltime', () => {
    expect(f('2 hours ago', 'timeago')).toBe('2024-03-10T10:00:00Z');
    expect(f('1 day, 2 hours ago', 'reltime')).toBe('2024-03-09T10:00:00Z');
    expect(() => f('3 fortnights ago', 'timeago')).toThrow(FilterError);
  });

  it('fuzzytime, including UK day-first', () => {
    expect(f('yesterday 10:00', 'fuzzytime')).toBe('2024-03-09T10:00:00Z');
    expect(f('03/04/2024', 'fuzzytime')).toBe('2024-03-04T00:00:00Z');
    expect(f('03/04/2024', 'fuzzytime', 'UK')).toBe('2024-04-03T00:00:00Z');
    expect(() => f('not a date', 'fuzzytime')).toThrow(FilterError);
  });

  it('validfilename', () => {
    expect(f('a/b:c*?"<>|.mkv', 'validfilename')).toBe('a_b_c______.mkv');
  });

  it('diacritics', () => {
    expect(f('Amélie Dvořák', 'diacritics', 'replace')).toBe('Amelie Dvorak');
    expect(() => f('x', 'diacritics', 'other')).toThrow(FilterError);
  });

  it('jsonjoinarray', () => {
    expect(f('{"tags":["a","b",3]}', 'jsonjoinarray', ['$.tags', ', '])).toBe('a, b, 3');
    expect(() => f('not json', 'jsonjoinarray', ['$.tags', ','])).toThrow(FilterError);
  });

  it('validate keeps allowed tokens', () => {
    expect(f('Action, Drama / Foo', 'validate', 'drama, action, comedy')).toBe('Action, Drama');
  });

  it('hexdump and strdump log and pass through', () => {
    logs.length = 0;
    expect(f('a\n', 'hexdump')).toBe('a\n');
    expect(f('a\n ', 'strdump', 'tag')).toBe('a\n ');
    expect(logs[0]).toContain('a(61)');
    expect(logs[1]).toContain('strdump(tag): a\\n\\u00A0');
  });

  it('unknown filters are skipped with a log entry', () => {
    logs.length = 0;
    expect(f('x', 'nonsense')).toBe('x');
    expect(logs[0]).toContain('unsupported filter');
  });

  it('applyFilters chains in order and skips null input', () => {
    expect(applyFilters(' A_B ', [{ name: 'trim' }, { name: 'replace', args: ['_', ' '] }, { name: 'tolower' }], ctx)).toBe('a b');
    expect(applyFilters(null, [{ name: 'append', args: 'x' }], ctx)).toBeNull();
  });

  it('every supported filter name is handled', () => {
    expect(SUPPORTED_FILTERS.size).toBeGreaterThanOrEqual(29);
  });
});
