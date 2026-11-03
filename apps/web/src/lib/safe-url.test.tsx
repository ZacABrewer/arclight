import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LinkButton } from '../arclight/components/Button.js';
import { downloadHref, externalHref, isHttpUrl } from './safe-url.js';

const HOSTILE = ['javascript:alert(document.cookie)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>x()</script>', 'vbscript:msgbox', 'file:///etc/passwd'];

describe('isHttpUrl / externalHref', () => {
  it('accepts absolute http(s) URLs as given', () => {
    for (const ok of ['https://example.com/a?b=1#c', 'http://example.com', 'HTTPS://EXAMPLE.COM/x']) {
      expect(isHttpUrl(ok)).toBe(true);
      expect(externalHref(ok)).toBe(ok);
    }
  });

  it('rejects other schemes, relative paths and junk', () => {
    for (const bad of [...HOSTILE, '/relative', '//host-only', 'not a url', '', null, undefined]) {
      expect(isHttpUrl(bad)).toBe(false);
      expect(externalHref(bad)).toBeUndefined();
    }
    expect(isHttpUrl(42)).toBe(false);
  });

  it('allows magnet links only for downloads', () => {
    expect(downloadHref('magnet:?xt=urn:btih:abc')).toBe('magnet:?xt=urn:btih:abc');
    expect(downloadHref('https://example.com/x.torrent')).toBe('https://example.com/x.torrent');
    expect(externalHref('magnet:?xt=urn:btih:abc')).toBeUndefined();
    for (const bad of HOSTILE) expect(downloadHref(bad)).toBeUndefined();
  });

  it('a javascript: link renders without an href', () => {
    for (const bad of HOSTILE) {
      const { container, unmount } = render(
        <>
          <a href={externalHref(bad)} target="_blank" rel="noreferrer">
            Website
          </a>
          <LinkButton href={externalHref(bad)}>Trailer</LinkButton>
        </>,
      );
      const links = container.querySelectorAll('a');
      expect(links).toHaveLength(2);
      for (const a of links) expect(a.hasAttribute('href')).toBe(false);
      unmount();
    }
  });
});
