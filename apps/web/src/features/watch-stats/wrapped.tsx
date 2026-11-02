import { useState } from 'react';
import type { Wrapped, WrappedShare } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { watchStatsApi } from '../../api/watch-stats.js';
import { useAuth } from '../../auth/auth-context.js';
import { Banner, Button, Chip, EmptyState, ErrorBlock, Input, KeyValue, Pane, Select, Skeleton, Table, type Column } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useToast } from '../../components/toast.js';
import { useCreateWrappedShare, useRevokeWrappedShare, useWatchStatsSettings, useWrapped, useWrappedShares } from '../../hooks/watch-stats.js';
import { intlLocale, t } from '../../i18n/index.js';
import { copyText } from '../../lib/clipboard.js';
import { formatDateTime } from '../../lib/format.js';
import { BarChart } from './charts.js';
import { dayLabel, hourLabel, hours, monthName, shareLink, watchTime, weekdayName } from './stats-model.js';

// Year in review (GET /watchstats/wrapped): highlights for one user and year, the SVG card
// download (GET /watchstats/wrapped/image.svg) and expiring share links
// (/watchstats/wrapped/shares). Non-admins always get their own; admins may pass a user.

function Highlights({ w }: { w: Wrapped }) {
  const tiles = [
    { key: 'hours', label: t('watchStats.hoursWatched'), value: hours(w.watchMs) },
    { key: 'plays', label: t('watchStats.plays'), value: w.plays.toLocaleString(intlLocale()) },
    { key: 'movies', label: t('common.movies'), value: w.movies.toLocaleString(intlLocale()) },
    { key: 'episodes', label: t('watchStats.episodes'), value: w.episodes.toLocaleString(intlLocale()) },
    { key: 'series', label: t('common.series'), value: w.series.toLocaleString(intlLocale()) },
    { key: 'days', label: t('watchStats.wrapped.activeDays'), value: w.activeDays.toLocaleString(intlLocale()) },
  ];
  return (
    <div className="ws-tiles ws-tiles--6" role="list" aria-label={t('watchStats.wrapped.highlights')}>
      {tiles.map((c) => (
        <Pane key={c.key} className="ws-tile" role="listitem" aria-label={c.label}>
          <div className="al-label">{c.label}</div>
          <div className="ws-tile__value al-num">{c.value}</div>
        </Pane>
      ))}
    </div>
  );
}

function TopList({ title, items }: { title: string; items: readonly { key: string; text: string; detail: string }[] }) {
  return (
    <Pane title={title} aria-label={title}>
      {items.length === 0 ? (
        <p className="al-caption">{t('watchStats.nothingYet')}</p>
      ) : (
        <ol className="ws-toplist">
          {items.map((i) => (
            <li key={i.key}>
              <span className="ws-toplist__text">{i.text}</span>
              <span className="al-caption al-num">{i.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </Pane>
  );
}

function Facts({ w }: { w: Wrapped }) {
  const dash = '—';
  return (
    <Pane title={t('watchStats.wrapped.facts')} aria-label={t('watchStats.wrapped.facts')}>
      <KeyValue
        layout="grid"
        columns={2}
        className="ws-kv"
        items={[
          { label: t('watchStats.wrapped.busiestMonth'), value: w.busiestMonth ? monthName(w.busiestMonth) : dash, mono: false },
          { label: t('watchStats.wrapped.favouriteWeekday'), value: w.favouriteWeekday !== null ? weekdayName(w.favouriteWeekday) : dash, mono: false },
          { label: t('watchStats.wrapped.favouriteHour'), value: w.favouriteHour !== null ? hourLabel(w.favouriteHour) : dash },
          { label: t('watchStats.wrapped.longestDay'), value: w.longestDay ? t('watchStats.wrapped.longestDayValue', { date: dayLabel(w.longestDay.date), time: watchTime(w.longestDay.watchMs) }) : dash, mono: false },
          { label: t('watchStats.wrapped.firstPlay'), value: w.firstPlay ? t('watchStats.wrapped.firstPlayValue', { title: w.firstPlay.title, date: dayLabel(w.firstPlay.at) }) : dash, mono: false },
          { label: t('watchStats.wrapped.topDevice'), value: w.topDevice ?? dash, mono: false },
          {
            label: t('watchStats.wrapped.percentile'),
            value: w.percentile !== null ? t('watchStats.wrapped.percentileValue', { value: w.percentile }) : t('watchStats.wrapped.onlyViewer'),
            mono: false,
          },
        ]}
      />
    </Pane>
  );
}

function ShareLinks({ year, userId }: { year: number; userId: number | undefined }) {
  const { isAdmin } = useAuth();
  // Only admins can read the settings; for everyone else a create answers 403 when links are off.
  const settings = useWatchStatsSettings(isAdmin);
  const shares = useWrappedShares(userId);
  const create = useCreateWrappedShare();
  const revoke = useRevokeWrappedShare();
  const toast = useToast();
  const [revoking, setRevoking] = useState<WrappedShare | null>(null);
  const disabled = settings.data ? !settings.data.wrapped.shareLinks : create.error instanceof ApiError && create.error.code === 'DISABLED';
  const copy = (link: string) =>
    void copyText(link).then((ok) => toast.push(ok ? { tone: 'ok', title: t('watchStats.wrapped.copied') } : { tone: 'error', title: t('watchStats.wrapped.copyFailed') }));

  const columns: Column<WrappedShare>[] = [
    {
      key: 'link',
      header: t('watchStats.wrapped.link'),
      mobile: 'primary',
      cell: (s) => <Input readOnly mono aria-label={t('watchStats.wrapped.linkFor', { year: s.year })} value={shareLink(s)} onFocus={(e) => e.currentTarget.select()} className="ws-share-input" />,
    },
    { key: 'year', header: t('common.year'), mono: true, cell: (s) => s.year },
    { key: 'expires', header: t('watchStats.wrapped.expires'), mono: true, muted: true, cell: (s) => formatDateTime(s.expiresAt) },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (s) => (
        <div className="ws-actions">
          <Button size="sm" variant="secondary" onClick={() => copy(shareLink(s))} aria-label={t('watchStats.wrapped.copyLinkFor', { year: s.year })}>
            {t('common.copy')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRevoking(s)} aria-label={t('watchStats.wrapped.revokeFor', { year: s.year })}>
            {t('watchStats.wrapped.revoke')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Pane
      title={t('watchStats.wrapped.shareLinks')}
      aria-label={t('watchStats.wrapped.shareLinks')}
      actions={
        disabled ? null : (
          <Button
            size="sm"
            variant="secondary"
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { year, ...(userId !== undefined ? { userId } : {}) },
                { onSuccess: (s) => copy(shareLink(s)) },
              )
            }
          >
            {t('watchStats.wrapped.createLink')}
          </Button>
        )
      }
    >
      {disabled ? <p className="al-caption">{t('watchStats.wrapped.shareLinksOff')}</p> : <p className="al-caption ws-intro">{t('watchStats.wrapped.shareLinksIntro', { days: settings.data?.wrapped.shareLinkDays ?? 14 })}</p>}
      {create.isError && !disabled ? (
        <p className="ws-error" role="alert">
          {errorMessage(create.error)}
        </p>
      ) : null}
      {shares.isError ? (
        <p className="al-caption">{errorMessage(shares.error)}</p>
      ) : (
        <Table
          caption={t('watchStats.wrapped.shareLinks')}
          columns={columns}
          rows={shares.data}
          rowKey={(s) => s.id}
          loading={shares.isPending}
          density="dense"
          empty={<EmptyState title={t('watchStats.wrapped.noLinks')} />}
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={t('watchStats.wrapped.revokeFor', { year: revoking?.year ?? year })}
        confirmLabel={t('watchStats.wrapped.revoke')}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
          setRevoking(null);
        }}
      >
        {t('watchStats.wrapped.revokeWarning')}
      </ConfirmDialog>
    </Pane>
  );
}

/** Year in review for `userId` (undefined: the signed-in user). */
export function WrappedView({ userId }: { userId?: number | undefined }) {
  const [year, setYear] = useState<number | undefined>(undefined);
  const wrapped = useWrapped({ year, userId });
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  if (wrapped.isPending) return <Skeleton lines={6} />;
  if (wrapped.isError) {
    return (
      <ErrorBlock title={t('watchStats.wrapped.couldNotLoad')} onRetry={() => void wrapped.refetch()}>
        {errorMessage(wrapped.error)}
      </ErrorBlock>
    );
  }
  const w = wrapped.data;
  const years = w.years.includes(w.year) ? w.years : [w.year, ...w.years];
  const download = async () => {
    setDownloading(true);
    try {
      await watchStatsApi.downloadImage({ year: w.year, userId });
    } catch (err) {
      toast.push({ tone: 'error', title: t('watchStats.wrapped.downloadFailed'), message: errorMessage(err) });
    } finally {
      setDownloading(false);
    }
  };
  const titleItems = (items: Wrapped['topMovies']) =>
    items.slice(0, 5).map((i) => ({ key: i.key, text: i.year ? `${i.title} (${i.year})` : i.title, detail: t('watchStats.wrapped.titleDetail', { count: i.plays, time: watchTime(i.watchMs) }) }));
  return (
    <div className="ws-stack">
      <div className="ws-wrapped-head">
        <div>
          <h2 className="al-title-m ws-wrapped-title">{t('watchStats.wrapped.heading', { name: w.name, year: w.year })}</h2>
          <p className="al-caption ws-intro">{t('watchStats.wrapped.summary', { time: watchTime(w.watchMs), count: w.plays })}</p>
        </div>
        <div className="ws-controls">
          <Select aria-label={t('watchStats.wrapped.year')} value={String(w.year)} onChange={(e) => setYear(Number(e.currentTarget.value))}>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </Select>
          <Button variant="secondary" loading={downloading} onClick={() => void download()}>
            {t('watchStats.wrapped.downloadImage')}
          </Button>
        </div>
      </div>
      {w.plays === 0 ? <Banner>{t('watchStats.wrapped.nothingThisYear')}</Banner> : null}
      <Highlights w={w} />
      <Pane title={t('watchStats.wrapped.watchTimePerMonth')} aria-label={t('watchStats.wrapped.watchTimePerMonth')}>
        <BarChart
          labelEvery
          label={t('watchStats.wrapped.monthlyLabel', { year: w.year })}
          format={(n) => hours(n * 3_600_000)}
          bars={w.monthly.map((ms, i) => ({ key: String(i + 1), label: monthName(i + 1, 'short').slice(0, 3), value: ms / 3_600_000, title: `${monthName(i + 1)}: ${watchTime(ms)}` }))}
        />
      </Pane>
      <div className="ws-grid ws-grid--3">
        <TopList title={t('watchStats.topMovies')} items={titleItems(w.topMovies)} />
        <TopList title={t('watchStats.topSeries')} items={titleItems(w.topSeries)} />
        <Pane title={t('watchStats.topGenres')} aria-label={t('watchStats.topGenres')}>
          {w.topGenres.length === 0 ? (
            <p className="al-caption">{t('watchStats.nothingYet')}</p>
          ) : (
            <div className="ws-chips">
              {w.topGenres.slice(0, 8).map((g) => (
                <Chip key={g.name} tone="neutral" dot="none">
                  {g.name} · {g.plays}
                </Chip>
              ))}
            </div>
          )}
        </Pane>
      </div>
      <Facts w={w} />
      <ShareLinks year={w.year} userId={userId} />
    </div>
  );
}
