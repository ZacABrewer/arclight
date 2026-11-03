import { describe, expect, it } from 'vitest';
import { absolutizeCss, themeStylesheetUrl } from './profile-theme';

describe('profile theme', () => {
  const base = 'https://media.example.com/api/v1/theme/packs/ember/theme.css';

  it('makes relative url()s absolute against the stylesheet', () => {
    expect(absolutizeCss(`a{background:url('img/bg.png')}`, base)).toBe(`a{background:url('https://media.example.com/api/v1/theme/packs/ember/img/bg.png')}`);
    expect(absolutizeCss('a{background:url(../x.svg)}', base)).toBe('a{background:url(https://media.example.com/api/v1/theme/packs/x.svg)}');
  });

  it('leaves data:, absolute and fragment urls alone', () => {
    const css = 'a{b:url(data:image/png;base64,AA);c:url("https://cdn.example.com/f.woff2");d:url(#g)}';
    expect(absolutizeCss(css, base)).toBe(css);
  });

  it('builds the stylesheet URL under the API', () => {
    expect(themeStylesheetUrl('https://media.example.com/', '/theme/packs/ember/theme.css')).toBe(base);
  });
});
