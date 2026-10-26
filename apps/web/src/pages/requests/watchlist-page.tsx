import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { authKeys } from '../../auth/guard.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Select } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { useToast } from '../../components/toast.js';
import { DiscoverCard } from '../../features/requests/discover-ui.js';
import { usePermissions } from '../../features/requests/status.js';
import { useRemoveFromWatchlist, useSyncWatchlists, useWatchlist } from '../../hooks/requests.js';
import '../../features/requests/requests.css';

export function WatchlistPage() {
  const { can, userId: me } = usePermissions();
  const canViewOthers = can(Permission.WATCHLIST_VIEW);
  const canManageUsers = can(Permission.MANAGE_USERS);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, enabled: canViewOthers, retry: false });
  const list = useWatchlist(userId);
  const remove = useRemoveFromWatchlist();
  const sync = useSyncWatchlists();
  const toast = useToast();
  const own = userId === undefined || userId === me;

  return (
    <Page
      title="Watchlist"
      actions={
        <div className="row">
          {canViewOthers && users.data ? (
            <Select
              aria-label="Whose watchlist"
              value={userId === undefined ? '' : String(userId)}
              onChange={(e) => setUserId(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}
            >
              <option value="">My watchlist</option>
              {users.data
                .filter((u) => u.id !== me)
                .map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.displayName ?? u.username}
                  </option>
                ))}
            </Select>
          ) : null}
          {canManageUsers ? (
            <Button
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: (r) => toast.push({ tone: 'ok', title: 'Watchlists synced', message: `${r.users} users · ${r.added} added · ${r.requested} requested` }),
                })
              }
            >
              Sync now
            </Button>
          ) : null}
        </div>
      }
    >
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState title="The watchlist is empty">
            <p className="muted">Add titles from their Discover page, or link a Plex token on your profile to sync your Plex watchlist.</p>
          </EmptyState>
        </Card>
      ) : (
        <div className="poster-grid" data-testid="watchlist-grid">
          {list.data.map((w) => (
            <div key={w.id} className="stack-sm">
              <DiscoverCard item={w} subtitle={w.source === 'manual' ? undefined : w.source} />
              {own || canManageUsers ? (
                <Button size="sm" variant="ghost" aria-label={`Remove ${w.title}`} loading={remove.isPending && remove.variables === w.id} onClick={() => remove.mutate(w.id)}>
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
