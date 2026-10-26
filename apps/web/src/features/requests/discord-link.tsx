import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DiscordLinkCode, User } from '@arclight/shared';
import { authApi } from '../../api/auth.js';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, KeyValue } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { authKeys } from '../../auth/guard.js';
import { useToast } from '../../components/toast.js';
import { useCreateDiscordLinkCode, useUnlinkDiscord } from '../../hooks/discord-bot.js';
import { formatDateTime, formatRelative, t } from '../../i18n/index.js';
import './policy.css';

// Profile → Discord: create a one-time code for `/link <code>` in Discord, see whether this
// account is linked, and remove the link. The link lives in users.settings.discordUserId.

/** While a code is shown, re-read /auth/me this often to notice the `/link` in Discord. */
export const DISCORD_LINK_POLL_MS = 5000;

/** The Discord user id this Arclight user is linked to, from the user's settings. */
export function linkedDiscordId(user: Pick<User, 'settings'> | null | undefined): string | null {
  const id = user?.settings?.['discordUserId'];
  return typeof id === 'string' && id ? id : null;
}

/** Whether a link code is past its expiry at `now`. */
export function codeExpired(code: Pick<DiscordLinkCode, 'expiresAt'>, now: number = Date.now()): boolean {
  const at = new Date(code.expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/** Ticks once a second while `on`, so expiry text stays current. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export function DiscordLinkPanel() {
  const { user } = useAuth();
  const toast = useToast();
  const create = useCreateDiscordLinkCode();
  const unlink = useUnlinkDiscord();
  const [code, setCode] = useState<DiscordLinkCode | null>(null);
  const [copied, setCopied] = useState(false);
  const now = useNow(code !== null);
  const active = code !== null && !codeExpired(code, now);
  // Same key and fetcher as the AuthProvider, polled only while a code waits for `/link`.
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me, enabled: active, refetchInterval: active ? DISCORD_LINK_POLL_MS : false, retry: false });
  const linked = linkedDiscordId(me.data?.user ?? user);

  // The `/link` arrived: the linked id changed from what it was when the code was made.
  useEffect(() => {
    if (code && linked && linked !== code.linkedDiscordUserId) {
      setCode(null);
      toast.push({ tone: 'ok', title: t('features.requests.discordLink.linkedToast') });
    }
  }, [code, linked, toast]);

  const generate = () => {
    setCopied(false);
    create.mutate(undefined, { onSuccess: setCode });
  };
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`/link ${code.code}`);
      setCopied(true);
    } catch {
      // No clipboard (http, old browser): the code stays on screen to type by hand.
      setCopied(false);
    }
  };

  if (!user) return null;
  return (
    <div className="req-stack" data-testid="discord-link">
      <KeyValue
        items={[
          {
            label: t('common.status'),
            value: linked ? <Chip tone="accent">{t('features.requests.discordLink.linked')}</Chip> : <Chip tone="muted" dot="ring">{t('features.requests.discordLink.notLinked')}</Chip>,
            mono: false,
          },
          ...(linked ? [{ label: t('features.requests.discordLink.discordUserId'), value: linked }] : []),
        ]}
      />
      {active ? (
        <div className="req-stack" role="status" aria-label={t('features.requests.discordLink.codeLabel')}>
          <p className="al-caption" style={{ margin: 0 }}>
            {t('features.requests.discordLink.typeInDiscord')}
          </p>
          <p className="al-num" style={{ margin: 0, fontSize: 22, letterSpacing: '0.12em' }} data-testid="discord-code">
            /link {code.code}
          </p>
          <p className="al-caption" style={{ margin: 0 }}>
            {t('features.requests.discordLink.expires', { when: formatDateTime(code.expiresAt), relative: formatRelative(code.expiresAt, now) })}
          </p>
        </div>
      ) : code ? (
        <p className="al-caption" role="status" style={{ margin: 0 }}>
          {t('features.requests.discordLink.codeExpired')}
        </p>
      ) : (
        <p className="al-caption" style={{ margin: 0 }}>
          {linked ? t('features.requests.discordLink.relinkHelp') : t('features.requests.discordLink.help')}
        </p>
      )}
      {create.error ? (
        <p className="al-inline-error" role="alert">
          {errorMessage(create.error)}
        </p>
      ) : null}
      {unlink.error ? (
        <p className="al-inline-error" role="alert">
          {errorMessage(unlink.error)}
        </p>
      ) : null}
      <div className="req-actions">
        <Button variant={linked ? 'secondary' : 'primary'} loading={create.isPending} onClick={generate}>
          {active ? t('features.requests.discordLink.newCode') : t('features.requests.discordLink.createCode')}
        </Button>
        {active ? (
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? t('features.requests.discordLink.copied') : t('common.copy')}
          </Button>
        ) : null}
        {linked ? (
          <Button
            variant="danger"
            loading={unlink.isPending}
            onClick={() =>
              unlink.mutate(undefined, {
                onSuccess: () => {
                  setCode(null);
                  toast.push({ tone: 'ok', title: t('features.requests.discordLink.unlinkedToast') });
                },
              })
            }
          >
            {t('features.requests.discordLink.unlink')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
