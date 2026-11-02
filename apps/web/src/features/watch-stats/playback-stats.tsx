import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { PlaybackStats, PlaybackTitle, PlaybackUser } from '@arclight/shared';
import { usersApi } from '../../api/auth.js';
import { errorMessage } from '../../api/client.js';
import { useAuth } from '../../auth/auth-context.js';
import { authKeys } from '../../auth/guard.js';
import { Button, EmptyState, ErrorBlock, PageHeader, Pane, Segmented, Select, Skeleton, Table, Tabs, type Column } from '../../arclight/index.js';
import { useLibraryGrowth, usePlaybackStats } from '../../hooks/watch-stats.js';
import { intlLocale, t } from '../../i18n/index.js';
import { formatDateTime } from '../../lib/format.js';
import { AddedChart, BarChart, Heatmap, ShareList, StorageChart } from './charts.js';
import { bucketRows, dayLabel, fillPlayDays, hours, PERIODS, playMethodRows, watchTime, type Period } from './stats-model.js';
import { WrappedView } from './wrapped.js';
import './watch-stats.css';

// Playback stats over the watch history (GET /watchstats): Activity → Playback stats for
// admins (server-wide or one user, with library growth) and the "My stats" pane in Profile for
// everyone (the api scopes non-admins to their own plays). Year in review lives in wrapped.tsx.

function Tiles({ stats }: { stats: PlaybackStats }) {
  const tiles = [
    { key: 'plays', label: t('watchStats.plays'), value: stats.totals.plays.toLocaleString(intlLocale()), caption: t('watchStats.moviesEpisodes', { movies: stats.totals.movies, episodes: stats.totals.episodes }) },
    { key: 'hours', label: t('watchStats.hoursWatched'), value: hours(stats.totals.watchMs), caption: watchTime(stats.totals.watchMs) },
    { key: 'titles', label: t('watchStats.titles'), value: stats.totals.titles.toLocaleString(intlLocale()), caption: t('watchStats.distinctTitles') },
    { key: 'users', label: t('watchStats.viewers'), value: stats.totals.users.toLocaleString(intlLocale()), caption: t('watchStats.distinctViewers') },
  ];
  return (
    <div className="ws-tiles" role="list" aria-label={t('watchStats.totals')}>
      {tiles.map((c) => (
        <Pane key={c.key} className="ws-tile" role="listitem" aria-label={c.label}>
          <div className="al-label">{c.label}</div>
          <div className="ws-tile__value al-num">{c.value}</div>
          <div className="al-caption">{c.caption}</div>
        </Pane>
      ))}
    </div>
  );
}

function TitleCell({ item, links }: { item: PlaybackTitle; links: boolean }) {
  const text = item.year ? `${item.title} (${item.year})` : item.title;
  if (links && item.movieId !== null) {
    return (
      <Link className="al-link" to="/library/movie/$id" params={{ id: String(item.movieId) }}>
        {text}
      </Link>
    );
  }
  if (links && item.seriesId !== null) {
    return (
      <Link className="al-link" to="/library/series/$id" params={{ id: String(item.seriesId) }}>
        {text}
      </Link>
    );
  }
  return <>{text}</>;
}

export function TopTitles({ title, items, links, viewers }: { title: string; items: readonly PlaybackTitle[]; links: boolean; viewers: boolean }) {
  const columns: Column<PlaybackTitle>[] = [
    { key: 'title', header: t('common.title'), mobile: 'primary', cell: (i) => <TitleCell item={i} links={links} /> },
    { key: 'plays', header: t('watchStats.plays'), mono: true, align: 'right', cell: (i) => i.plays },
    { key: 'time', header: t('watchStats.watchTime'), mono: true, align: 'right', cell: (i) => watchTime(i.watchMs) },
    ...(viewers ? [{ key: 'users', header: t('watchStats.viewers'), mono: true, align: 'right' as const, cell: (i: PlaybackTitle) => i.users }] : []),
    { key: 'last', header: t('watchStats.lastPlayed'), mono: true, muted: true, cell: (i) => (i.lastPlayedAt ? formatDateTime(i.lastPlayedAt) : '—') },
  ];
  return (
    <Pane title={title} aria-label={title} flush>
      <Table caption={title} columns={columns} rows={items} rowKey={(i) => i.key} density="dense" empty={<EmptyState title={t('watchStats.nothingYet')} />} />
    </Pane>
  );
}

function UsersPane({ users, onPick }: { users: readonly PlaybackUser[]; onPick: (id: number) => void }) {
  const columns: Column<PlaybackUser>[] = [
    {
      key: 'name',
      header: t('common.user'),
      mobile: 'primary',
      cell: (u) =>
        u.arclightUserId !== null ? (
          <Button size="sm" variant="ghost" className="ws-user-link" onClick={() => onPick(u.arclightUserId!)} aria-label={t('watchStats.showUser', { name: u.name })}>
            {u.name}
          </Button>
        ) : (
          u.name
        ),
    },
    { key: 'plays', header: t('watchStats.plays'), mono: true, align: 'right', cell: (u) => u.plays },
    { key: 'time', header: t('watchStats.watchTime'), mono: true, align: 'right', cell: (u) => watchTime(u.watchMs) },
    { key: 'last', header: t('watchStats.lastPlayed'), mono: true, muted: true, cell: (u) => (u.lastPlayedAt ? formatDateTime(u.lastPlayedAt) : '—') },
  ];
  return (
    <Pane title={t('watchStats.mostActiveUsers')} aria-label={t('watchStats.mostActiveUsers')} flush>
      <Table caption={t('watchStats.mostActiveUsers')} columns={columns} rows={users} rowKey={(u) => u.key} density="dense" empty={<EmptyState title={t('watchStats.nothingYet')} />} />
    </Pane>
  );
}

function GrowthPanes({ days }: { days: number }) {
  const growth = useLibraryGrowth(Math.max(30, days));
  if (growth.isPending) return <Skeleton lines={3} />;
  if (growth.isError) {
    return (
      <ErrorBlock title={t('watchStats.couldNotLoadGrowth')} onRetry={() => void growth.refetch()}>
        {errorMessage(growth.error)}
      </ErrorBlock>
    );
  }
  const { snapshots, added } = growth.data;
  return (
    <div className="ws-grid">
      <Pane title={t('watchStats.storageGrowth')} aria-label={t('watchStats.storageGrowth')}>
        {snapshots.length > 1 ? <StorageChart snapshots={snapshots} /> : <p className="al-caption">{t('watchStats.notEnoughSnapshots')}</p>}
      </Pane>
      <Pane title={t('watchStats.addedPerMonth')} aria-label={t('watchStats.addedPerMonth')}>
        {added.length > 0 ? <AddedChart added={added} /> : <p className="al-caption">{t('watchStats.nothingYet')}</p>}
      </Pane>
    </div>
  );
}

export interface PlaybackStatsViewProps {
  days: number;
  /** Admins: one user (undefined = the whole server). Others: ignored (the api answers their own). */
  userId?: number | undefined;
  /** Library links, viewers columns, most active users and growth. */
  admin: boolean;
  onPickUser?: ((id: number) => void) | undefined;
}

/** Totals, play methods, top lists, breakdowns, per-day chart and the weekday/hour heatmap. */
export function PlaybackStatsView({ days, userId, admin, onPickUser }: PlaybackStatsViewProps) {
  const stats = usePlaybackStats({ days, ...(userId !== undefined ? { userId } : {}) });
  if (stats.isPending) return <Skeleton lines={6} />;
  if (stats.isError) {
    return (
      <ErrorBlock title={t('watchStats.couldNotLoad')} onRetry={() => void stats.refetch()}>
        {errorMessage(stats.error)}
      </ErrorBlock>
    );
  }
  const s = stats.data;
  const serverWide = s.userId === null;
  const perDay = fillPlayDays(s.perDay, s.from, s.to);
  const playsText = (r: { value: number }) => t('watchStats.playsCount', { count: r.value });
  return (
    <div className="ws-stack">
      <Tiles stats={s} />
      {s.totals.plays === 0 ? <EmptyState title={t('watchStats.noPlays')}>{t('watchStats.noPlaysBody')}</EmptyState> : null}
      <Pane title={t('watchStats.playsPerDay')} aria-label={t('watchStats.playsPerDay')}>
        <BarChart
          label={t('watchStats.playsPerDayLabel', { days: perDay.length, count: s.totals.plays })}
          bars={perDay.map((d) => ({ key: d.date, label: d.date.slice(5), value: d.plays, title: t('watchStats.dayTooltip', { date: dayLabel(d.date), count: d.plays, time: watchTime(d.watchMs) }) }))}
        />
      </Pane>
      <div className="ws-grid">
        <Pane title={t('watchStats.playMethods')} aria-label={t('watchStats.playMethods')}>
          <ShareList rows={playMethodRows(s.playMethods)} label={t('watchStats.playMethods')} valueText={playsText} />
        </Pane>
        <Pane title={t('watchStats.whenWatched')} aria-label={t('watchStats.whenWatched')}>
          <Heatmap grid={s.heatmap} />
        </Pane>
      </div>
      <div className="ws-grid">
        <TopTitles title={t('watchStats.topMovies')} items={s.topMovies} links={admin} viewers={admin && serverWide} />
        <TopTitles title={t('watchStats.topSeries')} items={s.topSeries} links={admin} viewers={admin && serverWide} />
      </div>
      <div className="ws-grid ws-grid--3">
        <Pane title={t('watchStats.topGenres')} aria-label={t('watchStats.topGenres')}>
          <ShareList rows={bucketRows(s.topGenres)} label={t('watchStats.topGenres')} valueText={playsText} />
        </Pane>
        <Pane title={t('watchStats.clients')} aria-label={t('watchStats.clients')}>
          <ShareList rows={bucketRows(s.clients)} label={t('watchStats.clients')} valueText={playsText} />
        </Pane>
        <Pane title={t('watchStats.devices')} aria-label={t('watchStats.devices')}>
          <ShareList rows={bucketRows(s.devices)} label={t('watchStats.devices')} valueText={playsText} />
        </Pane>
      </div>
      {admin && serverWide && s.users.length > 0 ? <UsersPane users={s.users} onPick={(id) => onPickUser?.(id)} /> : null}
      {admin && serverWide ? (
        <section className="ws-stack" aria-label={t('watchStats.libraryGrowth')}>
          <h2 className="al-label ws-section-title">{t('watchStats.libraryGrowth')}</h2>
          <GrowthPanes days={days} />
        </section>
      ) : null}
    </div>
  );
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <Segmented
      variant="soft"
      aria-label={t('watchStats.period')}
      value={String(value)}
      onChange={(v) => onChange(Number(v) as Period)}
      options={PERIODS.map((d) => ({ value: String(d), label: t('watchStats.periodDays', { days: d }) }))}
    />
  );
}

/** Activity → Playback stats (/activity/playbackstats, admins): server-wide or per user, plus Year in review. */
export function PlaybackStatsPage() {
  const { user } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, retry: false });
  const [tab, setTab] = useState('stats');
  const [days, setDays] = useState<Period>(30);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const wrappedUser = userId ?? user?.id;
  const userFilter = users.data ? (
    <Select aria-label={t('watchStats.filterUser')} value={userId === undefined ? '' : String(userId)} onChange={(e) => setUserId(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}>
      <option value="">{tab === 'stats' ? t('watchStats.wholeServer') : t('watchStats.me')}</option>
      {users.data.map((u) => (
        <option key={u.id} value={String(u.id)}>
          {u.displayName ?? u.username}
        </option>
      ))}
    </Select>
  ) : null;
  return (
    <>
      <PageHeader
        title={t('watchStats.title')}
        actions={
          <div className="ws-controls">
            {tab === 'stats' ? <PeriodPicker value={days} onChange={setDays} /> : null}
            {userFilter}
          </div>
        }
      />
      <Tabs
        aria-label={t('watchStats.title')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'stats', label: t('watchStats.statsTab'), content: <PlaybackStatsView key={userId ?? 'all'} days={days} userId={userId} admin onPickUser={setUserId} /> },
          {
            id: 'wrapped',
            label: t('watchStats.wrappedTab'),
            content:
              wrappedUser !== undefined ? <WrappedView key={wrappedUser} userId={userId} /> : <EmptyState title={t('watchStats.wrapped.pickUser')} />,
          },
        ]}
      />
    </>
  );
}

/** Profile → My stats: the signed-in user's own stats and Year in review. */
export function MyStatsPanel() {
  const [tab, setTab] = useState('stats');
  const [days, setDays] = useState<Period>(30);
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="ws-stack">
      <Tabs
        aria-label={t('watchStats.myStats')}
        value={tab}
        onChange={setTab}
        compact
        tabs={[
          {
            id: 'stats',
            label: t('watchStats.statsTab'),
            content: (
              <div className="ws-stack">
                <div className="ws-controls">
                  <PeriodPicker value={days} onChange={setDays} />
                </div>
                <PlaybackStatsView days={days} userId={user.id} admin={false} />
              </div>
            ),
          },
          { id: 'wrapped', label: t('watchStats.wrappedTab'), content: <WrappedView /> },
        ]}
      />
    </div>
  );
}
