import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectChallenge } from './challenge.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const titleOf = (html: string) => /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
const page = (name: string, extra: { status?: number; headers?: Record<string, string> } = {}) => {
  const html = fixture(name);
  return { title: titleOf(html), html, ...extra };
};

describe('detectChallenge', () => {
  it('flags the Cloudflare JS interstitial', () => {
    const v = detectChallenge(page('cf-js-challenge.html', { status: 403 }));
    expect(v).toMatchObject({ challenge: true, kind: 'cloudflare', interactive: false });
  });

  it('flags a Turnstile page as interactive', () => {
    expect(detectChallenge(page('cf-turnstile.html'))).toMatchObject({ challenge: true, kind: 'cloudflare', interactive: true });
  });

  it('reports error 1020 as blocked, not solvable', () => {
    expect(detectChallenge(page('cf-1020.html', { status: 403 }))).toMatchObject({ challenge: true, kind: 'blocked' });
    expect(detectChallenge({ title: '', html: '<html><body>error code: 1020</body></html>' }).kind).toBe('blocked');
  });

  it('flags DDoS-Guard', () => {
    expect(detectChallenge(page('ddos-guard.html', { status: 403 }))).toMatchObject({ challenge: true, kind: 'ddos-guard' });
  });

  it('does not flag an ordinary page behind Cloudflare (bot-management script only)', () => {
    expect(detectChallenge(page('normal-cloudflare-site.html', { status: 200, headers: { server: 'cloudflare' } })).challenge).toBe(false);
  });

  it('does not flag a plain page', () => {
    expect(detectChallenge(page('normal.html', { status: 200 }))).toEqual({ challenge: false, interactive: false });
  });

  it('trusts the cf-mitigated header even when the HTML looks harmless', () => {
    const v = detectChallenge({ title: 'Loading', html: '<html></html>', status: 403, headers: { 'CF-Mitigated': 'challenge' } });
    expect(v).toMatchObject({ challenge: true, reason: 'cf-mitigated: challenge' });
  });

  it('matches challenge markers when the title is missing', () => {
    expect(detectChallenge({ title: '', html: '<form id="challenge-form" action="/?__cf_chl_f_tk=abc"></form>' }).challenge).toBe(true);
  });
});
