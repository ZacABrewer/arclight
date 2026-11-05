import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@web/arclight/index';
import { useT } from '@web/i18n/index';
import { useServices } from '../app/context';
import type { Account } from '../core/accounts';
import { connect } from '../core/probe';
import { reachesAccount } from '../core/server-route';
import { transportPolicy } from '../core/transport';
import { CONNECT_TIMEOUT_MS } from '../config';
import { hostOf } from './onboarding';

// An account's two addresses for its server (home network and internet). The first is tried each
// time the app opens and the other is used when it does not answer (core/server-route.ts). A new
// address is kept only when it is Arclight, may carry the token (core/transport.ts) and accepts
// this account's token for the same user.

export function ServerAddresses({ account, active }: { account: Account; active: boolean }) {
  const t = useT();
  const services = useServices();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = account.addresses ?? [account.serverUrl];

  const save = async (next: string[]) => {
    const before = account.serverUrl;
    await services.accounts.setAddresses(account.id, next);
    // The address in use was removed: the active session moves to the one left.
    if (active && services.accounts.active()?.serverUrl !== before) await services.switchAccount(null);
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await connect((u, init) => fetch(u, init), input);
      if (!res.ok) {
        setError(t(`app.addServer.error.${res.reason}`, { host: res.host ?? input }));
        return;
      }
      const host = hostOf(res.url);
      if (list.includes(res.url)) return setError(t('app.addresses.error.listed', { host }));
      if (res.needsSetup) return setError(t('app.addresses.error.otherServer', { host }));
      if (transportPolicy.need(res.url) === 'confirm') return setError(t('app.addresses.error.insecure', { host }));
      const token = await services.accounts.token(account.id);
      if (!token || !(await reachesAccount(account, token)(res.url, CONNECT_TIMEOUT_MS))) {
        return setError(t('app.addresses.error.otherServer', { host }));
      }
      await transportPolicy.noticed(res.url);
      await save([...list, res.url]);
      setInput('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-addresses">
      <p className="app-setting__hint">{t('app.addresses.hint')}</p>
      {list.length > 1 ? (
        <ol className="app-addresses__list">
          {list.map((url, i) => (
            <li key={url} className="app-addresses__item">
              <span className="app-addresses__host">
                {hostOf(url)}
                {i === 0 ? <span className="app-chip">{t('app.addresses.first')}</span> : null}
                {url === account.serverUrl ? <span className="app-chip">{t('app.addresses.inUse')}</span> : null}
              </span>
              <span className="app-row">
                {i > 0 ? (
                  <Button variant="secondary" onClick={() => void save([url, ...list.filter((u) => u !== url)])}>
                    {t('app.addresses.tryFirst')}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => void save(list.filter((u) => u !== url))}>
                  {t('app.addresses.remove')}
                </Button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <form className="app-addresses__add" onSubmit={(e) => void add(e)}>
          <Field label={t('app.addresses.second')} error={error ?? undefined}>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('app.addresses.placeholder')}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Button type="submit" variant="secondary" loading={busy} disabled={!input.trim()}>
            {t('app.addresses.add')}
          </Button>
        </form>
      )}
    </div>
  );
}
