import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { StatusChip } from '../arclight/index.js';
import { I18nProvider, Trans, registerMessages, setLocale, t, useLocale, useT } from './index.js';

afterEach(async () => {
  cleanup();
  await act(async () => {
    await setLocale('en');
  });
});

describe('React bindings', () => {
  it('<Trans> renders a plain message as text', () => {
    render(
      <p data-testid="p">
        <Trans k="docs.healthDocs.remoteEngineFixTest" />
      </p>,
    );
    expect(screen.getByTestId('p').textContent).toBe('Open the client in Settings and press Test.');
  });

  it('<Trans> renders rich text from a message with tags', async () => {
    registerMessages('nl', { 'common.save': 'Opslaan', 'test.rich': 'Open <link>Instellingen</link> voor {name}, <b>nu</b>.' });
    await act(async () => {
      await setLocale('nl');
    });
    render(
      <p data-testid="p">
        <Trans k="test.rich" values={{ name: <em>Plex</em> }} components={{ link: <a href="/settings" />, b: <strong /> }} />
      </p>,
    );
    const link = screen.getByRole('link', { name: 'Instellingen' });
    expect(link.getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Plex').tagName).toBe('EM');
    expect(screen.getByText('nu').tagName).toBe('STRONG');
    expect(screen.getByTestId('p').textContent).toBe('Open Instellingen voor Plex, nu.');
  });

  it('useT and I18nProvider re-render on a locale switch (state below the provider resets)', async () => {
    function Probe() {
      const tr = useT();
      const { locale, dir } = useLocale();
      const [clicks] = useState(() => Math.random());
      return (
        <span data-testid="probe" data-clicks={clicks}>
          {tr('common.save')} · {locale} · {dir}
        </span>
      );
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('Save · en · ltr');
    await act(async () => {
      await setLocale('de');
    });
    expect(screen.getByTestId('probe').textContent).toBe('[de] Save · de · ltr');
  });

  it('status chips keep the English vocabulary in en and translate in other locales', async () => {
    const { rerender } = render(<StatusChip status="failed" cause="sample only" />);
    expect(screen.getByText('Failed · sample only')).toBeTruthy();
    await act(async () => {
      await setLocale('de');
    });
    rerender(<StatusChip status="cutoffUnmet" />);
    expect(screen.getByText('[de] Cutoff unmet')).toBeTruthy();
    expect(t('status.cutoffUnmet')).toBe('[de] Cutoff unmet');
  });
});
