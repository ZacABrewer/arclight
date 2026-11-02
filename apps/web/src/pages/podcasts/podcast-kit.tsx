import { useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type {
  Podcast,
  PodcastEnclosurePreference,
  PodcastEpisode,
  PodcastEpisodeBulkAction,
  PodcastEpisodeRow,
  PodcastEpisodeStatus,
  PodcastSubscriptionSettings,
} from '@arclight/shared';
import { Button, Checkbox, Chip, FormRow, Input, Modal, Select, Skeleton, StatusChip, Table, Toggle, type Column } from '../../arclight/index.js';
import { BulkBar, type BulkAction } from '../../components/media/bulk-bar.js';
import { formatBytes, formatDate } from '../../components/media/format.js';
import { Loading } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { useFeatures } from '../../hooks/music.js';
import { useBulkEpisodes, useDeleteEpisodeFile, useDeletePodcast, useDownloadEpisode, useSetEpisodePlayed } from '../../hooks/podcasts.js';
import { SquareArt } from '../library/music/music-kit.js';
import { NotFoundPage } from '../not-found.js';
import { formatDuration, t } from '../../i18n/index.js';
import './podcasts.css';

// Pieces shared by the podcast pages: the feature gate, cover art, status chips, the episode
// table with its row and bulk actions, the per-podcast settings fields and the delete dialog.

/** Podcast pages exist only while the flag is on: a 404 otherwise (and a skeleton while it loads). */
export function PodcastGate({ children }: { children: ReactNode }) {
  const features = useFeatures();
  if (!features.ready) return <Loading />;
  if (!features.podcasts) return <NotFoundPage />;
  return <>{children}</>;
}

/** The "podcast" kind chip (calendar rows). */
export function PodcastChip({ large }: { large?: boolean }) {
  return (
    <Chip tone="neutral" dot="none" large={large} data-kind="podcast">
      {t('common.podcasts')}
    </Chip>
  );
}

export const podcastLink = (p: { id: number }) => ({ to: '/podcasts/$id' as const, params: { id: String(p.id) } });

export function PodcastArt({ podcast, width, className, loading }: { podcast: Pick<Podcast, 'title' | 'imageUrl'>; width?: number; className?: string; loading?: 'lazy' | 'eager' }) {
  return <SquareArt src={podcast.imageUrl} title={podcast.title} width={width} className={className} loading={loading} />;
}

/** "Feed error" / "Feed gone" badge; nothing while the feed is healthy. */
export function PodcastStatusChip({ podcast, large }: { podcast: Pick<Podcast, 'status' | 'lastError'>; large?: boolean }) {
  if (podcast.status === 'active') return null;
  return (
    <Chip tone={podcast.status === 'gone' ? 'muted' : 'danger'} large={large} title={podcast.lastError ?? undefined} data-testid="podcast-status">
      {podcast.status === 'gone' ? t('podcasts.feedGone') : t('podcasts.feedError')}
    </Chip>
  );
}

export function episodeStatusLabel(status: PodcastEpisodeStatus): string {
  switch (status) {
    case 'available':
      return t('podcasts.status.available');
    case 'wanted':
      return t('podcasts.status.wanted');
    case 'downloading':
      return t('podcasts.status.downloading');
    case 'downloaded':
      return t('podcasts.status.downloaded');
    case 'failed':
      return t('podcasts.status.failed');
    case 'deleted':
      return t('podcasts.status.deleted');
  }
}

export const EPISODE_STATUSES: readonly PodcastEpisodeStatus[] = ['available', 'wanted', 'downloading', 'downloaded', 'failed', 'deleted'];

export function EpisodeStatusChip({ episode }: { episode: Pick<PodcastEpisode, 'status' | 'error'> }) {
  const label = episodeStatusLabel(episode.status);
  switch (episode.status) {
    case 'downloaded':
      return <StatusChip status="downloaded" label={label} />;
    case 'downloading':
      return <StatusChip status="downloading" label={label} />;
    case 'wanted':
      return <StatusChip status="queued" label={label} />;
    case 'failed':
      return <StatusChip status="failed" cause={episode.error ?? t('podcasts.downloadFailed')} />;
    case 'deleted':
      return (
        <Chip tone="muted" dot="ring">
          {label}
        </Chip>
      );
    case 'available':
      return (
        <Chip tone="neutral" dot="ring">
          {label}
        </Chip>
      );
  }
}

/** Seconds as "1h 2m" / "45m 3s"; a dash when the feed gives none. */
export function episodeDuration(seconds: number | null | undefined): string {
  return seconds == null ? '—' : formatDuration(seconds * 1000);
}

// ---------------------------------------------------------------------------------------
// Episode table
// ---------------------------------------------------------------------------------------

type EpisodeLike = PodcastEpisode | PodcastEpisodeRow;

function hasPodcast(e: EpisodeLike): e is PodcastEpisodeRow {
  return 'podcastTitle' in e;
}

/** Chapters / transcripts markers next to the title. */
function Extras({ episode }: { episode: PodcastEpisode }) {
  const chapters = episode.hasChapters || episode.chaptersUrl !== null;
  const transcripts = episode.transcriptFiles.length > 0 || episode.transcripts.length > 0;
  if (!chapters && !transcripts) return null;
  return (
    <span className="pod-extras">
      {chapters ? (
        <Chip tone="muted" dot="none" title={episode.hasChapters ? t('podcasts.chaptersSaved') : t('podcasts.chaptersInFeed')} data-testid="chapters-indicator">
          {t('podcasts.chapters')}
        </Chip>
      ) : null}
      {transcripts ? (
        <Chip tone="muted" dot="none" title={episode.transcriptFiles.length ? t('podcasts.transcriptsSaved') : t('podcasts.transcriptsInFeed')} data-testid="transcript-indicator">
          {t('podcasts.transcript')}
        </Chip>
      ) : null}
    </span>
  );
}

/** Download / mark played / delete file for one episode. */
function EpisodeActions({ episode }: { episode: PodcastEpisode }) {
  const download = useDownloadEpisode();
  const played = useSetEpisodePlayed();
  const removeFile = useDeleteEpisodeFile();
  const canDownload = episode.status !== 'downloaded' && episode.status !== 'downloading' && episode.status !== 'wanted';
  return (
    <span className="pod-row-actions">
      {canDownload ? (
        <Button size="sm" variant="ghost" loading={download.isPending} onClick={() => download.mutate(episode.id)} aria-label={t('podcasts.downloadEpisode', { title: episode.title })}>
          {t('common.download')}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        loading={played.isPending}
        onClick={() => played.mutate({ id: episode.id, played: !episode.played })}
        aria-label={episode.played ? t('podcasts.markUnplayedTitle', { title: episode.title }) : t('podcasts.markPlayedTitle', { title: episode.title })}
      >
        {episode.played ? t('podcasts.markUnplayed') : t('podcasts.markPlayed')}
      </Button>
      {episode.status === 'downloaded' ? (
        <Button size="sm" variant="ghost" loading={removeFile.isPending} onClick={() => removeFile.mutate(episode.id)} aria-label={t('podcasts.deleteFileTitle', { title: episode.title })}>
          {t('podcasts.deleteFile')}
        </Button>
      ) : null}
    </span>
  );
}

export function EpisodeTable({
  rows,
  loading,
  showPodcast = false,
  selected,
  onSelectionChange,
  readOnly = false,
  empty,
}: {
  rows: readonly EpisodeLike[] | undefined;
  loading?: boolean;
  /** The all-episodes view: a Podcast column. */
  showPodcast?: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (ids: Set<number>) => void;
  /** Library-area readers: no row actions or selection. */
  readOnly?: boolean;
  empty?: ReactNode;
}) {
  const columns: Column<EpisodeLike>[] = [
    {
      key: 'title',
      header: t('podcasts.episode'),
      cell: (e) => (
        <span className="pod-episode-title">
          <span>{e.title}</span>
          {e.season != null || e.episodeNumber != null ? (
            <span className="al-num pod-episode-code">{[e.season != null ? `S${e.season}` : null, e.episodeNumber != null ? `E${e.episodeNumber}` : null].filter(Boolean).join('')}</span>
          ) : null}
          {e.episodeType !== 'full' ? (
            <Chip tone="muted" dot="none">
              {e.episodeType === 'trailer' ? t('podcasts.trailer') : t('podcasts.bonus')}
            </Chip>
          ) : null}
          <Extras episode={e} />
        </span>
      ),
    },
    ...(showPodcast
      ? [
          {
            key: 'podcast',
            header: t('common.podcasts'),
            cell: (e: EpisodeLike) =>
              hasPodcast(e) ? (
                <Link {...podcastLink({ id: e.podcastId })} className="mk-link">
                  {e.podcastTitle}
                </Link>
              ) : null,
          } satisfies Column<EpisodeLike>,
        ]
      : []),
    { key: 'status', header: t('common.status'), cell: (e) => <EpisodeStatusChip episode={e} /> },
    {
      key: 'played',
      header: t('podcasts.played'),
      cell: (e) => (e.played ? <span title={e.playedAt ? formatDate(e.playedAt) : undefined}>{t('podcasts.played')}</span> : <span className="al-caption">{t('podcasts.unplayed')}</span>),
    },
    { key: 'date', header: t('podcasts.published'), cell: (e) => formatDate(e.publishedAt), mono: true },
    { key: 'duration', header: t('podcasts.duration'), cell: (e) => episodeDuration(e.durationSeconds), mono: true, align: 'right' },
    { key: 'size', header: t('common.size'), cell: (e) => formatBytes(e.sizeBytes), mono: true, align: 'right' },
    ...(readOnly ? [] : [{ key: 'actions', header: <span className="al-sr-only">{t('common.actions')}</span>, label: t('common.actions'), cell: (e: EpisodeLike) => <EpisodeActions episode={e} />, mobile: 'end' as const, align: 'right' as const }]),
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(e) => e.id}
      loading={loading}
      sortable={false}
      selectable={!readOnly}
      selected={selected}
      onSelectionChange={(keys) => onSelectionChange(new Set([...keys].map(Number)))}
      rowLabel={(e) => t('podcasts.selectEpisode', { title: e.title })}
      caption={t('podcasts.episodes')}
      empty={empty}
    />
  );
}

/** Feed descriptions are often HTML: show them as plain text (never injected as markup). */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EXCERPT_CHARS = 240;

/** One line of the description for an episode row (the full text stays in the feed). */
export function episodeExcerpt(description: string): string {
  const text = plainText(description).replace(/\s+/g, ' ');
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text;
}

/** "S2 · #14", "#14", "S2" or nothing. */
export function episodeCode(e: Pick<PodcastEpisode, 'season' | 'episodeNumber'>): string {
  return [e.season != null ? `S${e.season}` : null, e.episodeNumber != null ? `#${e.episodeNumber}` : null].filter(Boolean).join(' · ');
}

/**
 * A show's episodes as rows (Players 1b): date and number, title with the description excerpt,
 * then duration · size with the status, played and chapters / transcript markers, and the row
 * actions. Rows stack on phones.
 */
export function EpisodeList({
  rows,
  loading,
  selected,
  onSelectionChange,
  readOnly = false,
  empty,
}: {
  rows: readonly PodcastEpisode[] | undefined;
  loading?: boolean;
  selected: ReadonlySet<number>;
  onSelectionChange: (ids: Set<number>) => void;
  readOnly?: boolean;
  empty?: ReactNode;
}) {
  if (loading && !rows) return <Skeleton lines={6} />;
  if (!rows || rows.length === 0) return <p className="al-caption">{empty}</p>;
  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectionChange(next);
  };
  return (
    <ul className="pod-eps" aria-label={t('podcasts.episodes')} data-testid="episode-list">
      {rows.map((e) => {
        const code = episodeCode(e);
        const excerpt = episodeExcerpt(e.description);
        const facts = [episodeDuration(e.durationSeconds), e.sizeBytes ? formatBytes(e.sizeBytes) : null].filter(Boolean).join(' · ');
        return (
          <li key={e.id} className="pod-ep" data-played={e.played || undefined} data-selected={selected.has(e.id) || undefined}>
            {readOnly ? null : (
              <span className="pod-ep__check">
                <Checkbox checked={selected.has(e.id)} onChange={(ev) => toggle(e.id, ev.currentTarget.checked)} aria-label={t('podcasts.selectEpisode', { title: e.title })} />
              </span>
            )}
            <span className="pod-ep__when al-num">
              <span>{e.publishedAt ? formatDate(e.publishedAt) : '—'}</span>
              {code ? <span className="pod-ep__no">{code}</span> : null}
            </span>
            <span className="pod-ep__main">
              <span className="pod-ep__title">
                <span>{e.title}</span>
                {e.episodeType !== 'full' ? (
                  <Chip tone="muted" dot="none">
                    {e.episodeType === 'trailer' ? t('podcasts.trailer') : t('podcasts.bonus')}
                  </Chip>
                ) : null}
              </span>
              {excerpt ? <span className="pod-ep__desc">{excerpt}</span> : null}
            </span>
            <span className="pod-ep__meta">
              <span className="al-num">{facts}</span>
              <span className="pod-ep__chips">
                <EpisodeStatusChip episode={e} />
                {e.played ? (
                  <Chip tone="muted" dot="none" title={e.playedAt ? formatDate(e.playedAt) : undefined}>
                    {t('podcasts.played')}
                  </Chip>
                ) : null}
                <Extras episode={e} />
              </span>
            </span>
            {readOnly ? null : (
              <span className="pod-ep__actions">
                <EpisodeActions episode={e} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Bulk actions over selected episodes (POST /podcast/episode/bulk). */
export function EpisodeBulkBar({ ids, total, onSelectAll, onClear }: { ids: number[]; total: number; onSelectAll: () => void; onClear: () => void }) {
  const bulk = useBulkEpisodes();
  const toast = useToast();
  const run = (action: PodcastEpisodeBulkAction) =>
    bulk.mutate(
      { ids, action },
      {
        onSuccess: (r) => {
          toast.push({ tone: 'ok', title: t('podcasts.bulkUpdated', { count: r.updated }) });
          onClear();
        },
      },
    );
  const actions: BulkAction[] = [
    { id: 'download', label: t('common.download'), onSelect: () => run('download'), loading: bulk.isPending && bulk.variables.action === 'download' },
    { id: 'markPlayed', label: t('podcasts.markPlayed'), onSelect: () => run('markPlayed') },
    { id: 'markUnplayed', label: t('podcasts.markUnplayed'), onSelect: () => run('markUnplayed') },
    { id: 'skip', label: t('podcasts.skip'), onSelect: () => run('skip') },
    { id: 'deleteFile', label: t('podcasts.deleteFile'), onSelect: () => run('deleteFile'), danger: true },
  ];
  if (ids.length === 0) return null;
  return <BulkBar count={ids.length} total={total} onSelectAll={onSelectAll} actions={actions} onClear={onClear} />;
}

// ---------------------------------------------------------------------------------------
// Per-podcast settings
// ---------------------------------------------------------------------------------------

const ENCLOSURES: readonly PodcastEnclosurePreference[] = ['feed', 'audio', 'video', 'smallest', 'largest'];

export function enclosureLabel(e: PodcastEnclosurePreference): string {
  switch (e) {
    case 'feed':
      return t('podcasts.enclosure.feed');
    case 'audio':
      return t('podcasts.enclosure.audio');
    case 'video':
      return t('podcasts.enclosure.video');
    case 'smallest':
      return t('podcasts.enclosure.smallest');
    case 'largest':
      return t('podcasts.enclosure.largest');
  }
}

/** An optional whole number: empty text is null. */
function optionalInt(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n));
}

/** Every PodcastSubscriptionSettings field (the edit dialog, Add podcast and the settings defaults). */
export function SubscriptionSettingsFields({ value, onChange }: { value: PodcastSubscriptionSettings; onChange: (v: PodcastSubscriptionSettings) => void }) {
  const base = useId();
  const id = (k: string) => `${base}-${k}`;
  const set = <K extends keyof PodcastSubscriptionSettings>(k: K, v: PodcastSubscriptionSettings[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="pod-settings-fields">
      <FormRow label={t('podcasts.fields.autoDownload')} htmlFor={id('auto')} captionInline caption={t('podcasts.fields.autoDownloadCaption')}>
        <Toggle id={id('auto')} checked={value.autoDownload} onChange={(e) => set('autoDownload', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('podcasts.fields.backlog')} htmlFor={id('backlog')} caption={t('podcasts.fields.backlogCaption')}>
        <Input id={id('backlog')} type="number" mono min={0} max={10000} className="pod-num" value={value.backlog} onChange={(e) => set('backlog', optionalInt(e.currentTarget.value) ?? 0)} />
      </FormRow>
      <FormRow label={t('podcasts.fields.keepLast')} htmlFor={id('keep')} caption={t('podcasts.fields.keepLastCaption')}>
        <Input
          id={id('keep')}
          type="number"
          mono
          min={1}
          max={10000}
          className="pod-num"
          placeholder={t('podcasts.fields.all')}
          value={value.keepLast ?? ''}
          onChange={(e) => {
            const n = optionalInt(e.currentTarget.value);
            set('keepLast', n === null || n < 1 ? null : n);
          }}
        />
      </FormRow>
      <FormRow label={t('podcasts.fields.deletePlayed')} htmlFor={id('played')} caption={t('podcasts.fields.deletePlayedCaption')}>
        <Input
          id={id('played')}
          type="number"
          mono
          min={0}
          max={3650}
          end={t('podcasts.fields.days')}
          className="pod-num"
          placeholder={t('podcasts.fields.never')}
          value={value.deletePlayedAfterDays ?? ''}
          onChange={(e) => set('deletePlayedAfterDays', optionalInt(e.currentTarget.value))}
        />
      </FormRow>
      <FormRow label={t('podcasts.fields.enclosure')} htmlFor={id('enclosure')} caption={t('podcasts.fields.enclosureCaption')}>
        <Select
          id={id('enclosure')}
          value={value.enclosure}
          onChange={(e) => set('enclosure', e.currentTarget.value as PodcastEnclosurePreference)}
          options={ENCLOSURES.map((v) => ({ value: v, label: enclosureLabel(v) }))}
        />
      </FormRow>
      <FormRow label={t('podcasts.fields.writeTags')} htmlFor={id('tags')} captionInline caption={t('podcasts.fields.writeTagsCaption')}>
        <Toggle id={id('tags')} checked={value.writeTags} onChange={(e) => set('writeTags', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('podcasts.fields.embedCover')} htmlFor={id('cover')} captionInline caption={t('podcasts.fields.embedCoverCaption')}>
        <Toggle id={id('cover')} checked={value.embedCover} onChange={(e) => set('embedCover', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('podcasts.fields.keepChapters')} htmlFor={id('chapters')} captionInline caption={t('podcasts.fields.keepChaptersCaption')}>
        <Toggle id={id('chapters')} checked={value.keepChapters} onChange={(e) => set('keepChapters', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('podcasts.fields.keepTranscripts')} htmlFor={id('transcripts')} captionInline caption={t('podcasts.fields.keepTranscriptsCaption')}>
        <Toggle id={id('transcripts')} checked={value.keepTranscripts} onChange={(e) => set('keepTranscripts', e.currentTarget.checked)} />
      </FormRow>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------

/** Unsubscribe, optionally deleting the downloaded episodes too. */
export function DeletePodcastDialog({ podcast, open, onClose, onDeleted }: { podcast: Pick<Podcast, 'id' | 'title' | 'path'>; open: boolean; onClose: () => void; onDeleted?: () => void }) {
  const remove = useDeletePodcast();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const checkId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('podcasts.deleteTitle', { title: podcast.title })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: podcast.id, deleteFiles },
                {
                  onSuccess: () => {
                    onClose();
                    onDeleted?.();
                  },
                },
              )
            }
          >
            {t('podcasts.unsubscribe')}
          </Button>
        </>
      }
    >
      <p>{t('podcasts.deleteBody')}</p>
      <Checkbox id={checkId} checked={deleteFiles} onChange={(e) => setDeleteFiles(e.currentTarget.checked)} label={t('podcasts.deleteFilesLabel', { path: podcast.path })} />
    </Modal>
  );
}
