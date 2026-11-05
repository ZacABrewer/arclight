import { useState } from 'react';
import { Link, Navigate } from '@tanstack/react-router';
import type { MediaRequest } from '@arclight/shared';
import { useLocale, useT } from '@web/i18n/index';
import { artBackground } from '@web/features/player/redesign/placeholder';
import { useAccounts } from '../../app/context';
import type { Translate } from '../format';
import { TvPanel } from '../profile-parts';
import { HOME_PATH } from '../tv-runtime';
import { DISCOVER_PATH, requestErrorText, requestStateKey, requestTone, useCancelRequest, useCanRequest, useMyRequests, useOpenDiscover } from '../requests';

// My requests (the portal's "My requests" at stage size): the account's requests, newest first,
// one row each: poster, title, kind and year, the seasons asked for, when, and the status. OK on a
// row opens its Discover title page; Cancel (a pending request of your own, as the server allows)
// asks first, then withdraws it.

/** "Series · 2026 · Seasons 1, 2" under a request's title. */
export function requestSub(r: Pick<MediaRequest, 'type' | 'mediaYear' | 'seasons'>, t: Translate): string {
  const seasons = r.type === 'series' && r.seasons.length ? t('app.tv.requests.seasons', { list: r.seasons.map((s) => s.seasonNumber).join(', ') }) : null;
  return [t(r.type === 'movie' ? 'app.tv.movie' : 'app.tv.series'), r.mediaYear ? String(r.mediaYear) : null, seasons].filter(Boolean).join(' · ');
}

/** Whether the row gets a Cancel button: the server's own say (`canRemove`), for pending requests only. */
export const cancellable = (r: Pick<MediaRequest, 'status' | 'canRemove'>) => r.canRemove && r.status === 'pending';

function day(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function RequestRow({ r, onCancel, t }: { r: MediaRequest; onCancel: (r: MediaRequest) => void; t: Translate }) {
  const { locale } = useLocale();
  const open = useOpenDiscover();
  const tone = requestTone(r);
  return (
    <div className="tv-rq" data-tv-row="">
      <button type="button" className="tv-rq__main" data-tv-key={`rq-${r.id}`} onClick={() => open({ mediaType: r.type, tmdbId: r.mediaTmdbId })}>
        <span className="tv-rq__art" style={{ background: artBackground(r.mediaPoster ?? r.mediaBackdrop ?? null, r.mediaTitle) }} aria-hidden="true" />
        <span className="tv-rq__text">
          <span className="tv-rq__title">{r.mediaTitle}</span>
          <span className="tv-rq__sub">{requestSub(r, t)}</span>
          <span className="tv-rq__when">{t('app.tv.requests.requestedOn', { date: day(r.createdAt, locale) })}</span>
          {r.status === 'declined' && r.declineReason ? <span className="tv-rq__why">{r.declineReason}</span> : null}
        </span>
        <span className={`tv-rq__status tv-rq__status--${tone}`}>{t(requestStateKey(r))}</span>
      </button>
      {cancellable(r) ? (
        <button type="button" className="tv-btn tv-btn--secondary tv-btn--tight" data-tv-key={`rq-cancel-${r.id}`} onClick={() => onCancel(r)}>
          {t('app.tv.requests.cancel')}
        </button>
      ) : null}
    </div>
  );
}

export function TvRequestsScreen() {
  const t = useT();
  const allowed = useCanRequest();
  const { active } = useAccounts();
  const list = useMyRequests(active?.userId);
  const cancel = useCancelRequest();
  const [asking, setAsking] = useState<MediaRequest | null>(null);
  if (!allowed) return <Navigate to={HOME_PATH} replace />;
  const items = list.data?.results ?? [];
  const total = list.data?.pageInfo.total ?? null;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-browse">
        <div className="tv-headline">
          <h1 className="tv-h1">{t('app.tv.requests.title')}</h1>
          {total != null ? <span className="tv-count">{t('app.tv.requests.count', { count: total })}</span> : null}
        </div>
        {list.isError ? (
          <div className="tv-state tv-rq__state" data-tv-row="" role="alert">
            <div className="tv-state__title">{t('app.tv.requests.failed')}</div>
            {list.error instanceof Error && list.error.message ? <div className="tv-state__text">{list.error.message}</div> : null}
            <div className="tv-btns">
              <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="rq-retry" data-tv-autofocus="" data-tv-r="8" onClick={() => void list.refetch()}>
                {t('app.tv.tryAgain')}
              </button>
            </div>
          </div>
        ) : null}
        {list.isSuccess && !items.length ? (
          <div className="tv-listempty" data-tv-row="">
            <span className="tv-listempty__plus" aria-hidden="true">
              +
            </span>
            <div className="tv-listempty__body">
              <div className="tv-noresults">
                <div className="tv-noresults__title">{t('app.tv.requests.emptyTitle')}</div>
                <div className="tv-noresults__text">{t('app.tv.requests.empty')}</div>
              </div>
              <div className="tv-btns">
                <Link to={DISCOVER_PATH} className="tv-btn tv-btn--primary" data-tv-key="rq-discover" data-tv-autofocus="" data-tv-r="8">
                  {t('app.tv.requests.browse')}
                </Link>
              </div>
            </div>
          </div>
        ) : null}
        {cancel.isError ? (
          <p className="tv-dsc__error" role="alert">
            {requestErrorText(cancel.error, t)}
          </p>
        ) : null}
        <div className="tv-rq__list">
          {items.map((r) => (
            <RequestRow key={r.id} r={r} onCancel={setAsking} t={t} />
          ))}
        </div>
      </div>
      {asking ? (
        <TvPanel label={t('app.tv.requests.cancel')} onClose={() => setAsking(null)}>
          <div className="tv-confirm">
            <h2 className="tv-profiles__title">{t('app.tv.requests.cancelConfirm', { title: asking.mediaTitle })}</h2>
            <div className="tv-btns" data-tv-row="">
              <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="rq-keep" data-tv-autofocus="" onClick={() => setAsking(null)}>
                {t('app.tv.requests.keep')}
              </button>
              <button
                type="button"
                className="tv-btn tv-btn--primary"
                data-tv-key="rq-confirm"
                onClick={() => {
                  if (cancel.isPending) return;
                  const id = asking.id;
                  setAsking(null);
                  cancel.mutate(id);
                }}
              >
                {t('app.tv.requests.cancel')}
              </button>
            </div>
          </div>
        </TvPanel>
      ) : null}
    </div>
  );
}
