import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { API_BASE } from '../../api/client.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Toggle } from '../../components/form.js';
import { EPISODE_STATUS_META, localIsoDate } from '../../components/media/episode-status.js';
import { formatDate } from '../../components/media/format.js';
import { Modal } from '../../components/modal.js';
import { Page } from '../../components/page.js';
import { Spinner } from '../../components/spinner.js';
import { useCalendar, useCalendarFeed } from '../../hooks/library-calendar.js';
import { cx } from '../../lib/cx.js';
import '../../components/media/media.css';
import {
  addMonths,
  gridRange,
  groupByDay,
  isSameDay,
  monthGrid,
  startOfMonth,
  weekdayLabels,
  type CalendarEntry,
} from './calendar-math.js';

type View = 'month' | 'agenda';

export function CalendarPage() {
  const [anchor, setAnchor] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<View>('month');
  const [unmonitored, setUnmonitored] = useState(false);
  const [icalOpen, setIcalOpen] = useState(false);

  const days = useMemo(() => monthGrid(anchor, 1), [anchor]);
  const range = useMemo(() => gridRange(days), [days]);
  const calendar = useCalendar(range.start, range.end, unmonitored);
  const byDay = useMemo(() => groupByDay(calendar.data ?? []), [calendar.data]);
  const today = new Date();
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <Page
      title="Calendar"
      actions={
        <Button size="sm" onClick={() => setIcalOpen(true)}>
          iCal link
        </Button>
      }
    >
      <div className="cal-head">
        <Button size="sm" aria-label="Previous month" onClick={() => setAnchor(addMonths(anchor, -1))}>
          ‹
        </Button>
        <Button size="sm" onClick={() => setAnchor(startOfMonth(new Date()))}>
          Today
        </Button>
        <Button size="sm" aria-label="Next month" onClick={() => setAnchor(addMonths(anchor, 1))}>
          ›
        </Button>
        <h2 className="cal-title">{monthLabel}</h2>
        {calendar.isFetching ? <Spinner inline size="sm" /> : null}
        <span className="toolbar-spacer" />
        <Toggle label="Show unmonitored" checked={unmonitored} onChange={(e) => setUnmonitored(e.target.checked)} />
        <div className="segmented" role="group" aria-label="Calendar view">
          <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>
            Month
          </button>
          <button type="button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>
            Agenda
          </button>
        </div>
      </div>

      {calendar.data === null ? (
        <p className="notice" role="status">
          The calendar endpoint is not available yet (calendar module not registered in the api).
        </p>
      ) : null}

      {calendar.isError ? (
        <ErrorView error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : view === 'month' ? (
        <div className="cal-grid" role="grid" aria-label={monthLabel}>
          {weekdayLabels(1).map((d) => (
            <div key={d} className="cal-weekday" role="columnheader">
              {d}
            </div>
          ))}
          {days.map((d) => {
            const key = localIsoDate(d);
            const entries = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="gridcell"
                aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}
                className={cx('cal-day', d.getMonth() !== anchor.getMonth() && 'cal-day-outside', isSameDay(d, today) && 'cal-day-today')}
              >
                <span className="cal-day-num">{d.getDate()}</span>
                {entries.map((e) => (
                  <EntryChip key={e.key} entry={e} />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <Agenda days={days.filter((d) => d.getMonth() === anchor.getMonth())} byDay={byDay} />
      )}

      <ICalDialog open={icalOpen} onClose={() => setIcalOpen(false)} />
    </Page>
  );
}

function EntryChip({ entry }: { entry: CalendarEntry }) {
  const meta = EPISODE_STATUS_META[entry.status];
  return (
    <Link
      {...entry.link}
      className={cx('cal-event', `cal-event-${entry.status}`, !entry.monitored && 'cal-event-unmonitored')}
      title={`${entry.title} — ${entry.detail}${entry.time ? ` · ${entry.time}` : ''} (${meta.label})`}
    >
      {entry.time ? `${entry.time} ` : ''}
      {entry.title}
    </Link>
  );
}

function Agenda({ days, byDay }: { days: Date[]; byDay: Map<string, CalendarEntry[]> }) {
  const withEntries = days.filter((d) => (byDay.get(localIsoDate(d))?.length ?? 0) > 0);
  if (withEntries.length === 0) {
    return (
      <Card>
        <EmptyState title="Nothing scheduled this month" />
      </Card>
    );
  }
  return (
    <div>
      {withEntries.map((d) => {
        const key = localIsoDate(d);
        return (
          <section key={key} className="agenda-day" aria-label={formatDate(key, { dateStyle: 'full' })}>
            <h3>{formatDate(key, { dateStyle: 'full' })}</h3>
            <Card flush>
              <table className="table">
                <tbody>
                  {(byDay.get(key) ?? []).map((e) => (
                    <tr key={e.key} className={e.monitored ? undefined : 'muted'}>
                      <td style={{ width: '90px' }}>{e.time ?? 'All day'}</td>
                      <td>
                        <Link {...e.link}>{e.title}</Link>
                      </td>
                      <td>{e.detail}</td>
                      <td className="align-right">
                        <span className={`badge badge-${EPISODE_STATUS_META[e.status].tone}`}>{EPISODE_STATUS_META[e.status].label}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

export interface FeedOptions {
  pastDays: number;
  futureDays: number;
  unmonitored: boolean;
}

/** Absolute iCal URL from the feed path the api reports plus the user's options. */
export function buildFeedUrl(origin: string, path: string, opts: FeedOptions): string {
  const base = path.startsWith('/api/') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const url = new URL(base, origin);
  url.searchParams.set('pastDays', String(opts.pastDays));
  url.searchParams.set('futureDays', String(opts.futureDays));
  if (opts.unmonitored) url.searchParams.set('unmonitored', 'true');
  return url.toString();
}

function ICalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const feed = useCalendarFeed(open);
  const [opts, setOpts] = useState<FeedOptions>({ pastDays: 7, futureDays: 28, unmonitored: false });
  const [copied, setCopied] = useState(false);
  // TODO(contract): if GET /calendar/feed is not served yet, show the documented default path.
  const path = feed.data?.path ?? '/calendar/feed.ics';
  const url = buildFeedUrl(location.origin, path, opts);

  return (
    <Modal open={open} onClose={onClose} title="iCal feed" size="md">
      <div className="stack">
        {feed.data === null ? (
          <p className="notice">The feed endpoint is not available yet; this is where it will live once the calendar module is registered.</p>
        ) : null}
        <div className="fields-row">
          <FormField label="Past days">
            <Input type="number" min={0} value={opts.pastDays} onChange={(e) => setOpts({ ...opts, pastDays: Math.max(0, Number(e.target.value)) })} />
          </FormField>
          <FormField label="Future days">
            <Input type="number" min={0} value={opts.futureDays} onChange={(e) => setOpts({ ...opts, futureDays: Math.max(0, Number(e.target.value)) })} />
          </FormField>
        </div>
        <Toggle label="Include unmonitored" checked={opts.unmonitored} onChange={(e) => setOpts({ ...opts, unmonitored: e.target.checked })} />
        <FormField label="Feed URL" hint="Subscribe to this URL in your calendar app.">
          <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </FormField>
        <div>
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
