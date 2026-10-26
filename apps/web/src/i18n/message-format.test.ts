import { describe, expect, it } from 'vitest';
import { MessageSyntaxError, formatMessage, messageParams, parseMessage } from './message-format.js';

describe('ICU-lite message format', () => {
  it('substitutes params and leaves unknown ones visible', () => {
    expect(formatMessage('Delete {name}?', { name: 'Andor' })).toBe('Delete Andor?');
    expect(formatMessage('Delete {name}?', {})).toBe('Delete {name}?');
    expect(formatMessage('Plain text, no params')).toBe('Plain text, no params');
  });

  it('picks plural branches with # as the number', () => {
    const msg = '{count, plural, one {# item} other {# items}}';
    expect(formatMessage(msg, { count: 1 })).toBe('1 item');
    expect(formatMessage(msg, { count: 0 })).toBe('0 items');
    expect(formatMessage(msg, { count: 2 })).toBe('2 items');
  });

  it('prefers exact =N branches and follows the locale plural rules', () => {
    const msg = '{n, plural, =0 {nothing} one {# file} other {# files}}';
    expect(formatMessage(msg, { n: 0 })).toBe('nothing');
    // French puts 0 and 1 in `one`; English only 1.
    const fr = '{n, plural, one {# fichier} other {# fichiers}}';
    expect(formatMessage(fr, { n: 0 }, 'fr')).toBe('0 fichier');
    expect(formatMessage(fr, { n: 0 }, 'en')).toBe('0 fichiers');
  });

  it('formats # and {n, number} for the locale', () => {
    expect(formatMessage('{n, plural, one {# item} other {# items}}', { n: 1234 }, 'de')).toBe('1.234 items');
    expect(formatMessage('{n, number} bytes', { n: 1234.5 }, 'en')).toBe('1,234.5 bytes');
    // A plain {n} is inserted as-is (no grouping), so mono layouts do not change.
    expect(formatMessage('{n} bytes', { n: 1234 }, 'de')).toBe('1234 bytes');
  });

  it('selects by value with an other fallback, nesting plurals inside', () => {
    const msg = '{kind, select, series {series} other {{count, plural, one {movie} other {movies}}}}';
    expect(formatMessage(msg, { kind: 'series', count: 3 })).toBe('series');
    expect(formatMessage(msg, { kind: 'movie', count: 1 })).toBe('movie');
    expect(formatMessage(msg, { kind: 'movie', count: 4 })).toBe('movies');
    expect(formatMessage('{on, select, true {Unmonitor} other {Monitor}} {title}', { on: true, title: 'Andor' })).toBe('Unmonitor Andor');
  });

  it("treats '{' '}' '#' as literals and other apostrophes as text", () => {
    expect(formatMessage("Tokens look like '{'Series Title'}'", {})).toBe('Tokens look like {Series Title}');
    expect(formatMessage("Don't stop", {})).toBe("Don't stop");
    expect(formatMessage("{n, plural, other {'#' # left}}", { n: 2 })).toBe('# 2 left');
  });

  it('reports syntax errors and lists parameter names', () => {
    expect(() => parseMessage('{count, plural, one {x}}')).toThrow(MessageSyntaxError);
    expect(() => parseMessage('Unclosed {name')).toThrow(MessageSyntaxError);
    expect(() => parseMessage('Stray } brace')).toThrow(MessageSyntaxError);
    expect([...messageParams('{a} and {b, select, x {{c}} other {}}')]).toEqual(['a', 'b', 'c']);
  });
});
