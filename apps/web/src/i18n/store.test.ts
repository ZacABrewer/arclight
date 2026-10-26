import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseLocale,
  configureMissingKeyWarning,
  detectLocale,
  deviceLocale,
  getLocale,
  intlLocale,
  localeDir,
  matchLocale,
  registerMessages,
  setLocale,
  t,
} from './index.js';
import en from './locales/en.json';

afterEach(async () => {
  configureMissingKeyWarning({ enabled: true, handler: null });
  localStorage.clear();
  await setLocale('en');
});

describe('t and locales', () => {
  it('reads English messages and formats their params', () => {
    expect(t('common.save')).toBe('Save');
    expect(t('status.cutoffUnmet')).toBe('Cutoff unmet');
    expect(t('arclight.chrome.topBar.issues', { count: 1 })).toBe('issue');
    expect(t('arclight.chrome.topBar.issues', { count: 3 })).toBe('issues');
  });

  it('keeps the status vocabulary as the canonical English labels', () => {
    expect(['Downloaded', 'Downloading', 'Importing', 'Monitored', 'Unmonitored', 'Unaired', 'Queued', 'Paused', 'Waiting for air date', 'Missing', 'Cutoff unmet', 'Stalled', 'Failed']).toEqual(
      ['downloaded', 'downloading', 'importing', 'monitored', 'unmonitored', 'unaired', 'queued', 'paused', 'waiting', 'missing', 'cutoffUnmet', 'stalled', 'failed'].map(
        (k) => (en as Record<string, string>)[`status.${k}`],
      ),
    );
  });

  it('lazy-loads a locale, sets lang/dir and shows its placeholders', async () => {
    expect(await setLocale('de')).toBe('de');
    expect(getLocale()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(document.documentElement.dir).toBe('ltr');
    expect(t('common.save')).toBe('[de] Save');
    expect(intlLocale()).toBe('de');
    await setLocale('en');
    expect(intlLocale()).toBeUndefined();
  });

  it('falls back to English for keys a locale lacks, warning once per key', async () => {
    const warn = vi.fn();
    configureMissingKeyWarning({ enabled: true, handler: warn });
    registerMessages('fr', { 'common.save': 'Enregistrer' });
    await setLocale('fr');
    expect(t('common.save')).toBe('Enregistrer');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('common.cancel')).toBe('Cancel');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('common.cancel', 'fr');
  });

  it('warns about keys missing everywhere and returns the key', () => {
    const warn = vi.fn();
    configureMissingKeyWarning({ enabled: true, handler: warn });
    expect(t('no.such.key')).toBe('no.such.key');
    t('no.such.key');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('no.such.key', 'en');
    configureMissingKeyWarning({ enabled: false });
    t('another.missing.key');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns through console.warn by default in development', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t('dev.only.missing');
    expect(spy).toHaveBeenCalledWith('[i18n] missing key "dev.only.missing"');
    spy.mockRestore();
  });

  it('unknown locales fall back to English', async () => {
    expect(await setLocale('xx')).toBe('en');
    expect(t('common.save')).toBe('Save');
  });
});

describe('locale detection', () => {
  it('uses the user setting, then the device choice, then the browser, then English', () => {
    expect(detectLocale('nl', ['de-DE'])).toBe('nl');
    expect(detectLocale('auto', ['de-AT', 'en'])).toBe('de');
    expect(detectLocale(undefined, ['pt-BR'])).toBe('en');
    localStorage.setItem('arclight.locale', 'es');
    expect(detectLocale('auto', ['de-DE'])).toBe('es');
    expect(detectLocale('fr', ['de-DE'])).toBe('fr');
  });

  it('matches browser tags by language and knows right-to-left scripts', () => {
    expect(matchLocale(['fr-CA'])).toBe('fr');
    expect(matchLocale(['zz', 'NL-be'])).toBe('nl');
    expect(matchLocale(['ja'])).toBeUndefined();
    expect(localeDir('ar')).toBe('rtl');
    expect(localeDir('he-IL')).toBe('rtl');
    expect(localeDir('de')).toBe('ltr');
  });

  it('chooseLocale remembers the device choice; auto forgets it', async () => {
    await chooseLocale('nl');
    expect(deviceLocale()).toBe('nl');
    expect(getLocale()).toBe('nl');
    await chooseLocale('auto');
    expect(deviceLocale()).toBeUndefined();
  });
});
