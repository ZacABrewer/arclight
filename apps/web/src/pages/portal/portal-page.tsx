import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { DiscoverItem, PublicPortal } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { discoverApi, kindOf, publicPortalApi } from '../../api/requests.js';
import { Backdrop, Button, EmptyState, ErrorBlock, Input, Mark, Pane, Poster, Skeleton, buttonClass } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { cardBadge, StatusLabelChip } from '../discover/discover-kit.js';
import { t } from '../../i18n/index.js';
import { titleLink } from '../../features/requests/title-link.js';
import '../../components/media/media-kit.css';
import './portal.css';

// Public request portal (/portal): reachable without signing in and drawn without the app
// shell. Shows the portal's branding and message, the ways to sign in, and (when the admin
// allows anonymous discover) trending titles and a search. Requesting always needs sign-in.

export const portalKeys = {
  portal: ['public', 'portal'] as const,
  trending: ['public', 'trending'] as const,
  search: (q: string) => ['public', 'search', q] as const,
};

/** The app path of a title page. */
export function titlePath(item: Pick<DiscoverItem, 'mediaType' | 'tmdbId'>): string {
  return `/discover/${kindOf(item.mediaType)}/${item.tmdbId}`;
}

export interface PortalLoginOption {
  id: 'local' | 'jellyfin' | 'emby' | 'plex';
  label: string;
}

/** Sign-in buttons for the portal's login methods (each goes to /login, which offers them). */
export function portalLoginOptions(methods: PublicPortal['loginMethods']): PortalLoginOption[] {
  const out: PortalLoginOption[] = [];
  if (methods.local) out.push({ id: 'local', label: t('portal.signInLocal') });
  const server = methods.mediaServer;
  if (server && (server.kind === 'jellyfin' || server.kind === 'emby')) {
    const name = server.name || (server.kind === 'jellyfin' ? t('common.jellyfin') : t('common.emby'));
    out.push({ id: server.kind, label: t('portal.signInWith', { name }) });
  }
  if (methods.plex || server?.kind === 'plex') out.push({ id: 'plex', label: t('portal.signInWith', { name: t('common.plex') }) });
  return out;
}

/** Why the portal cannot be shown: off (401/403/404 from the api) or another failure. */
export function portalUnavailable(err: unknown): 'off' | 'error' {
  return err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404) ? 'off' : 'error';
}

function discoverError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return t('portal.rateLimited');
  return errorMessage(err);
}

function PortalCard({ item, signedIn }: { item: DiscoverItem; signedIn: boolean }) {
  const badge = cardBadge(item.mediaStatus, item.requestStatus);
  const path = titlePath(item);
  const body = (
    <>
      <Poster src={item.posterUrl} title={item.title}>
        {badge ? (
          <span className="mk-card-chip">
            <StatusLabelChip label={badge} />
          </span>
        ) : null}
      </Poster>
      <span className="al-poster-card__title-row">
        <span className="al-poster-card__title">{item.title}</span>
        {item.year ? <span className="al-num portal-year">{item.year}</span> : null}
      </span>
    </>
  );
  return (
    <article className="al-poster-card" aria-label={item.title}>
      {signedIn ? (
        <Link {...titleLink(item.mediaType, item.tmdbId)} className="portal-card-link">
          {body}
        </Link>
      ) : (
        <Link to="/login" search={{ redirect: path }} className="portal-card-link" aria-label={t('portal.signInToRequest', { title: item.title })}>
          {body}
        </Link>
      )}
      <div className="al-poster-card__meta">{item.mediaType === 'movie' ? t('common.movie') : t('common.series')}</div>
    </article>
  );
}

function PortalDiscover({ signedIn }: { signedIn: boolean }) {
  const searchId = useId();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const trending = useQuery({ queryKey: portalKeys.trending, queryFn: () => discoverApi.trending({ mediaType: 'all', timeWindow: 'week' }), enabled: query === '', retry: false, staleTime: 300_000 });
  const search = useQuery({ queryKey: portalKeys.search(query), queryFn: () => discoverApi.search(query), enabled: query !== '', retry: false, staleTime: 60_000 });
  const active = query ? search : trending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(draft.trim());
  };
  return (
    <Pane title={query ? t('portal.resultsFor', { query }) : t('portal.trending')} aria-label={t('portal.browse')}>
      <form className="portal-search" role="search" onSubmit={submit}>
        <label className="al-sr-only" htmlFor={searchId}>
          {t('portal.searchLabel')}
        </label>
        <Input id={searchId} type="search" value={draft} placeholder={t('portal.searchPlaceholder')} onChange={(e) => setDraft(e.currentTarget.value)} />
        <Button type="submit" variant="secondary">
          {t('common.search')}
        </Button>
        {query ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft('');
              setQuery('');
            }}
          >
            {t('portal.clear')}
          </Button>
        ) : null}
      </form>
      {active.isPending ? (
        <Skeleton lines={3} />
      ) : active.isError ? (
        <ErrorBlock title={t('portal.couldNotLoadTitles')}>{discoverError(active.error)}</ErrorBlock>
      ) : active.data.results.length === 0 ? (
        <EmptyState title={t('portal.noTitles')}>{t('portal.noTitlesHelp')}</EmptyState>
      ) : (
        <div className="portal-grid">
          {active.data.results.map((item) => (
            <PortalCard key={`${item.mediaType}-${item.tmdbId}`} item={item} signedIn={signedIn} />
          ))}
        </div>
      )}
      {!signedIn ? <p className="al-caption portal-note">{t('portal.requestNeedsSignIn')}</p> : null}
    </Pane>
  );
}

function PortalOff({ reason, error }: { reason: 'off' | 'error'; error: unknown }) {
  return (
    <Pane chamfer="both" strong className="portal-card" aria-label={t('portal.title')}>
      {reason === 'off' ? (
        <EmptyState
          title={t('portal.offTitle')}
          action={
            <Link to="/login" className={buttonClass({ variant: 'primary' })}>
              {t('portal.signIn')}
            </Link>
          }
        >
          {t('portal.offHelp')}
        </EmptyState>
      ) : (
        <ErrorBlock title={t('portal.couldNotLoad')}>{errorMessage(error)}</ErrorBlock>
      )}
    </Pane>
  );
}

export function PortalPage() {
  const { status } = useAuth();
  const signedIn = status?.authenticated ?? false;
  const portal = useQuery({ queryKey: portalKeys.portal, queryFn: publicPortalApi.get, retry: false, staleTime: 60_000 });
  const title = portal.data?.title || t('common.arclight');

  useEffect(() => {
    document.title = t('portal.documentTitle', { title });
  }, [title]);

  const off = portal.isError || (portal.data && !portal.data.enabled);
  return (
    <div className="al-app portal">
      <Backdrop vx={0.5} horizon={0.62} />
      <main className="portal-main">
        <header className="portal-head">
          <div className="portal-brand">
            <Mark size={36} />
            <h1 className="al-title-l portal-title">{title}</h1>
          </div>
          {signedIn ? (
            <Link to="/discover" className={buttonClass({ variant: 'secondary' })}>
              {t('portal.openApp')}
            </Link>
          ) : (
            <Link to="/login" className={buttonClass({ variant: 'primary' })}>
              {t('portal.signIn')}
            </Link>
          )}
        </header>
        {portal.isPending ? (
          <Skeleton lines={6} />
        ) : off ? (
          <PortalOff reason={portal.isError ? portalUnavailable(portal.error) : 'off'} error={portal.error} />
        ) : (
          <PortalBody portal={portal.data} signedIn={signedIn} />
        )}
      </main>
    </div>
  );
}

function PortalBody({ portal, signedIn }: { portal: PublicPortal; signedIn: boolean }) {
  const logins = portalLoginOptions(portal.loginMethods);
  return (
    <div className="portal-stack">
      <div className="portal-top">
        <Pane chamfer="tl" strong className="portal-card" aria-label={t('portal.welcome')}>
          <p className="al-label portal-kicker">{t('portal.kicker')}</p>
          {portal.message ? <p className="portal-message">{portal.message}</p> : <p className="portal-message">{t('portal.defaultMessage')}</p>}
          {portal.applicationUrl ? <p className="al-caption al-num portal-url">{portal.applicationUrl}</p> : null}
        </Pane>
        <Pane title={signedIn ? t('portal.signedIn') : t('portal.signInTitle')} aria-label={t('portal.signInTitle')}>
          {signedIn ? (
            <p className="al-caption" style={{ margin: 0 }}>
              {t('portal.signedInHelp')}
            </p>
          ) : (
            <ul className="portal-logins" aria-label={t('portal.loginMethods')}>
              {logins.map((o, i) => (
                <li key={o.id}>
                  <Link to="/login" className={buttonClass({ variant: i === 0 ? 'primary' : 'secondary', block: true })}>
                    {o.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Pane>
      </div>
      {portal.allowAnonymousDiscover || signedIn ? (
        <PortalDiscover signedIn={signedIn} />
      ) : (
        <p className="al-caption portal-note">{t('portal.discoverNeedsSignIn')}</p>
      )}
    </div>
  );
}
