import { useState, type FormEvent, type ReactNode } from 'react';
import { Permission, audioRequestDomain, type AudioDiscoverItem, type AudioRequestKind } from '@arclight/shared';
import { ApiError } from '../../api/client.js';
import { AUDIO_DISABLED_CODES, type AudioDomain } from '../../api/audio-requests.js';
import { Button, EmptyState, Input, Modal, Poster, SectionHead, Skeleton } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { DLink, useDiscoverNavigate, type DiscoverTarget } from '../../features/discover/base.js';
import { usePermissions } from '../../features/requests/status.js';
import { useAudioFeature, useCreateAudioRequest } from '../../hooks/audio-requests.js';
import { RowHead, StatusLabelChip, Track, cardBadge } from './discover-kit.js';
import { t } from '../../i18n/index.js';

// Building blocks of the music and audiobook Discover pages: square cover cards with the
// status chip and a Request button, slider rows and grids, the feature-flag gate, the search
// form and the request confirm dialog (no pickers: the server applies the default root folder
// and quality profile of the domain).

/** The Discover page of a music or audiobook card. */
export function audioTarget(item: Pick<AudioDiscoverItem, 'kind' | 'foreignId' | 'region'>): DiscoverTarget {
  const search = item.region ? { region: item.region } : undefined;
  switch (item.kind) {
    case 'album':
      return { to: '/music/album/$mbid', params: { mbid: item.foreignId } };
    case 'artist':
      return { to: '/music/artist/$mbid', params: { mbid: item.foreignId } };
    case 'book':
      return { to: '/audiobooks/book/$asin', params: { asin: item.foreignId }, search };
    case 'author':
      return { to: '/audiobooks/author/$asin', params: { asin: item.foreignId }, search };
  }
}

/** Whether an error is the api's "this feature is turned off" answer. */
export function isAudioDisabled(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code !== undefined && AUDIO_DISABLED_CODES.includes(err.code);
}

export function AudioOffState({ domain }: { domain: AudioDomain }) {
  return <EmptyState title={domain === 'music' ? t('discover.audio.musicOff') : t('discover.audio.audiobooksOff')}>{t('discover.audio.offHelp')}</EmptyState>;
}

/** Renders the page only while the domain's feature flag is on. */
export function AudioFeatureGate({ domain, children }: { domain: AudioDomain; children: ReactNode }) {
  const feature = useAudioFeature(domain);
  if (!feature.ready) return <Skeleton lines={6} />;
  if (!feature.enabled) return <AudioOffState domain={domain} />;
  return <>{children}</>;
}

/** QueryError, or the "turned off" state when the api says the feature is off. */
export function AudioQueryError({ domain, error, title, onRetry }: { domain: AudioDomain; error: unknown; title: string; onRetry?: () => void }) {
  if (isAudioDisabled(error)) return <AudioOffState domain={domain} />;
  return <QueryError error={error} title={title} onRetry={onRetry} />;
}

/** The domain of a Discover page (music or audiobooks), from a card or detail kind. */
export const domainOf = (kind: AudioRequestKind): AudioDomain => audioRequestDomain(kind);

interface RequestContext {
  signedIn: boolean;
  allowed: boolean;
}

/**
 * Why an item cannot be requested now, or null when it can: sign-in, permission (REQUEST or
 * REQUEST_MUSIC / REQUEST_AUDIOBOOK), already in the library, or an open request.
 */
export function audioRequestBlocker(item: Pick<AudioDiscoverItem, 'kind' | 'mediaStatus' | 'requestStatus'>, ctx: RequestContext): string | null {
  if (!ctx.signedIn) return t('discover.title.signInToRequest');
  if (!ctx.allowed) return domainOf(item.kind) === 'music' ? t('discover.audio.noMusicPermission') : t('discover.audio.noAudiobookPermission');
  if (item.mediaStatus === 'available' || item.mediaStatus === 'partiallyAvailable' || item.mediaStatus === 'processing') return t('discover.audio.inLibrary');
  if (item.mediaStatus === 'pending' || item.requestStatus === 'pending' || item.requestStatus === 'approved') return t('discover.audio.alreadyRequested');
  return null;
}

/** The blocker for the signed-in user (admins and unavailable auth may request). */
export function useAudioRequestBlocker(item: Pick<AudioDiscoverItem, 'kind' | 'mediaStatus' | 'requestStatus'>): string | null {
  const { status } = useAuth();
  const { can } = usePermissions();
  const signedIn = status ? status.authenticated : true;
  const allowed = can(Permission.REQUEST, domainOf(item.kind) === 'music' ? Permission.REQUEST_MUSIC : Permission.REQUEST_AUDIOBOOK);
  return audioRequestBlocker(item, { signedIn, allowed });
}

/** Button label per kind: "Request" for an album or book, "Request artist" / "Request author" for all of their titles. */
export function requestLabel(kind: AudioRequestKind): string {
  if (kind === 'artist') return t('discover.audio.requestArtist');
  if (kind === 'author') return t('discover.audio.requestAuthor');
  return t('common.request');
}

function confirmText(kind: AudioRequestKind): string {
  switch (kind) {
    case 'album':
      return t('discover.audio.confirmAlbum');
    case 'artist':
      return t('discover.audio.confirmArtist');
    case 'book':
      return t('discover.audio.confirmBook');
    case 'author':
      return t('discover.audio.confirmAuthor');
  }
}

/**
 * Request button with its confirm dialog. Disabled, with the reason as its tooltip (and as a
 * caption when `showReason`), while the item cannot be requested.
 */
export function AudioRequestButton({
  item,
  size,
  variant = 'primary',
  showReason = false,
}: {
  item: AudioDiscoverItem;
  size?: 'sm' | undefined;
  variant?: 'primary' | 'secondary';
  showReason?: boolean;
}) {
  const reason = useAudioRequestBlocker(item);
  const [open, setOpen] = useState(false);
  const label = requestLabel(item.kind);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={reason !== null}
        title={reason ?? undefined}
        aria-label={reason ? `${label} (${reason})` : t('discover.audio.requestTitle', { title: item.title })}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {showReason && reason ? <span className="al-caption dk-audio-reason">{reason}</span> : null}
      {open ? <AudioRequestDialog item={item} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function AudioRequestDialog({ item, onClose }: { item: AudioDiscoverItem; onClose: () => void }) {
  const create = useCreateAudioRequest();
  const toast = useToast();
  const submit = () =>
    create.mutate(
      { kind: item.kind, foreignId: item.foreignId, ...(item.region ? { region: item.region } : {}) },
      {
        onSuccess: (req) => {
          toast.push({
            tone: 'ok',
            title: t('discover.audio.requested', { title: item.title }),
            message: req.status === 'pending' ? t('discover.audio.awaitingApproval') : undefined,
          });
          onClose();
        },
      },
    );
  return (
    <Modal
      open
      onClose={onClose}
      title={t('discover.audio.requestTitle', { title: item.title })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            {requestLabel(item.kind)}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{confirmText(item.kind)}</p>
    </Modal>
  );
}

/** Square cover card for an album, artist, book or author, with the status chip and Request. */
export function AudioCard({ item, request = true }: { item: AudioDiscoverItem; request?: boolean }) {
  const badge = cardBadge(item.mediaStatus, item.requestStatus);
  const meta = [item.subtitle, item.detail].filter(Boolean).join(' · ');
  return (
    <article className="al-poster-card dk-card dk-card--square" aria-label={item.title}>
      <DLink {...audioTarget(item)} className="mk-link dk-card__link">
        <Poster src={item.coverUrl ?? null} title={item.title} loading="lazy">
          {badge ? (
            <span className="mk-card-chip">
              <StatusLabelChip label={badge} />
            </span>
          ) : null}
        </Poster>
        <span className="al-poster-card__title-row">
          <span className="al-poster-card__title">{item.title}</span>
          {item.year ? <span className="al-num dk-year">{item.year}</span> : null}
        </span>
      </DLink>
      {meta ? <div className="al-poster-card__meta">{meta}</div> : null}
      {request ? (
        <div className="dk-card__actions">
          <AudioRequestButton item={item} size="sm" variant="secondary" />
        </div>
      ) : null}
    </article>
  );
}

const itemKey = (item: AudioDiscoverItem) => `${item.kind}-${item.foreignId}`;

/** Horizontal slider of square cards. */
export function AudioRow({ title, items, seeAll }: { title: string; items: readonly AudioDiscoverItem[]; seeAll?: DiscoverTarget | null }) {
  return (
    <section className="mk-slider" aria-label={title}>
      <RowHead title={title} seeAll={seeAll} />
      {items.length === 0 ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {t('discover.kit.nothingHereYet')}
        </p>
      ) : (
        <Track label={title}>
          {items.map((item) => (
            <AudioCard key={itemKey(item)} item={item} />
          ))}
        </Track>
      )}
    </section>
  );
}

/** Grid of square cards under a title with a count. */
export function AudioGrid({ title, items, empty }: { title: string; items: readonly AudioDiscoverItem[]; empty?: string }) {
  return (
    <section className="mk-slider" aria-label={title}>
      <SectionHead
        label={
          <h2 className="al-title-m mk-section-title">
            {title} <span className="al-num al-caption">{items.length}</span>
          </h2>
        }
      />
      {items.length === 0 ? (
        <p className="al-caption" style={{ margin: 0 }}>
          {empty ?? t('discover.kit.nothingHereYet')}
        </p>
      ) : (
        <div className="mk-poster-grid dk-grid">
          {items.map((item) => (
            <AudioCard key={itemKey(item)} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Square skeletons for a loading grid. */
export function AudioSkeletons({ count = 12 }: { count?: number }) {
  return (
    <div className="mk-poster-grid" aria-busy="true" aria-label={t('common.loading')} role="status">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="poster" style={{ aspectRatio: '1 / 1' }} />
      ))}
    </div>
  );
}

/** Search box of a music or audiobook home page; the term lives in the URL (?q=). */
export function AudioSearchForm({ domain, initial }: { domain: AudioDomain; initial: string }) {
  const go = useDiscoverNavigate();
  const [term, setTerm] = useState(initial);
  const to = domain === 'music' ? '/music' : '/audiobooks';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = term.trim();
    go({ to, search: q ? { q } : {} });
  };
  return (
    <form className="dk-search dk-audio-search" role="search" onSubmit={submit}>
      <Input
        type="search"
        value={term}
        onChange={(e) => setTerm(e.currentTarget.value)}
        placeholder={domain === 'music' ? t('discover.audio.searchMusic') : t('discover.audio.searchAudiobooks')}
        aria-label={domain === 'music' ? t('discover.audio.searchMusic') : t('discover.audio.searchAudiobooks')}
      />
      <Button type="submit">{t('common.search')}</Button>
    </form>
  );
}

/** `?q=` of the music and audiobook home pages. */
export const parseAudioHomeSearch = (search: Record<string, unknown>): { q?: string } => {
  const q = search['q'];
  return typeof q === 'string' && q.trim() ? { q: q.trim() } : typeof q === 'number' ? { q: String(q) } : {};
};

/**
 * Details-layout hero for an album, artist, book or author: square cover, crumb, title, chips,
 * facts, overview and the request actions. No backdrop (the catalogues have none).
 */
export function AudioHero({
  item,
  crumb,
  meta,
  chips,
  facts,
  overview,
  actions,
  label,
}: {
  item: AudioDiscoverItem;
  crumb: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
  facts?: ReactNode;
  overview?: string | null | undefined;
  actions?: ReactNode;
  label: string;
}) {
  const badge = cardBadge(item.mediaStatus, item.requestStatus);
  return (
    <section className="mk-hero__grid dk-audio-hero" aria-label={label}>
      <Poster src={item.coverUrl ?? null} title={item.title} className="mk-hero__poster dk-audio-hero__cover" loading="eager" />
      <div className="mk-hero__body">
        <div className="mk-crumb">{crumb}</div>
        <h1 className="mk-hero__title">
          <span className="al-title-xl">{item.title}</span>
          {item.year ? <span className="mk-hero__year">{item.year}</span> : null}
        </h1>
        {meta ? <div className="mk-hero__meta">{meta}</div> : null}
        <div className="mk-hero__chips">
          {badge ? <StatusLabelChip label={badge} large /> : null}
          {chips}
        </div>
        {facts}
        {overview ? <p className="mk-hero__overview">{overview}</p> : null}
        <div className="mk-hero__actions dk-audio-hero__actions">{actions ?? <AudioRequestButton item={item} showReason />}</div>
      </div>
    </section>
  );
}
