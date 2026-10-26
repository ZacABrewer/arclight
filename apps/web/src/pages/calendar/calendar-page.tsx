import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { API_BASE } from '../../api/client.js';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pane,
  Popover,
  Poster,
  SectionLabel,
  Segmented,
  StatusChip,
  Toggle,
  buttonClass,
} from '../../arclight/index.js';
import { localIsoDate } from '../../components/media/episode-status.js';
import { formatDate } from '../../components/media/format.js';
import { Loading, QueryError, copyText, episodeChip, useIsMobile } from '../../components/media/media-kit.js';
import { useAutomaticSearch } from '../../hooks/library.js';
import { useCalendar, useCalendarFeed, useRegenerateCalendarFeed } from '../../hooks/library-calendar.js';
import { useUiPreferences } from '../../hooks/ui-preferences.js';
import { useAuth } from '../../auth/auth-context.js';
import { formatDate as formatPreferredDate, hourLabel, type TimeFormat, type WeekStartDay } from '../../lib/ui-preferences.js';
import {
  gridRange,
  groupByDay,
  isSameDay,
  startOfMonth,
  stepAnchor,
  viewDays,
  weekdayLabels,
  type CalendarEntry,
  type CalendarView,
} from './calendar-math.js';
import './calendar.css';

const VIEWS: ReadonlyArray<{ value: CalendarView; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
  { value: 'agenda', label: 'Agenda' },
];

/** Header title for a view: "October 2026", "20 – 26 Oct 2026", "Tue 20 Oct 2026". */
export function viewTitle(view: CalendarView, anchor: Date, days: readonly Date[]): string {
  if (view === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (view === 'week') {
    const first = days[0] ?? anchor;
    const last = days[days.length - 1] ?? anchor;
    return `${first.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function CalendarPage() {
  const mobile = useIsMobile();
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>('month');
  const [unmonitored, setUnmonitored] = useState(false);
  const [icalOpen, setIcalOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const prefs = useUiPreferences();
  const weekStart = prefs.firstDayOfWeek;

  useEffect(() => {
    document.title = 'Calendar · Arclight';
  }, []);

  // Agenda lists the anchor's month; the grid views their own range.
  // Phones have no room for the month grid: Month falls back to Agenda (same range).
  const shownView: CalendarView = mobile && view === 'month' ? 'agenda' : view;
  const viewOptions = mobile ? VIEWS.filter((v) => v.value !== 'month') : VIEWS;
  const days = useMemo(() => viewDays(view === 'agenda' ? 'month' : view, anchor, weekStart), [view, anchor, weekStart]);
  const range = useMemo(() => gridRange(days), [days]);
  const calendar = useCalendar(range.start, range.end, unmonitored);
  const byDay = useMemo(() => groupByDay(calendar.data ?? [], new Date(), prefs.timeFormat), [calendar.data, prefs.timeFormat]);
  const today = new Date();
  const title = viewTitle(view, anchor, days);
  const popover = { openKey, setOpenKey };

  return (
    <div className="cal-page">
      <PageHeader
        index="04"
        title={title}
        actions={
          <>
            <Legend />
            <Toggle size="sm" label="Show unmonitored" checked={unmonitored} onChange={(e) => setUnmonitored(e.target.checked)} />
            <Segmented variant="soft" aria-label="Calendar view" options={viewOptions} value={shownView} onChange={setView} />
            <Button onClick={() => setIcalOpen(true)}>iCal</Button>
          </>
        }
      >
        <div className="cal-nav">
          <Button size="sm" aria-label="Previous" icon={<Icon name="chevronLeft" />} onClick={() => setAnchor(stepAnchor(view === 'agenda' ? 'month' : view, anchor, -1))} />
          <Button size="sm" aria-label="Next" icon={<Icon name="chevronRight" />} onClick={() => setAnchor(stepAnchor(view === 'agenda' ? 'month' : view, anchor, 1))} />
          <Button size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
        </div>
      </PageHeader>

      {calendar.data === null ? <Banner tone="warn">The calendar endpoint is not available yet. Events appear once the calendar module is running.</Banner> : null}

      {calendar.isError ? (
        <QueryError error={calendar.error} onRetry={() => void calendar.refetch()} title="Could not load the calendar" />
      ) : calendar.isPending ? (
        <Loading />
      ) : view === 'month' && !mobile ? (
        <MonthGrid days={days} anchor={anchor} today={today} byDay={byDay} popover={popover} weekStart={weekStart} />
      ) : view === 'week' || view === 'day' ? (
        <TimeGrid days={days} today={today} byDay={byDay} popover={popover} timeFormat={prefs.timeFormat} />
      ) : (
        <Agenda days={days.filter((d) => d.getMonth() === startOfMonth(anchor).getMonth())} byDay={byDay} popover={popover} />
      )}

      <ICalDialog open={icalOpen} onClose={() => setIcalOpen(false)} />
    </div>
  );
}

function Legend() {
  return (
    <div className="cal-legend" aria-label="Legend">
      <span>
        <i data-tone="downloaded" aria-hidden="true" />
        Downloaded
      </span>
      <span>
        <i data-tone="upcoming" aria-hidden="true" />
        Upcoming
      </span>
      <span>
        <i data-tone="missing" aria-hidden="true" />
        Missing
      </span>
    </div>
  );
}

interface PopoverState {
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
}

/** Event bar + its 320px popover (poster, title, episode, chip, actions). */
function EventBar({ entry, popover, placement = 'bottom-start', block = false }: { entry: CalendarEntry; popover: PopoverState; placement?: 'bottom-start' | 'bottom-end' | 'top-start'; block?: boolean }) {
  const key = `${entry.day}-${entry.key}`;
  return (
    <Popover
      label={`${entry.title} ${entry.code}`}
      width={320}
      placement={placement}
      open={popover.openKey === key}
      onOpenChange={(o) => popover.setOpenKey(o ? key : null)}
      className="cal-popover"
      trigger={(props) => (
        <button
          type="button"
          className={block ? 'cal-event cal-event--block' : 'cal-event'}
          data-tone={entry.tone}
          data-unmonitored={entry.monitored ? undefined : true}
          aria-label={`${entry.title}, ${entry.detail}${entry.time ? `, ${entry.time}` : ''}`}
          {...props}
        >
          <span className="cal-event__time al-num">{entry.time ?? '—'}</span>
          <span className="cal-event__title">{entry.title}</span>
        </button>
      )}
    >
      {(close) => <EventDetail entry={entry} onClose={close} />}
    </Popover>
  );
}

function EventDetail({ entry, onClose }: { entry: CalendarEntry; onClose: () => void }) {
  const search = useAutomaticSearch();
  const chip = episodeChip(entry.status);
  return (
    <div className="cal-detail">
      <Poster src={entry.posterUrl} title={entry.title} width={64} />
      <div className="cal-detail__body">
        <div className="cal-detail__title">{entry.title}</div>
        <div className="cal-detail__code">
          <span className="al-num">{entry.code}</span>
          {entry.subtitle ? ` · ${entry.subtitle}` : ''}
        </div>
        <div className="cal-detail__when al-num">
          {formatPreferredDate(entry.day)}
          {entry.time ? ` · ${entry.time}` : ''}
        </div>
        <div>
          <StatusChip status={chip.status} label={chip.label} />
        </div>
        <div className="cal-detail__actions">
          <Link {...entry.link} className={buttonClass({ variant: 'secondary', size: 'sm' })} onClick={onClose}>
            Open
          </Link>
          {entry.status !== 'downloaded' && entry.status !== 'unaired' && entry.status !== 'tba' ? (
            <Button size="sm" loading={search.isPending} onClick={() => search.mutate(entry.search)}>
              Search
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ days, anchor, today, byDay, popover, weekStart }: { days: Date[]; anchor: Date; today: Date; byDay: Map<string, CalendarEntry[]>; popover: PopoverState; weekStart: WeekStartDay }) {
  const rows = days.length / 7;
  return (
    <Pane bare className="cal-month-pane">
      <div className="cal-month" role="grid" aria-label={anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} style={{ gridTemplateRows: `32px repeat(${rows}, minmax(112px, 1fr))` }}>
        {weekdayLabels(weekStart).map((d) => (
          <div key={d} className="cal-weekday" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((d, i) => {
          const key = localIsoDate(d);
          const entries = byDay.get(key) ?? [];
          const isToday = isSameDay(d, today);
          const row = Math.floor(i / 7);
          const col = i % 7;
          const placement = row >= rows - 2 ? 'top-start' : col >= 5 ? 'bottom-end' : 'bottom-start';
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}
              className="cal-cell"
              data-outside={d.getMonth() !== anchor.getMonth() || undefined}
              data-today={isToday || undefined}
            >
              <span className="cal-cell__date al-num">{d.getDate()}</span>
              {entries.map((e) => (
                <EventBar key={e.key} entry={e} popover={popover} placement={placement} />
              ))}
            </div>
          );
        })}
      </div>
    </Pane>
  );
}

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Week (7 columns) and day (1 column) × hour rows; date-only items sit in an all-day strip. */
function TimeGrid({ days, today, byDay, popover, timeFormat }: { days: Date[]; today: Date; byDay: Map<string, CalendarEntry[]>; popover: PopoverState; timeFormat: TimeFormat }) {
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <Pane bare className="cal-time-pane">
      <div className="cal-time" data-days={days.length} role="grid" aria-label={days.length === 1 ? 'Day' : 'Week'}>
        <div className="cal-time__head" style={cols}>
          <span />
          {days.map((d) => (
            <div key={localIsoDate(d)} className="cal-time__day" role="columnheader" data-today={isSameDay(d, today) || undefined}>
              <span className="al-label">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span className="cal-cell__date al-num">{d.getDate()}</span>
            </div>
          ))}
        </div>
        <div className="cal-time__allday" style={cols}>
          <span className="cal-time__hour al-num">all day</span>
          {days.map((d) => (
            <div key={localIsoDate(d)} className="cal-time__allday-cell">
              {(byDay.get(localIsoDate(d)) ?? [])
                .filter((e) => e.hour === null)
                .map((e) => (
                  <EventBar key={e.key} entry={e} popover={popover} />
                ))}
            </div>
          ))}
        </div>
        <div className="cal-time__body" style={{ ...cols, height: HOUR_PX * 24 }}>
          <div className="cal-time__hours">
            {HOURS.map((h) => (
              <span key={h} className="cal-time__hour al-num" style={{ top: h * HOUR_PX }}>
                {hourLabel(h, timeFormat)}
              </span>
            ))}
          </div>
          {days.map((d, col) => (
            <div key={localIsoDate(d)} className="cal-time__col" role="gridcell" aria-label={d.toLocaleDateString(undefined, { dateStyle: 'full' })}>
              {HOURS.map((h) => (
                <span key={h} className="cal-time__line" style={{ top: h * HOUR_PX }} aria-hidden="true" />
              ))}
              {(byDay.get(localIsoDate(d)) ?? [])
                .filter((e) => e.hour !== null)
                .map((e) => (
                  <div key={e.key} className="cal-time__event" style={{ top: (e.hour ?? 0) * HOUR_PX }}>
                    <EventBar entry={e} popover={popover} block placement={(e.hour ?? 0) > 18 ? 'top-start' : col >= days.length - 2 && days.length > 1 ? 'bottom-end' : 'bottom-start'} />
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </Pane>
  );
}

function Agenda({ days, byDay, popover }: { days: Date[]; byDay: Map<string, CalendarEntry[]>; popover: PopoverState }) {
  const withEntries = days.filter((d) => (byDay.get(localIsoDate(d))?.length ?? 0) > 0);
  if (withEntries.length === 0) return <EmptyState title="Nothing scheduled this month">Move to another month or show unmonitored items.</EmptyState>;
  return (
    <div className="cal-agenda">
      {withEntries.map((d) => {
        const key = localIsoDate(d);
        return (
          <section key={key} className="cal-agenda__day" aria-label={formatDate(key, { dateStyle: 'full' })}>
            <SectionLabel as="h2">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</SectionLabel>
            <Pane bare>
              {(byDay.get(key) ?? []).map((e) => {
                const chip = episodeChip(e.status);
                return (
                  <div key={e.key} className="cal-agenda__row" data-tone={e.tone} data-unmonitored={e.monitored ? undefined : true}>
                    <span className="al-num cal-agenda__time">{e.time ?? 'All day'}</span>
                    <span className="cal-agenda__title">
                      <EventBar entry={e} popover={popover} />
                    </span>
                    <span className="cal-agenda__code">
                      <span className="al-num">{e.code}</span>
                      {e.subtitle ? ` · ${e.subtitle}` : ''}
                    </span>
                    <StatusChip status={chip.status} label={chip.label} />
                  </div>
                );
              })}
            </Pane>
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
  const { isAdmin } = useAuth();
  const regenerate = useRegenerateCalendarFeed();
  const [confirming, setConfirming] = useState(false);
  const [regenerated, setRegenerated] = useState(false);
  // TODO(contract): if GET /calendar/feed is not served yet, show the documented default path.
  const path = feed.data?.path ?? '/calendar/feed.ics';
  const url = buildFeedUrl(location.origin, path, opts);

  useEffect(() => setCopied(false), [url]);
  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setRegenerated(false);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="iCal feed"
      size={560}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="mk-stack-sm">
        {feed.data === null ? <Banner tone="warn">The feed endpoint is not available yet. This is where it will live.</Banner> : null}
        <div className="cal-ical-row">
          <Field label="Past days">
            <Input type="number" mono min={0} value={opts.pastDays} onChange={(e) => setOpts({ ...opts, pastDays: Math.max(0, Number(e.target.value)) })} />
          </Field>
          <Field label="Future days">
            <Input type="number" mono min={0} value={opts.futureDays} onChange={(e) => setOpts({ ...opts, futureDays: Math.max(0, Number(e.target.value)) })} />
          </Field>
        </div>
        <Toggle label="Include unmonitored" checked={opts.unmonitored} onChange={(e) => setOpts({ ...opts, unmonitored: e.target.checked })} />
        <Field label="Feed URL" hint="Subscribe to this URL in your calendar app.">
          <Input mono readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        {regenerated ? (
          <p className="al-caption" role="status" style={{ margin: 0 }}>
            New feed URL ready. Update your calendar apps with it.
          </p>
        ) : null}
        <div className="mk-row">
          <Button variant="primary" icon={<Icon name="copy" />} onClick={() => void copyText(url).then(setCopied)}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {isAdmin && feed.data && !confirming ? (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Regenerate
            </Button>
          ) : null}
        </div>
        {confirming ? (
          <Banner
            tone="danger"
            action={
              <div className="mk-row">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger-solid"
                  loading={regenerate.isPending}
                  onClick={() =>
                    regenerate.mutate(undefined, {
                      onSuccess: () => {
                        setConfirming(false);
                        setRegenerated(true);
                      },
                    })
                  }
                >
                  Regenerate URL
                </Button>
              </div>
            }
          >
            Regenerating makes a new feed URL. The current URL stops working at once, so calendar apps subscribed to it stop updating until you give them the new one.
          </Banner>
        ) : null}
      </div>
    </Modal>
  );
}
