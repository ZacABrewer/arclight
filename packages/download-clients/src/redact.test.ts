import { describe, expect, it } from 'vitest';
import { safeUrl, scrubError, scrubUrl } from './redact.js';

const URL_WITH_SECRETS = 'http://admin:s3cretpw@sab.example.com:8080/sabnzbd/api?mode=queue&output=json&apikey=abc123apikey&ma_password=hunter2pass';

describe('safeUrl / scrubUrl / scrubError', () => {
  it('keeps origin and path only', () => {
    expect(safeUrl(URL_WITH_SECRETS)).toBe('http://sab.example.com:8080/sabnzbd/api');
    expect(safeUrl('not a url?apikey=abc123apikey')).toBe('not a url');
  });

  it('removes the query, userinfo and secret values from a text quoting the URL', () => {
    const text = `request to ${URL_WITH_SECRETS} failed; key abc123apikey, password s3cretpw, mode=queue`;
    const out = scrubUrl(text, URL_WITH_SECRETS);
    for (const secret of ['abc123apikey', 'hunter2pass', 's3cretpw', 'admin:']) expect(out).not.toContain(secret);
    expect(out).toContain('http://sab.example.com:8080/sabnzbd/api');
  });

  it('copies an error chain with the URL scrubbed, keeping name and code', () => {
    const inner = Object.assign(new Error(`connect ECONNREFUSED ${URL_WITH_SECRETS}`), { code: 'ECONNREFUSED' });
    const copy = scrubError(new TypeError(`fetch failed: ${URL_WITH_SECRETS}`, { cause: inner }), URL_WITH_SECRETS) as Error;
    expect(copy.name).toBe('TypeError');
    expect((copy.cause as { code?: string }).code).toBe('ECONNREFUSED');
    expect(JSON.stringify([copy.message, copy.stack, (copy.cause as Error).message])).not.toMatch(/abc123apikey|hunter2pass|s3cretpw/);
  });
});
