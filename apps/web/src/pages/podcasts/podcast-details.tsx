import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { Podcast, PodcastSubscriptionSettings, UpdatePodcastRequest } from '@arclight/shared';
import { Button, Chip, FormRow, Input, KeyValue, Modal, Paginator, Toggle } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { TagPicker } from '../../components/forms/tag-picker.js';
import { formatBytes, formatDate } from '../../components/media/format.js';
import { Loading, QueryError, TagChips } from '../../components/media/media-kit.js';
import { useTags } from '../../hooks/library.js';
import { usePodcast, usePodcastEpisodes, useRefreshPodcast, useUpdatePodcast } from '../../hooks/podcasts.js';
import { DetailsHero } from '../library/details-kit.js';
import { DeletePodcastDialog, EpisodeBulkBar, EpisodeList, PodcastArt, PodcastGate, PodcastStatusChip, SubscriptionSettingsFields, plainText } from './podcast-kit.js';
import { t } from '../../i18n/index.js';
import { externalHref } from '../../lib/safe-url.js';

// Podcasts → one podcast (/podcasts/$id), after the design's show page: the header (cover, kicker,
// title, author and episode count, Following = monitored, the auto-download chip that opens Edit,
// description, funding, the masked feed URL, status and last error), Edit / Refresh / Delete, and
// its episodes as rows.

/** "Auto-download newest 3" / "Auto-download new episodes" / "Auto-download off". */
export function autoDownloadLabel(settings: Pick<PodcastSubscriptionSettings, 'autoDownload' | 'backlog'>): string {
  if (!settings.autoDownload) return t('podcasts.autoDownloadOff');
  return settings.backlog > 0 ? t('podcasts.autoDownloadNewest', { count: settings.backlog }) : t('podcasts.autoDownloadNew');
}

export const EPISODE_PAGE_SIZE = 50;

// Re-exported: the tests (and older imports) take it from here.
export { plainText };

export function PodcastDetailsPage() {
  return (
    <PodcastGate>
      <PodcastDetails />
    </PodcastGate>
  );
}

function PodcastDetails() {
  const { id: rawId } = useParams({ strict: false }) as { id?: string };
  const id = Number(rawId);
  const podcast = usePodcast(id);
  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('podcasts.invalidId', { rawId: rawId ?? '' }))} title={t('podcasts.notFound')} />;
  if (podcast.isPending) return <Loading />;
  if (podcast.isError) return <QueryError error={podcast.error} onRetry={() => void podcast.refetch()} title={t('podcasts.couldNotLoadPodcast')} />;
  return <PodcastView podcast={podcast.data} />;
}

function PodcastView({ podcast: p }: { podcast: Podcast }) {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const tags = useTags();
  const refresh = useRefreshPodcast();
  const update = useUpdatePodcast();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const s = p.statistics;

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('podcasts.overview')}
        art={<PodcastArt podcast={p} className="mk-hero__poster" loading="eager" />}
        title={p.title}
        crumb={
          <>
            <Link to="/podcasts">{t('common.podcasts')}</Link> / {p.title}
          </>
        }
        eyebrow={[t('podcasts.kicker'), p.categories[0] ?? null].filter(Boolean).join(' · ')}
        meta={[p.author, t('podcasts.episodeCount', { count: s.episodeCount })].filter(Boolean).join(' · ')}
        chips={
          <>
            {isAdmin ? (
              <>
                <Button
                  variant={p.monitored ? 'primary' : 'secondary'}
                  aria-pressed={p.monitored}
                  loading={update.isPending}
                  onClick={() => update.mutate({ id: p.id, monitored: !p.monitored })}
                  title={p.monitored ? t('podcasts.followingHint') : t('podcasts.followHint')}
                >
                  {p.monitored ? t('podcasts.following') : t('podcasts.follow')}
                </Button>
                <Button onClick={() => setEditing(true)} data-testid="auto-download">
                  {autoDownloadLabel(p.settings)}
                </Button>
              </>
            ) : (
              <>
                <Chip tone={p.monitored ? 'default' : 'muted'} large>
                  {p.monitored ? t('podcasts.following') : t('podcasts.notFollowing')}
                </Chip>
                <Chip tone="muted" dot="none" large data-testid="auto-download">
                  {autoDownloadLabel(p.settings)}
                </Chip>
              </>
            )}
            <PodcastStatusChip podcast={p} large />
            {p.privateFeed ? (
              <Chip tone="warn" large data-testid="private-feed">
                {t('podcasts.privateFeed')}
              </Chip>
            ) : null}
            {p.explicit ? (
              <Chip tone="muted" dot="none" large>
                {t('podcasts.explicit')}
              </Chip>
            ) : null}
            <TagChips ids={p.tags} tags={tags.data} />
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('podcasts.categories'), value: p.categories.join(', ') || '—' },
              { label: t('common.path'), value: p.path || '—' },
              { label: t('common.sizeOnDisk'), value: formatBytes(s.sizeOnDisk) },
              { label: t('podcasts.downloaded'), value: `${s.downloadedCount} / ${s.episodeCount}` },
              { label: t('podcasts.played'), value: String(s.playedCount) },
              { label: t('podcasts.lastRefreshed'), value: formatDate(p.lastRefreshed, { dateStyle: 'medium', timeStyle: 'short' }) },
              { label: t('podcasts.nextRefresh'), value: formatDate(p.nextRefreshAt, { dateStyle: 'medium', timeStyle: 'short' }) },
              { label: t('podcasts.feed'), value: <span className="pod-feed-url" data-testid="feed-url">{p.feedUrl}</span> },
            ]}
          />
        }
        actions={
          isAdmin ? (
            <>
              <Button loading={refresh.isPending} onClick={() => refresh.mutate(p.id)}>
                {t('common.refresh')}
              </Button>
              <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                {t('common.delete')}
              </Button>
            </>
          ) : null
        }
      >
        {p.lastError ? (
          <p className="pod-error" role="alert">
            {t('podcasts.lastError', { error: p.lastError })}
          </p>
        ) : null}
        {p.description ? <p className="mk-hero__overview pod-description">{plainText(p.description)}</p> : null}
        {p.link || p.funding.length ? (
          <ul className="music-links" aria-label={t('music.links')}>
            {p.link ? (
              <li>
                <a href={externalHref(p.link)} target="_blank" rel="noopener noreferrer">
                  {t('podcasts.website')}
                </a>
              </li>
            ) : null}
            {p.funding.map((f) => (
              <li key={f.url}>
                <a href={externalHref(f.url)} target="_blank" rel="noopener noreferrer">
                  {f.title || t('podcasts.support')}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </DetailsHero>

      <PodcastEpisodes podcastId={p.id} readOnly={!isAdmin} />

      {editing ? <EditPodcastModal podcast={p} onClose={() => setEditing(false)} /> : null}
      <DeletePodcastDialog podcast={p} open={deleting} onClose={() => setDeleting(false)} onDeleted={() => void navigate({ to: '/podcasts' })} />
    </div>
  );
}

function PodcastEpisodes({ podcastId, readOnly }: { podcastId: number; readOnly: boolean }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const episodes = usePodcastEpisodes({ podcastId, page, pageSize: EPISODE_PAGE_SIZE });
  const records = episodes.data?.records;
  const pageCount = Math.max(1, Math.ceil((episodes.data?.totalRecords ?? 0) / EPISODE_PAGE_SIZE));
  return (
    <section aria-label={t('podcasts.episodes')} className="mk-stack-sm">
      <h2 className="mk-section-title">{t('podcasts.episodes')}</h2>
      {episodes.isError ? (
        <QueryError error={episodes.error} onRetry={() => void episodes.refetch()} title={t('podcasts.couldNotLoadEpisodes')} />
      ) : (
        <EpisodeList rows={records} loading={episodes.isPending} selected={selected} onSelectionChange={setSelected} readOnly={readOnly} empty={t('podcasts.noEpisodes')} />
      )}
      {pageCount > 1 ? (
        <Paginator
          page={page}
          pageCount={pageCount}
          onPageChange={(n) => {
            setPage(n);
            setSelected(new Set());
          }}
        />
      ) : null}
      <EpisodeBulkBar ids={[...selected]} total={records?.length ?? 0} onSelectAll={() => setSelected(new Set((records ?? []).map((e) => e.id)))} onClear={() => setSelected(new Set())} />
    </section>
  );
}

/** Edit: every per-podcast setting plus monitored, tags and the feed URL. */
export function EditPodcastModal({ podcast, onClose }: { podcast: Podcast; onClose: () => void }) {
  const update = useUpdatePodcast();
  const [monitored, setMonitored] = useState(podcast.monitored);
  const [feedUrl, setFeedUrl] = useState(podcast.feedUrl);
  const [tags, setTags] = useState<number[]>([...podcast.tags]);
  const [settings, setSettings] = useState<PodcastSubscriptionSettings>(podcast.settings);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.seriesDetails.editTitle', { title: podcast.title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-podcast-form" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-podcast-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const body: UpdatePodcastRequest = { monitored, tags, settings };
          // The masked URL comes back as shown; only a changed one is sent.
          if (feedUrl.trim() && feedUrl.trim() !== podcast.feedUrl) body.feedUrl = feedUrl.trim();
          update.mutate({ id: podcast.id, ...body }, { onSuccess: onClose });
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="edit-podcast-monitored" captionInline caption={t('podcasts.monitoredCaption')}>
          <Toggle id="edit-podcast-monitored" checked={monitored} onChange={(e) => setMonitored(e.currentTarget.checked)} />
        </FormRow>
        <FormRow label={t('podcasts.feedUrl')} htmlFor="edit-podcast-feed" caption={podcast.privateFeed ? t('podcasts.feedUrlPrivateCaption') : t('podcasts.feedUrlCaption')}>
          <Input id="edit-podcast-feed" mono spellCheck={false} autoComplete="off" value={feedUrl} onChange={(e) => setFeedUrl(e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('common.tags')} htmlFor="edit-podcast-tags">
          <TagPicker id="edit-podcast-tags" value={tags} onChange={setTags} />
        </FormRow>
        <SubscriptionSettingsFields value={settings} onChange={setSettings} />
      </form>
    </Modal>
  );
}
