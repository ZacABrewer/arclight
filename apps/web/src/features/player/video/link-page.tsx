import { useState, type FormEvent } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { APP_PAIR_CODE_ALPHABET, APP_PAIR_CODE_LENGTH, formatPairCode, normalisePairCode, type AppDeviceCodeApproveResponse } from '@arclight/shared';
import { Button, Icon, Input } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { PageTitle, PlayerLink } from '../browse/kit.js';
import { useApproveDeviceCode } from './api.js';
import { watchPaths } from './paths.js';
import './watch.css';

// /player/link: "Sign in a TV". The TV shows a code (and a QR code for /player/link?code=...);
// a signed-in user confirms it here and the TV signs in as them.

const VALID = new RegExp(`^[${APP_PAIR_CODE_ALPHABET}]{${APP_PAIR_CODE_LENGTH}}$`);

/** Typed text → "ABCD-EFGH" as it is typed (unknown characters dropped). */
export function tidyCode(raw: string): string {
  const clean = normalisePairCode(raw)
    .split('')
    .filter((c) => APP_PAIR_CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, APP_PAIR_CODE_LENGTH);
  return clean.length === APP_PAIR_CODE_LENGTH ? formatPairCode(clean) : clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function useCodeParam(): string {
  return useRouterState({
    select: (s) => {
      const raw = (s.location.search as Record<string, unknown> | undefined)?.code;
      return raw === undefined || raw === null ? '' : String(raw);
    },
  });
}

export function SignInTvPage() {
  const t = useT();
  const prefill = useCodeParam();
  const [code, setCode] = useState(() => tidyCode(prefill));
  const approve = useApproveDeviceCode();
  const [done, setDone] = useState<AppDeviceCodeApproveResponse | null>(null);
  const value = normalisePairCode(code);
  const valid = VALID.test(value);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    approve.mutate(value, { onSuccess: (res) => setDone(res) });
  };

  const status = (approve.error as { status?: number } | null)?.status;
  const errorText = approve.isError ? (status === 404 || status === 400 || status === 410 ? t('player.link.invalid') : t('player.link.failed')) : null;

  return (
    <div className="pb-page vw-link">
      <PageTitle eyebrow={t('player.link.eyebrow')}>{t('player.link.title')}</PageTitle>
      {done ? (
        <section className="vw-link__card" role="status">
          <span className="vw-link__ok" aria-hidden="true">
            <Icon name="check" size={24} />
          </span>
          <h2 className="vw-link__heading">{t('player.link.doneTitle')}</h2>
          <p className="pb-muted">{t('player.link.doneBody', { name: done.deviceName })}</p>
          <div className="vw-actions">
            <PlayerLink to={watchPaths.home} className="al-btn al-btn--primary">
              {t('player.video.title')}
            </PlayerLink>
            <Button
              onClick={() => {
                setDone(null);
                setCode('');
                approve.reset();
              }}
            >
              {t('player.link.another')}
            </Button>
          </div>
        </section>
      ) : (
        <form className="vw-link__card" onSubmit={submit} noValidate>
          <p className="pb-muted">{t('player.link.help')}</p>
          <label className="vw-link__field">
            <span className="pb-filters__label">{t('player.link.codeLabel')}</span>
            <Input
              className="vw-link__input"
              value={code}
              onChange={(e) => {
                setCode(tidyCode(e.target.value));
                if (approve.isError) approve.reset();
              }}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ABCD-EFGH"
              aria-invalid={errorText ? true : undefined}
              aria-describedby={errorText ? 'vw-link-error' : undefined}
              autoFocus
            />
          </label>
          {errorText ? (
            <p className="vw-link__error" id="vw-link-error" role="alert">
              {errorText}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" disabled={!valid} loading={approve.isPending}>
            {t('player.link.approve')}
          </Button>
        </form>
      )}
    </div>
  );
}
