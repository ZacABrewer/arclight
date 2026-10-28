import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ThemeCatalog, ThemeInfo } from '@arclight/shared';
import { Backdrop, BUILTIN_THEME, applyTheme, getActiveTheme, restoreTheme } from '../../arclight/index.js';
import { activeThemeOf, resolveTheme } from './resolve.js';

const tron: ThemeInfo = { id: 'tron', name: 'Tron', version: '1.0.0', description: '', author: '', colorScheme: 'dark', backdrop: 'tron', swatches: ['#02090c', '#6ef6ff'], source: 'builtin', css: null };
const sorbet: ThemeInfo = { ...tron, id: 'sorbet', name: 'Sorbet', colorScheme: 'light', backdrop: 'shapes', swatches: ['#fff7ef', '#ff8fa3'], source: 'bundled', css: 'theme/sorbet/theme.css?v=1.0.0' };
const catalog = (over: Partial<ThemeCatalog> = {}): ThemeCatalog => ({ themes: [tron, sorbet], defaultTheme: 'tron', allowUserChoice: true, ...over });

afterEach(() => {
  applyTheme(BUILTIN_THEME);
  localStorage.clear();
});

describe('resolveTheme', () => {
  it("uses the user's pick, else the server default", () => {
    expect(resolveTheme(catalog(), { userTheme: 'sorbet', isAdmin: false, deviceTheme: null }).id).toBe('sorbet');
    expect(resolveTheme(catalog({ defaultTheme: 'sorbet' }), { userTheme: 'default', isAdmin: false, deviceTheme: 'tron' }).id).toBe('sorbet');
  });

  it('ignores a non-admin pick when user choice is off, but not an admin one', () => {
    const c = catalog({ allowUserChoice: false });
    expect(resolveTheme(c, { userTheme: 'sorbet', isAdmin: false, deviceTheme: null }).id).toBe('tron');
    expect(resolveTheme(c, { userTheme: 'sorbet', isAdmin: true, deviceTheme: null }).id).toBe('sorbet');
  });

  it("signed out keeps this device's theme, and unknown ids fall back", () => {
    expect(resolveTheme(catalog(), { userTheme: null, isAdmin: false, deviceTheme: 'sorbet' }).id).toBe('sorbet');
    expect(resolveTheme(catalog({ defaultTheme: 'gone' }), { userTheme: 'gone', isAdmin: false, deviceTheme: null }).id).toBe('tron');
  });

  it('maps a pack to its stylesheet URL and browser colour', () => {
    expect(activeThemeOf(sorbet)).toEqual({ id: 'sorbet', href: '/api/v1/theme/sorbet/theme.css?v=1.0.0', colorScheme: 'light', backdrop: 'shapes', themeColor: '#fff7ef' });
    expect(activeThemeOf(tron).href).toBeNull();
  });
});

describe('theme store', () => {
  it('restores the last theme on this device and falls back to Tron when its stylesheet fails', () => {
    applyTheme(activeThemeOf(sorbet));
    document.head.querySelector('link[data-al-theme]')!.dispatchEvent(new Event('load'));
    expect(getActiveTheme().id).toBe('sorbet');
    expect(document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content).toBe('light');
    // A fresh page: the stored theme comes back before anything is fetched.
    applyTheme(BUILTIN_THEME);
    localStorage.setItem('arclight.theme', JSON.stringify(activeThemeOf(sorbet)));
    restoreTheme();
    const link = document.head.querySelector('link[data-al-theme]')!;
    link.dispatchEvent(new Event('error'));
    expect(getActiveTheme().id).toBe('tron');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('draws the shapes backdrop for a pack that asks for it', () => {
    const { container, rerender } = render(<Backdrop />);
    expect(container.querySelector('.al-backdrop__svg')).not.toBeNull();
    applyTheme(activeThemeOf(sorbet));
    document.head.querySelector('link[data-al-theme]')!.dispatchEvent(new Event('load'));
    rerender(<Backdrop />);
    expect(container.querySelector('.al-backdrop__svg')).toBeNull();
    expect(container.querySelectorAll('.al-backdrop--shapes .al-backdrop__shape')).toHaveLength(3);
  });
});
