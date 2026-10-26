import type { QuotaInfo } from '@arclight/shared';
import { displayNameOf, useAuth } from '../auth/auth-context.js';
import { Chip, EmptyState, KeyValue, Meter, PageHeader, Pane, Skeleton } from '../arclight/index.js';
import { quotaSummary, UserRequestSettingsForm } from '../features/requests/user-editors.js';
import { useUserQuota } from '../hooks/requests.js';
import '../components/media/media-kit.css';

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
        {info.restricted ? <Chip tone="warn">Limit reached</Chip> : null}
      </div>
      {pct === null ? (
        <span className="al-caption">
          <span className="al-num">{info.used}</span> used · unlimited
        </span>
      ) : (
        <Meter value={pct} tone={info.restricted ? 'warn' : 'default'} label={`${label} quota`} valueText={quotaSummary(info)} />
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

  if (!user) {
    return (
      <>
        <PageHeader title="Profile" />
        <EmptyState title="No user account">You are signed in via {session?.via ?? 'an unknown method'}. Personal settings need a user account.</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Profile" subtitle={displayNameOf(user, session)} />
      <div className="mk-stack">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 20 }}>
          <Pane title="Account">
            <KeyValue
              items={[
                { label: 'Username', value: user.username },
                { label: 'Email', value: user.email ?? '—' },
                { label: 'Role', value: <Chip tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role === 'admin' ? 'Admin' : 'User'}</Chip>, mono: false },
              ]}
            />
          </Pane>
          <Pane title="Request quota">
            {quota.data ? (
              quota.data.exempt ? (
                <p className="al-caption" style={{ margin: 0 }}>
                  You are exempt from request quotas.
                </p>
              ) : (
                <div className="mk-stack-sm" style={{ gap: 16 }}>
                  <QuotaRow label="Movies" info={quota.data.status.movie} />
                  <QuotaRow label="Series" info={quota.data.status.series} />
                </div>
              )
            ) : quota.isError ? (
              <p className="al-caption" style={{ margin: 0 }}>
                Quota information is unavailable.
              </p>
            ) : (
              <Skeleton lines={2} />
            )}
          </Pane>
        </div>
        <Pane title="Notifications and watchlist">
          <UserRequestSettingsForm userId={user.id} />
        </Pane>
      </div>
    </>
  );
}
