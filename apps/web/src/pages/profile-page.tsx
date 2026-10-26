import { displayNameOf, useAuth } from '../auth/auth-context.js';
import { Badge } from '../components/badge.js';
import { Card } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { Facts } from '../components/media/media-ui.js';
import { Page } from '../components/page.js';
import { quotaSummary, UserRequestSettingsForm } from '../features/requests/user-editors.js';
import { useUserQuota } from '../hooks/requests.js';

/**
 * The signed-in user's own page (reachable by role `user`; it is not under /settings):
 * account facts, request quota usage and personal notification / Plex watchlist settings.
 */
export function ProfilePage() {
  const { user, session } = useAuth();
  const quota = useUserQuota(user?.id ?? null);

  if (!user) {
    return (
      <Page title="Profile">
        <Card>
          <EmptyState title="No user account">
            <p className="muted">You are signed in via {session?.via ?? 'an unknown method'}; personal settings need a user account.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Profile" subtitle={displayNameOf(user, session)}>
      <div className="stack">
        <div className="grid">
          <Card title="Account">
            <Facts
              items={[
                ['Username', user.username],
                ['Email', user.email ?? '—'],
                ['Role', <Badge key="r" tone={user.role === 'admin' ? 'info' : 'neutral'}>{user.role}</Badge>],
              ]}
            />
          </Card>
          <Card title="Request quota">
            {quota.data ? (
              quota.data.exempt ? (
                <p className="muted">You are exempt from request quotas.</p>
              ) : (
                <Facts
                  items={[
                    ['Movies', quotaSummary(quota.data.status.movie)],
                    ['Series', quotaSummary(quota.data.status.series)],
                  ]}
                />
              )
            ) : (
              <p className="muted">{quota.isError ? 'Quota information is unavailable.' : 'Loading…'}</p>
            )}
          </Card>
        </div>
        <Card title="Notifications and watchlist">
          <UserRequestSettingsForm userId={user.id} />
        </Card>
      </div>
    </Page>
  );
}
