import { Link, useParams, useRouterState } from '@tanstack/react-router';
import type { CollectionRequestResult } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { BackdropFrame, Button, Poster, SectionHead, Skeleton, buttonClass } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { DLink } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { useCollection, useRequestCollection } from '../../hooks/requests.js';
import { DiscoverCard } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Movie collection: every part with its status, and "Request all missing" which requests each
// part the library lacks and nobody has asked for yet (one request per movie, same rules).

/** Toast text for a collection request. */
export function collectionResultMessage(result: CollectionRequestResult): { tone: 'ok' | 'warning' | 'info'; title: string; message?: string } {
  const n = result.requested.length;
  if (result.failed.length > 0) {
    return {
      tone: 'warning',
      title: t('discover.collection.requestedSomeFailed', { count: n, failed: result.failed.length }),
      message: result.failed.map((f) => `${f.title}: ${f.error}`).join('\n'),
    };
  }
  if (n === 0) return { tone: 'info', title: t('discover.collection.nothingToRequest') };
  return { tone: 'ok', title: t('discover.collection.requestedCount', { count: n }) };
}

export function CollectionPage() {
  const params = useParams({ strict: false }) as { id?: string };
  const id = Number(params.id);
  const collection = useCollection(id);
  const request = useRequestCollection();
  const toast = useToast();
  const { status } = useAuth();
  const signedIn = status ? status.authenticated : true;
  const href = useRouterState({ select: (s) => s.location.href });

  if (collection.isPending) return <Skeleton lines={8} />;
  if (collection.isError) return <QueryError error={collection.error} title={t('discover.collection.couldNotLoad')} onRetry={() => void collection.refetch()} />;
  const c = collection.data;
  const send = (is4k: boolean) =>
    request.mutate(
      { id, is4k },
      {
        onSuccess: (result) => toast.push(collectionResultMessage(result)),
        onError: (err) => toast.push({ tone: 'error', title: t('discover.collection.requestFailed'), message: errorMessage(err) }),
      },
    );

  return (
    <>
      <section className="mk-hero" aria-label={c.name}>
        <BackdropFrame src={tmdbImage(c.backdropUrl, 'backdrop')} title="" fade bleed loading="eager" />
        <div className="mk-hero__grid">
          <Poster src={tmdbImage(c.posterUrl, 'posterLarge')} title={c.name} className="mk-hero__poster" loading="eager" />
          <div className="mk-hero__body">
            <div className="mk-crumb">
              <DLink to="">{t('common.discover')}</DLink> / {t('common.collections')}
            </div>
            <h1 className="mk-hero__title">
              <span className="al-title-xl">{c.name}</span>
            </h1>
            <div className="mk-hero__meta">
              <span className="al-num">{c.parts.length}</span> {t('discover.collection.movies', { count: c.parts.length })} ·{' '}
              <span className="al-num">{c.missing}</span> {t('discover.collection.notRequested', { count: c.missing })}
            </div>
            {c.overview ? <p className="mk-hero__overview">{c.overview}</p> : null}
            <div className="mk-hero__actions">
              {!signedIn ? (
                <Link to="/login" search={{ redirect: href }} className={buttonClass({ variant: 'primary' })}>
                  {t('discover.title.signInToRequest')}
                </Link>
              ) : null}
              {c.canRequest ? (
                <Button variant="primary" disabled={c.missing === 0} loading={request.isPending && request.variables?.is4k === false} onClick={() => send(false)}>
                  {t('discover.collection.requestAllMissing', { count: c.missing })}
                </Button>
              ) : null}
              {c.canRequest4k ? (
                <Button loading={request.isPending && request.variables?.is4k === true} onClick={() => send(true)}>
                  {t('discover.collection.requestAllIn4k')}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      <section className="mk-slider" aria-label={t('discover.collection.parts')}>
        <SectionHead label={<h2 className="al-title-m mk-section-title">{t('discover.collection.parts')}</h2>} />
        <div className="mk-poster-grid dk-grid">
          {c.parts.map((part) => (
            <DiscoverCard key={part.tmdbId} item={part} subtitle={part.releaseDate ?? t('discover.collection.noDate')} />
          ))}
        </div>
      </section>
    </>
  );
}
