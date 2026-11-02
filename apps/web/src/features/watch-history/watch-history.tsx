import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NowPlayingEntry, WatchedByEntry, WatchEvent, WatchEventType } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { errorMessage } from '../../api/client.js';
import { authKeys } from '../../auth/guard.js';
import { useAuth } from '../../auth/auth-context.js';
import { Button, Chip, EmptyState, ErrorBlock, Meter, PageHeader, Pane, Select, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useNowPlaying, useWatchedBy, useWatchHistory } from '../../hooks/watch-history.js';
import { t } from '../../i18n/index.js';
import { formatDateTime } from '../../lib/format.js';

// Watch history from Jellyfin/Emby (GET /watchhistory): the admin page (Activity → Watch
// history, every user, filter by user), the user's own list in Profile, the "Watched by" tab on
// library movies and series (GET /watchhistory/title/...) and the dashboard's Now playing card.

const PAGE_SIZE = 25;

const TYPE_TONES: Record<WatchEventType, ChipTone> = { start: 'accent', progress: 'neutral', stop: 'neutral', played: 'default', unplayed: 'muted' };

export function eventTypeLabel(type: WatchEventType): string {
  switch (type) {
    case 'start':
      return t('watchHistory.typeStart');
    case 'progress':
      return t('watchHistory.typeProgress');
    case 'stop':
      return t('watchHistory.typeStop');
    case 'played':
      return t('watchHistory.typePlayed');
    case 'unplayed':
      return t('watchHistory.typeUnplayed');
  }
}

/** "Show · S01E02 · Pilot" for episodes, the title otherwise. */
export function watchTitle(e: Pick<WatchEvent, 'title' | 'seriesTitle' | 'seasonNumber' | 'episodeNumber' | 'itemType'>): string {
  if (e.itemType !== 'episode') return e.title;
  const code = e.seasonNumber !== null && e.episodeNumber !== null ? `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}` : null;
  return [e.seriesTitle, code, e.title].filter(Boolean).join(' · ');
}

/** "42 min" from milliseconds; null when unknown. */
export function minutes(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : t('watchHistory.minutes', { count: Math.round(ms / 60_000) });
}

/** A page of history. Admins see everyone unless `userId` filters; other users always get their own (the api scopes it). */
export function WatchHistoryTable({ userId, showUser }: { userId?: number | undefined; showUser: boolean }) {
  const [page, setPage] = useState(1);
  const history = useWatchHistory({ page, pageSize: PAGE_SIZE, ...(userId !== undefined ? { userId } : {}) });
  const columns: Column<WatchEvent>[] = [
    { key: 'at', header: t('watchHistory.when'), mono: true, cell: (e) => formatDateTime(e.at) },
    ...(showUser ? [{ key: 'user', header: t('common.user'), cell: (e: WatchEvent) => e.user?.arclightUsername ?? e.user?.name ?? '—' }] : []),
    { key: 'type', header: t('watchHistory.event'), cell: (e) => <Chip tone={TYPE_TONES[e.type]}>{eventTypeLabel(e.type)}</Chip> },
    { key: 'title', header: t('common.title'), cell: (e) => watchTitle(e) },
    { key: 'device', header: t('watchHistory.device'), muted: true, cell: (e) => [e.client, e.device].filter(Boolean).join(' · ') || '—' },
  ];
  if (history.isError) {
    return (
      <ErrorBlock title={t('watchHistory.couldNotLoad')} onRetry={() => void history.refetch()}>
        {errorMessage(history.error)}
      </ErrorBlock>
    );
  }
  const total = history.data?.totalRecords ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="mk-stack-sm">
      <div className="al-ms-table">
        <Table
          caption={t('watchHistory.title')}
          columns={columns}
          rows={history.data?.records}
          rowKey={(e) => e.id}
          loading={history.isPending}
          empty={<EmptyState title={t('watchHistory.empty')}>{t('watchHistory.emptyBody')}</EmptyState>}
        />
      </div>
      {pages > 1 ? (
        <div className="mk-row" style={{ gap: 8, alignItems: 'center' }}>
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('watchHistory.previous')}
          </Button>
          <span className="al-caption">{t('watchHistory.pageOf', { page, pages })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t('watchHistory.next')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Activity → Watch history (admins): everyone's plays, filterable by user. */
export function WatchHistoryPage() {
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, retry: false });
  const [userId, setUserId] = useState<number | undefined>(undefined);
  return (
    <>
      <PageHeader
        title={t('watchHistory.title')}
        actions={
          users.data ? (
            <Select aria-label={t('watchHistory.filterUser')} value={userId === undefined ? '' : String(userId)} onChange={(e) => setUserId(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}>
              <option value="">{t('watchHistory.allUsers')}</option>
              {users.data.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.displayName ?? u.username}
                </option>
              ))}
            </Select>
          ) : null
        }
      />
      <WatchHistoryTable key={userId ?? 'all'} userId={userId} showUser={userId === undefined} />
    </>
  );
}

/** Library movie/series tab (admins): who watched it, across servers. */
export function WatchedByPanel({ mediaType, id }: { mediaType: 'movie' | 'series'; id: number }) {
  const watched = useWatchedBy(mediaType, id);
  const columns: Column<WatchedByEntry>[] = [
    { key: 'user', header: t('common.user'), cell: (w) => w.user.arclightUsername ?? w.user.name },
    {
      key: 'state',
      header: t('common.state'),
      cell: (w) =>
        w.played ? (
          <Chip tone="default">{t('watchHistory.watched')}</Chip>
        ) : w.episodes ? (
          <span className="al-caption">{t('watchHistory.episodesOf', { played: w.episodes.played, total: w.episodes.total })}</span>
        ) : w.positionMs > 0 ? (
          <span className="al-caption">{t('watchHistory.inProgress', { at: minutes(w.positionMs) ?? '' })}</span>
        ) : (
          <Chip tone="muted">{t('watchHistory.favourite')}</Chip>
        ),
    },
    { key: 'plays', header: t('watchHistory.plays'), mono: true, cell: (w) => String(w.playCount) },
    { key: 'last', header: t('watchHistory.lastPlayed'), mono: true, cell: (w) => (w.lastPlayedAt ? formatDateTime(w.lastPlayedAt) : '—') },
    { key: 'server', header: t('watchHistory.server'), muted: true, cell: (w) => w.serverName },
  ];
  if (watched.isError) return <p className="al-caption">{errorMessage(watched.error)}</p>;
  return (
    <div className="al-ms-table">
      <Table
        caption={t('watchHistory.watchedBy')}
        columns={columns}
        rows={watched.data}
        rowKey={(w) => `${w.serverId}:${w.user.mediaServerUserId}`}
        loading={watched.isPending}
        empty={<EmptyState title={t('watchHistory.nobodyYet')} />}
      />
    </div>
  );
}

function progressOf(e: NowPlayingEntry): number | null {
  if (e.positionMs === null || !e.durationMs) return null;
  return Math.min(100, (e.positionMs / e.durationMs) * 100);
}

/** Dashboard card (admins): sessions the Jellyfin plugin reports as playing; hidden when none. */
export function NowPlayingPane() {
  const { isAdmin } = useAuth();
  const playing = useNowPlaying(isAdmin);
  if (!isAdmin || !playing.data || playing.data.length === 0) return null;
  return (
    <Pane title={t('watchHistory.nowPlaying')} aria-label={t('watchHistory.nowPlaying')}>
      <ul className="mk-stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {playing.data.map((e) => {
          const pct = progressOf(e);
          return (
            <li key={`${e.sessionId}:${e.title}`} className="mk-stack-sm" style={{ gap: 4 }}>
              <span className="al-body">{watchTitle(e)}</span>
              <span className="al-caption">
                {[e.user?.arclightUsername ?? e.user?.name, e.client, e.device, e.playMethod === 'Transcode' ? t('watchHistory.transcoding') : null].filter(Boolean).join(' · ')}
              </span>
              {pct !== null ? <Meter value={pct} label={t('watchHistory.progressOf', { title: e.title })} /> : null}
            </li>
          );
        })}
      </ul>
    </Pane>
  );
}
