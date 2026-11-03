import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction, redact, redactValue } from './redact';

const signed = 'https://media.example.com/api/v1/stream/42?u=7&exp=1999999999&sig=abcDEF123_-';

describe('redact', () => {
  it('hides a signed link signature and tokens, keeping the rest', () => {
    expect(redact(signed)).toBe('https://media.example.com/api/v1/stream/42?u=7&exp=1999999999&sig=REDACTED');
    expect(redact('GET /x?TOKEN=s3cret&b=1')).toBe('GET /x?TOKEN=REDACTED&b=1');
    expect(redact('Authorization: Bearer alt_abc.def')).toBe('Authorization: Bearer REDACTED');
    expect(redact('plain ?u=7&exp=5 monkey=1')).toBe('plain ?u=7&exp=5 monkey=1');
  });

  it('redacts errors, URLs and nested plain objects', () => {
    const err = redactValue(new TypeError(`failed ${signed}`)) as Error;
    expect(err.message).not.toContain('abcDEF');
    expect(err.name).toBe('TypeError');
    expect(err.stack ?? '').not.toContain('abcDEF');
    expect(redactValue(new URL(signed))).not.toContain('abcDEF');
    const out = redactValue({ a: [{ url: signed }], n: 3 }) as { a: { url: string }[]; n: number };
    expect(out.a[0]!.url).toContain('sig=REDACTED');
    expect(out.n).toBe(3);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => redactValue(loop)).not.toThrow();
  });

  it('wraps console methods', () => {
    const log = vi.fn();
    const fake = { log, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as unknown as Console;
    installConsoleRedaction(fake);
    fake.log('playing', signed);
    expect(log).toHaveBeenCalledWith('playing', expect.stringContaining('sig=REDACTED'));
  });
});
