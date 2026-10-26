import { describe, expect, it } from 'vitest';
import { parseFuzzyTime, parseGoLayout, parseTimeAgo, toIsoString } from './dates.js';
import { jsonQuery, jsonSelectRows, jsonToString, type JsonValue } from './jsonpath.js';
import { extractId, parseDecimal, parseInteger, parseSize } from './numbers.js';

const NOW = Date.UTC(2024, 2, 10, 12, 0, 0); // Sunday 2024-03-10T12:00:00Z
const iso = (d: Date | undefined): string | undefined => (d ? toIsoString(d) : undefined);

describe('numbers (S10.4)', () => {
  it('parses sizes with binary units', () => {
    expect(parseSize('1.5 GB')).toBe(1610612736);
    expect(parseSize('1.5 GiB')).toBe(1610612736);
    expect(parseSize('700 MiB')).toBe(734003200);
    expect(parseSize('12 KB')).toBe(12288);
    expect(parseSize('2 TB')).toBe(2 * 1024 ** 4);
    expect(parseSize('123456')).toBe(123456);
    expect(parseSize('512 Bytes')).toBe(512);
    expect(parseSize('1,5 GB')).toBe(1610612736);
    expect(parseSize('1.234,56 MB')).toBe(Math.trunc(1234.56 * 1024 ** 2));
    expect(parseSize('4.2G')).toBe(Math.trunc(4.2 * 1024 ** 3));
    expect(parseSize('-')).toBeUndefined();
  });

  it('parses integers leniently', () => {
    expect(parseInteger('1,234')).toBe(1234);
    expect(parseInteger('1.234')).toBe(1234);
    expect(parseInteger(' 56 seeders')).toBe(56);
    expect(parseInteger('-')).toBe(0);
    expect(parseInteger('1.234,5')).toBeUndefined();
  });

  it('parses decimals and extracts ids', () => {
    expect(parseDecimal('0,5')).toBe(0.5);
    expect(parseDecimal('1.234.5')).toBe(1234.5);
    expect(parseDecimal('')).toBe(0);
    expect(extractId('tt0133093')).toBe(133093);
    expect(extractId('none')).toBe(0);
  });
});

describe('dates (S6)', () => {
  it('parses Go layouts', () => {
    const ctx = { now: NOW };
    expect(iso(parseGoLayout('2024-03-05T14:03:00+02:00', '2006-01-02T15:04:05Z07:00', ctx))).toBe('2024-03-05T12:03:00Z');
    expect(iso(parseGoLayout('2024-03-05T14:03:00Z', '2006-01-02T15:04:05Z07:00', ctx))).toBe('2024-03-05T14:03:00Z');
    expect(iso(parseGoLayout('Tue, 05 Mar 2024 2:03 PM', 'Mon, 02 Jan 2006 3:04 PM', ctx))).toBe('2024-03-05T14:03:00Z');
    expect(iso(parseGoLayout('March 5, 24', 'January 2, 06', ctx))).toBe('2024-03-05T00:00:00Z');
    expect(iso(parseGoLayout('05.03.2024 14:03:07.250', '02.01.2006 15:04:05.000', ctx))).toBe('2024-03-05T14:03:07Z');
    expect(parseGoLayout('2024-13-45', '2006-01-02', ctx)).toBeUndefined();
  });

  it('interprets zone-less dates in the definition time zone (S6.3)', () => {
    const d = parseGoLayout('2024-07-01 12:00', '2006-01-02 15:04', { now: NOW, timeZone: 'Europe/Berlin' });
    expect(iso(d)).toBe('2024-07-01T10:00:00Z');
  });

  it('parses timeago strings', () => {
    expect(iso(parseTimeAgo('2 hours 1 day ago', NOW))).toBe('2024-03-09T10:00:00Z');
    expect(iso(parseTimeAgo('1.5h', NOW))).toBe('2024-03-10T10:30:00Z');
    expect(iso(parseTimeAgo('3 weeks ago', NOW))).toBe('2024-02-18T12:00:00Z');
    expect(iso(parseTimeAgo('an hour ago', NOW))).toBe('2024-03-10T11:00:00Z');
    expect(iso(parseTimeAgo('2 mo ago', NOW))).toBe('2024-01-10T12:00:00Z');
    expect(iso(parseTimeAgo('just now', NOW))).toBe('2024-03-10T12:00:00Z');
    expect(parseTimeAgo('3 fortnights', NOW)).toBeUndefined();
  });

  it('parses many fuzzy formats', () => {
    const ctx = { now: NOW };
    const cases: Array<[string, string]> = [
      ['Tue, 05 Mar 2024 14:03:00 +00:00', '2024-03-05T14:03:00Z'],
      ['Tue, 05 Mar 2024 14:03:00 GMT', '2024-03-05T14:03:00Z'],
      ['2024-03-05T14:03:00Z', '2024-03-05T14:03:00Z'],
      ['2024-03-05 14:03', '2024-03-05T14:03:00Z'],
      ['1709647380', '2024-03-05T14:03:00Z'],
      ['1709647380000', '2024-03-05T14:03:00Z'],
      ['today 08:30', '2024-03-10T08:30:00Z'],
      ['Yesterday at 11:15 PM', '2024-03-09T23:15:00Z'],
      ['Friday at 10:00', '2024-03-08T10:00:00Z'],
      ['05 Mar 2024', '2024-03-05T00:00:00Z'],
      ['5th March 2024 14:03', '2024-03-05T14:03:00Z'],
      ['Mar 5, 2024', '2024-03-05T00:00:00Z'],
      ['March 05 2024 14:03', '2024-03-05T14:03:00Z'],
      ['5 Mar 14:03', '2024-03-05T14:03:00Z'],
      ['03-05 14:03', '2024-03-05T14:03:00Z'],
      ['3/5/2024 2:03 PM', '2024-03-05T14:03:00Z'],
      ['2 days ago', '2024-03-08T12:00:00Z'],
    ];
    for (const [input, expected] of cases) expect(iso(parseFuzzyTime(input, ctx)), input).toBe(expected);
    expect(iso(parseFuzzyTime('05/03/2024', { now: NOW, dayFirst: true }))).toBe('2024-03-05T00:00:00Z');
    expect(parseFuzzyTime('gibberish', ctx)).toBeUndefined();
  });
});

describe('jsonpath-lite (S5.4)', () => {
  const doc: JsonValue = {
    data: {
      items: [
        { name: 'a', size: 10, files: [{ n: 'x' }, { n: 'y' }], tags: ['t1', 't2'], free: true },
        { name: 'b', size: 20, files: [], extra: { k: 1 } },
        { name: 'c', size: 30, files: [{ n: 'z' }], deleted: null },
      ],
    },
  };

  it('resolves dotted paths, indexes and negatives', () => {
    expect(jsonQuery(doc, 'data.items[0].name')).toBe('a');
    expect(jsonQuery(doc, '$.data.items[-1].name')).toBe('c');
    expect(jsonQuery(doc, '.data.items[0].files[1].n')).toBe('y');
    expect(jsonQuery(doc, 'data.items[5]')).toBeUndefined();
  });

  it('supports wildcards and recursive descent', () => {
    expect(jsonQuery(doc, 'data.items[*].name')).toBe('a');
    expect(jsonQuery(doc, '..n')).toBe('x');
  });

  it('renders values to strings', () => {
    expect(jsonToString(jsonQuery(doc, 'data.items[0].tags'))).toBe('t1,t2');
    expect(jsonToString(jsonQuery(doc, 'data.items[0].free'))).toBe('true');
    expect(jsonToString(jsonQuery(doc, 'data.items[1].extra'))).toBe('{"k":1}');
    expect(jsonToString(jsonQuery(doc, 'data.items[2].deleted'))).toBeNull();
  });

  it('filters rows with :has / :not / :contains', () => {
    expect(jsonSelectRows(doc, 'data.items:has(files[0])')?.map((r) => (r as { name: string }).name)).toEqual(['a', 'c']);
    expect(jsonSelectRows(doc, 'data.items:not(extra)')?.length).toBe(2);
    expect(jsonSelectRows(doc, 'data.items:contains("b")')?.length).toBe(1);
    expect(jsonSelectRows(doc, 'data.items:has(files[0]):not(tags)')?.length).toBe(1);
    expect(jsonSelectRows(doc, 'data.nothing')).toBeUndefined();
  });
});
