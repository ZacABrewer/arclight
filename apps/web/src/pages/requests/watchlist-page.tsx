import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { authKeys } from '../../auth/guard.js';
import { Button, EmptyState, PageHeader, Select } from '../../arclight/index.js';
import { PosterSkeletons, QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { usePermissions } from '../../features/requests/status.js';
import { useRemoveFromWatchlist, useSyncWatchlists, useWatchlist } from '../../hooks/requests.js';
import { DiscoverCard } from '../discover/discover-kit.js';
import '../../components/media/media-kit.css';
import { t } from '../../i18n/index.js';

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
    <>
      <PageHeader
        index="03"
        title={t('common.watchlist')}
        subtitle={list.data ? <><span className="al-num">{list.data.length}</span> {t('requests.watchlist.titles')}</> : undefined}
        actions={
          <>
            {canViewOthers && users.data ? (
              <Select
                aria-label={t('requests.watchlist.whoseWatchlist')}
                value={userId === undefined ? '' : String(userId)}
                onChange={(e) => setUserId(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}
              >
                <option value="">{t('requests.watchlist.myWatchlist')}</option>
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
                    onSuccess: (r) => toast.push({ tone: 'ok', title: t('requests.watchlist.watchlistsSynced'), message: t('requests.watchlist.usersUsersAddedAddedRequested', { users: r.users, added: r.added, requested: r.requested }) }),
                  })
                }
              >
                {t('common.syncNow')}
              </Button>
            ) : null}
          </>
        }
      />
      {list.isPending ? (
        <PosterSkeletons />
      ) : list.isError ? (
        <QueryError error={list.error} title={t('requests.watchlist.couldNotLoadTheWatchlist')} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState
          title={t('requests.watchlist.theWatchlistIsEmpty')}
          action={
            <Link className="al-btn al-btn--secondary" to="/discover">
              {t('requests.watchlist.discoverTitles')}
            </Link>
          }
        >
          {t('requests.watchlist.addTitlesFromTheirDiscover')}
        </EmptyState>
      ) : (
        <div className="mk-poster-grid" data-testid="watchlist-grid">
          {list.data.map((w) => (
            <DiscoverCard key={w.id} item={w} subtitle={w.source === 'manual' ? undefined : t('requests.watchlist.fromSource', { source: w.source })}>
              {own || canManageUsers ? (
                <Button size="sm" variant="ghost" aria-label={t('requests.watchlist.removeTitle', { title: w.title })} loading={remove.isPending && remove.variables === w.id} onClick={() => remove.mutate(w.id)}>
                  {t('common.remove')}
                </Button>
              ) : null}
            </DiscoverCard>
          ))}
        </div>
      )}
    </>
  );
}
