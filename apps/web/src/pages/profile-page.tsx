import { useState } from 'react';
import type { QuotaInfo } from '@arclight/shared';
import { displayNameOf, useAuth } from '../auth/auth-context.js';
import { Button, Chip, EmptyState, KeyValue, Meter, PageHeader, Pane, Skeleton } from '../arclight/index.js';
import { ChangePasswordDialog } from './change-password.js';
import { quotaSummary, UserPolicyEditor, UserRequestSettingsForm } from '../features/requests/user-editors.js';
import { DiscordLinkPanel } from '../features/requests/discord-link.js';
import { useUserQuota } from '../hooks/requests.js';
import { BrowserNotifications } from '../features/push/browser-notifications.js';
import { MediaServerLinkPanel } from '../features/requests/media-server-link.js';
import '../components/media/media-kit.css';
import { t } from '../i18n/index.js';

/** Percent of a limited quota used; null when unlimited. */
export function quotaPercent(info: Pick<QuotaInfo, 'limit' | 'used'>): number | null {
  if (!info.limit) return null;
  return Math.min(100, (info.used / info.limit) * 100);
}

function QuotaRow({ label, info }: { label: string; info: QuotaInfo }) {
  const pct = quotaPercent(info);
  return (
    <div className="mk-stack-sm" style={{ gap: 6 }}>
      <div className="mk-row" style={{ justifyContent: 'space-between' }}>
        <span className="al-body">{label}</span>
        {info.restricted ? <Chip tone="warn">{t('profile.limitReached')}</Chip> : null}
      </div>
      {pct === null ? (
        <span className="al-caption">
          <span className="al-num">{info.used}</span> {t('profile.usedUnlimited')}
        </span>
      ) : (
        <Meter value={pct} tone={info.restricted ? 'warn' : 'default'} label={t('profile.labelQuota', { label })} valueText={quotaSummary(info)} />
      )}
    </div>
  );
}

/**
 * The signed-in user's own page (reachable by role `user`; it is not under /settings):
 * account facts, request quota meters and personal notification / Plex watchlist settings.
 */
export function ProfilePage() {
  const { user, session } = useAuth();
  const quota = useUserQuota(user?.id ?? null);
  const [changingPassword, setChangingPassword] = useState(false);

  if (!user) {
    return (
      <>
        <PageHeader title={t('common.profile')} />
        <EmptyState title={t('profile.noUserAccount')}>{t('profile.youAreSignedInVia', { value: session?.via ?? t('profile.anUnknownMethod') })}</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('common.profile')} subtitle={displayNameOf(user, session)} />
      <div className="mk-stack">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 20 }}>
          <Pane
            title={t('common.account')}
            actions={
              <Button size="sm" variant="secondary" onClick={() => setChangingPassword(true)}>
                {t('profile.changePassword')}
              </Button>
            }
          >
            <KeyValue
              items={[
                { label: t('common.username'), value: user.username },
                { label: t('common.email'), value: user.email ?? '—' },
                { label: t('common.role'), value: <Chip tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role === 'admin' ? t('common.admin') : t('common.user')}</Chip>, mono: false },
              ]}
            />
          </Pane>
          <Pane title={t('profile.requestQuota')}>
            {quota.data ? (
              quota.data.exempt ? (
                <p className="al-caption" style={{ margin: 0 }}>
                  {t('profile.youAreExemptFromRequest')}
                </p>
              ) : (
                <div className="mk-stack-sm" style={{ gap: 16 }}>
                  <QuotaRow label={t('common.movies')} info={quota.data.status.movie} />
                  <QuotaRow label={t('common.series')} info={quota.data.status.series} />
                </div>
              )
            ) : quota.isError ? (
              <p className="al-caption" style={{ margin: 0 }}>
                {t('profile.quotaInformationIsUnavailable')}
              </p>
            ) : (
              <Skeleton lines={2} />
            )}
          </Pane>
        </div>
        <Pane title={t('profile.mediaServerAccount')} aria-label={t('profile.mediaServerAccount')}>
          <MediaServerLinkPanel userId={user.id} isAdmin={session?.isAdmin ?? false} />
        </Pane>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 20 }}>
          <Pane title={t('profile.discord')} aria-label={t('profile.discord')}>
            <DiscordLinkPanel />
          </Pane>
          <Pane title={t('profile.contentAndApproval')} aria-label={t('profile.contentAndApproval')}>
            <UserPolicyEditor userId={user.id} readOnly />
          </Pane>
        </div>
        <Pane title={t('profile.browserNotifications')}>
          <BrowserNotifications />
        </Pane>
        <Pane title={t('profile.notificationsAndWatchlist')}>
          <UserRequestSettingsForm userId={user.id} />
        </Pane>
      </div>
      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} />
    </>
  );
}
