import { useEffect, useState } from 'react';
import { Banner, Button, Field, Input } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { findHttps, type FetchLike } from '../core/probe';
import { confirmationMatches, confirmationName, transportOf, transportPolicy, type TransportNeed } from '../core/transport';

// The server confirmation (cleartext policy, core/transport.ts): the host, whether the connection
// is encrypted, and what that means. Shown before a pairing link or QR code pairs, before a
// plain-http server is saved, and once for a saved http server on the internet.

export interface ServerCheckProps {
  url: string;
  /** Primary button text ("Pair", "Connect"). */
  acceptLabel: string;
  busy?: boolean | undefined;
  /** Called once the user accepted; the policy already has the answer. */
  onAccept: () => void;
  onCancel: () => void;
}

export function ServerCheck({ url, acceptLabel, busy, onAccept, onCancel }: ServerCheckProps) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const need: TransportNeed = transportPolicy.need(url);
  const host = confirmationName(url);
  const https = transportOf(url) === 'https';
  const downgrade = !https && transportPolicy.isPinnedHttps(url);
  const publicHttp = transportOf(url) === 'http-public';
  const ready = need !== 'confirm' || confirmationMatches(url, typed);

  const accept = async () => {
    if (!ready) return;
    if (need === 'confirm') await transportPolicy.confirm(url);
    else if (need === 'notice') await transportPolicy.noticed(url);
    onAccept();
  };

  return (
    <form
      className="app-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void accept();
      }}
      noValidate
    >
      <div className="app-server-check">
        <span className="al-label">{t('app.serverCheck.server')}</span>
        <span className="app-server-check__host">{host}</span>
        <span className="app-server-check__scheme" data-secure={https ? 'true' : 'false'}>
          {t(https ? 'app.serverCheck.secure' : 'app.serverCheck.plain')}
        </span>
      </div>
      {downgrade ? (
        <Banner tone="danger">{t('app.serverCheck.downgrade', { host })}</Banner>
      ) : publicHttp ? (
        <Banner tone="danger">{t('app.serverCheck.publicWarning')}</Banner>
      ) : !https ? (
        <Banner tone="warn">{t('app.serverCheck.lanNotice')}</Banner>
      ) : null}
      {need === 'confirm' ? (
        <Field label={t('app.serverCheck.typeHost', { host })}>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            mono
            size="lg"
          />
        </Field>
      ) : null}
      <Button type="submit" variant="primary" block loading={busy} disabled={!ready}>
        {acceptLabel}
      </Button>
      <Button variant="ghost" block onClick={onCancel}>
        {t('app.common.cancel')}
      </Button>
    </form>
  );
}

/**
 * `url`, or its https:// address when Arclight answers there (the policy prefers https). `url`
 * stays as given while checking (`checking`).
 */
export function usePreferHttps(url: string, enabled = true, fetchImpl: FetchLike = (u, init) => fetch(u, init)): { url: string; checking: boolean } {
  const wanted = enabled && !!url && transportOf(url) !== 'https';
  const [state, setState] = useState<{ for: string; url: string; checking: boolean }>(() => ({ for: url, url, checking: wanted }));
  useEffect(() => {
    if (!wanted) {
      setState({ for: url, url, checking: false });
      return;
    }
    let live = true;
    setState({ for: url, url, checking: true });
    void findHttps(fetchImpl, url)
      .catch(() => null)
      .then((secure) => {
        if (live) setState({ for: url, url: secure ?? url, checking: false });
      });
    return () => {
      live = false;
    };
    // fetchImpl is a test seam; a new function each render must not re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, wanted]);
  if (!wanted) return { url, checking: false };
  return state.for === url ? { url: state.url, checking: state.checking } : { url, checking: true };
}
