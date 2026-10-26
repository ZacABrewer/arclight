import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { Episode, MediaFile, NewItemMonitor, Season, Series, SeriesType } from '@media-tron/shared';
import { PENDING_FEATURES } from '../../api/library.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../components/form.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { countStatuses } from '../../components/media/episode-status.js';
import { episodeCode, formatBytes, formatDate, imageUrl, seasonLabel } from '../../components/media/format.js';
import { EpisodeStatusChip, Facts, MonitorToggle, PendingButton, Poster, ProgressBar, QualityBadge, TagList } from '../../components/media/media-ui.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { Modal } from '../../components/modal.js';
import { FoundInLists } from '../../components/media/found-in-lists.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column } from '../../components/table.js';
import { Tabs } from '../../components/tabs.js';
import {
  useDeleteSeries,
  useEpisodes,
  useQualityProfiles,
  useRootFolders,
  useSeries,
  useSeriesFiles,
  useSetEpisodeMonitored,
  useSetSeasonMonitored,
  useSetSeriesMonitored,
  useTags,
  useUpdateSeries,
  useAutomaticSearch,
  type ReleaseSearchTarget,
} from '../../hooks/library.js';
import { InteractiveSearchModal } from './interactive-search.js';
import { cx } from '../../lib/cx.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';
import { SERIES_TYPE_LABELS } from './add-form.js';
import { SubtitlesTab } from '../subtitles/subtitles-tab.js';
import { LanguageProfileSelect } from '../subtitles/language-profile-select.js';

const route = getRouteApi('/library/series/$id');

export interface InteractiveState {
  target: ReleaseSearchTarget;
  title: string;
}

export const PENDING_REFRESH = 'Refresh has no api contract yet (POST /command/refresh); not available';

export function SeriesDetailsPage() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const series = useSeries(id);
  const episodes = useEpisodes(id);
  const files = useSeriesFiles(id);
  const profiles = useQualityProfiles();
  const tags = useTags();
  const setMonitored = useSetSeriesMonitored();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useDeleteSeries();
  const search = useAutomaticSearch();
  const [interactive, setInteractive] = useState<InteractiveState | null>(null);
  const navigate = useNavigate();

  if (!Number.isInteger(id) || id <= 0) return <ErrorView error={new Error(`Invalid series id: ${rawId}`)} />;
  if (series.isPending) return <LoadingBlock />;
  if (series.isError) return <ErrorView error={series.error} onRetry={() => void series.refetch()} />;
  const s = series.data;
  const fanart = imageUrl(s.images, 'fanart');
  const profile = profiles.data?.find((p) => p.id === s.qualityProfileId);

  return (
    <Page title={s.title} subtitle={`${s.year || ''} ${s.network ? `· ${s.network}` : ''}`.trim()}>
      <section className="media-hero" aria-label="Series overview">
        {fanart ? <div className="media-hero-fanart" style={{ backgroundImage: `url("${fanart}")` }} aria-hidden="true" /> : null}
        <Poster url={imageUrl(s.images, 'poster')} title={s.title} size="lg" />
        <div className="media-hero-body">
          <h2 className="media-hero-title">
            <MonitorToggle monitored={s.monitored} onChange={(m) => setMonitored.mutate({ id: s.id, monitored: m })} />
            {s.title}
            <Badge tone={s.status === 'continuing' ? 'ok' : s.status === 'upcoming' ? 'info' : 'neutral'}>
              {STATUS_LABELS[s.status] ?? s.status}
            </Badge>
          </h2>
          <Facts
            items={[
              ['Network', s.network ?? '—'],
              ['Quality profile', profile?.name ?? `#${s.qualityProfileId}`],
              ['Path', <code key="p">{s.path}</code>],
              ['Size on disk', formatBytes(s.statistics?.sizeOnDisk)],
              ['Episodes', `${s.statistics?.episodeFileCount ?? 0} / ${s.statistics?.episodeCount ?? 0}`],
              ['Next airing', formatDate(s.statistics?.nextAiring, { dateStyle: 'medium', timeStyle: 'short' })],
              ['Type', SERIES_TYPE_LABELS[s.seriesType]],
              ['Runtime', s.runtimeMinutes ? `${s.runtimeMinutes} min` : '—'],
              ['Genres', s.genres.join(', ') || '—'],
              ['Tags', s.tags.length ? <TagList key="t" ids={s.tags} tags={tags.data} /> : '—'],
            ]}
          />
          {s.overview ? <p className="media-hero-overview">{s.overview}</p> : null}
          <FoundInLists mediaType="series" tmdbId={s.tmdbId} />
          <div className="media-hero-actions">
            {/* TODO(contract): wire Refresh to a refresh command once packages/shared defines one. */}
            {PENDING_FEATURES.refresh ? null : (
              <PendingButton reason={PENDING_REFRESH} size="md">
                Refresh
              </PendingButton>
            )}
            <Button loading={search.isPending} onClick={() => search.mutate({ seriesId: s.id })}>
              Search monitored
            </Button>
            <Button onClick={() => setInteractive({ target: { seriesId: s.id }, title: s.title })}>Interactive search</Button>
            <Link className="btn btn-secondary btn-md" to="/activity/manual-import" search={{ seriesId: s.id }}>
              Manual import
            </Link>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
        </div>
      </section>

      <Tabs
        tabs={[
          {
            id: 'episodes',
            label: 'Episodes',
            content: <SeasonList series={s} episodes={episodes.data} error={episodes.error} files={files.data} onInteractive={setInteractive} />,
          },
          {
            id: 'files',
            label: `Files${files.data ? ` (${files.data.length})` : ''}`,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="series" ownerId={s.id} />,
          },
          {
            id: 'subtitles',
            label: 'Subtitles',
            content: <SubtitlesTab scope={{ seriesId: s.id }} episodes={episodes.data} />,
          },
        ]}
      />

      <InteractiveSearchModal target={interactive?.target ?? null} title={interactive?.title ?? ''} onClose={() => setInteractive(null)} />
      <EditSeriesDialog open={editing} onClose={() => setEditing(false)} series={s} />
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={s.title}
        path={s.path}
        loading={del.isPending}
        onConfirm={(opts) =>
          del.mutate(
            { ids: [s.id], ...opts },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate({ to: '/library/tv' });
              },
            },
          )
        }
      />
    </Page>
  );
}

/** Seasons newest first, specials last. */
export function orderSeasons(seasons: readonly Season[]): Season[] {
  return [...seasons].sort((a, b) => {
    if (a.seasonNumber === 0) return 1;
    if (b.seasonNumber === 0) return -1;
    return b.seasonNumber - a.seasonNumber;
  });
}

function SeasonList({
  series,
  episodes,
  error,
  files,
  onInteractive,
}: {
  series: Series;
  episodes: Episode[] | undefined;
  error: unknown;
  files: MediaFile[] | undefined;
  onInteractive: (s: InteractiveState) => void;
}) {
  const bySeason = useMemo(() => {
    const m = new Map<number, Episode[]>();
    for (const ep of episodes ?? []) {
      const list = m.get(ep.seasonNumber) ?? [];
      list.push(ep);
      m.set(ep.seasonNumber, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.episodeNumber - a.episodeNumber);
    return m;
  }, [episodes]);
  const fileById = useMemo(() => new Map((files ?? []).map((f) => [f.id, f])), [files]);
  const seasons = orderSeasons(series.seasons);
  // Latest real season starts open.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(seasons.filter((x) => x.seasonNumber > 0).slice(0, 1).map((x) => x.seasonNumber)));

  if (error) return <ErrorView error={error} />;
  if (seasons.length === 0) return <EmptyState title="No seasons" />;

  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <div>
      {seasons.map((season) => (
        <SeasonPanel
          key={season.seasonNumber}
          series={series}
          season={season}
          episodes={bySeason.get(season.seasonNumber)}
          loadingEpisodes={episodes === undefined}
          fileById={fileById}
          open={open.has(season.seasonNumber)}
          onToggle={() => toggle(season.seasonNumber)}
          onInteractive={onInteractive}
        />
      ))}
    </div>
  );
}

function SeasonPanel({
  series,
  season,
  episodes,
  loadingEpisodes,
  fileById,
  open,
  onToggle,
  onInteractive,
}: {
  series: Series;
  season: Season;
  episodes: Episode[] | undefined;
  loadingEpisodes: boolean;
  fileById: Map<number, MediaFile>;
  open: boolean;
  onToggle: () => void;
  onInteractive: (s: InteractiveState) => void;
}) {
  const search = useAutomaticSearch();
  const setSeason = useSetSeasonMonitored();
  const setEpisode = useSetEpisodeMonitored();
  const stats = season.statistics;
  const counts = countStatuses(episodes ?? [], { seriesMonitored: series.monitored });
  const label = seasonLabel(season.seasonNumber);
  const bodyId = `season-${season.seasonNumber}-body`;

  const columns: Column<Episode>[] = [
    {
      key: 'monitored',
      header: <span className="sr-only">Monitored</span>,
      cell: (ep) => (
        <MonitorToggle
          monitored={ep.monitored}
          label={`${ep.monitored ? 'Unmonitor' : 'Monitor'} episode ${ep.episodeNumber}`}
          onChange={(m) => setEpisode.mutate({ seriesId: series.id, episodeId: ep.id, monitored: m })}
        />
      ),
      width: '32px',
    },
    { key: 'number', header: '#', sortValue: (ep) => ep.episodeNumber, cell: (ep) => ep.episodeNumber, width: '48px' },
    { key: 'title', header: 'Title', sortValue: (ep) => ep.title, cell: (ep) => ep.title || <span className="muted">TBA</span> },
    { key: 'airDate', header: 'Air date', sortValue: (ep) => ep.airDateUtc ?? ep.airDate, cell: (ep) => formatDate(ep.airDateUtc ?? ep.airDate) },
    {
      key: 'quality',
      header: 'Quality',
      cell: (ep) => (ep.episodeFileId != null ? <QualityBadge quality={fileById.get(ep.episodeFileId)?.quality} /> : <span className="muted">—</span>),
    },
    { key: 'status', header: 'Status', cell: (ep) => <EpisodeStatusChip episode={ep} seriesMonitored={series.monitored} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (ep) => (
        <span className="toolbar" style={{ margin: 0, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
          <Button
            size="sm"
            aria-label={`Search ${episodeCode(ep.seasonNumber, ep.episodeNumber)}`}
            loading={search.isPending && search.variables.episodeIds?.[0] === ep.id}
            onClick={() => search.mutate({ episodeIds: [ep.id] })}
          >
            Search
          </Button>
          <Button
            size="sm"
            aria-label={`Interactive search ${episodeCode(ep.seasonNumber, ep.episodeNumber)}`}
            onClick={() =>
              onInteractive({ target: { episodeId: ep.id }, title: `${series.title} ${episodeCode(ep.seasonNumber, ep.episodeNumber)}` })
            }
          >
            Interactive
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section className={cx('season', !season.monitored && 'season-unmonitored')} aria-label={label}>
      <header className="season-header">
        <MonitorToggle
          monitored={season.monitored}
          label={`${season.monitored ? 'Unmonitor' : 'Monitor'} ${label}`}
          onChange={(m) => setSeason.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber, monitored: m })}
        />
        <button type="button" className="season-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {label}
        </button>
        <ProgressBar value={stats?.episodeFileCount ?? 0} total={stats?.episodeCount ?? 0} label={`${label} progress`} />
        <span className="muted">{stats ? `${stats.totalEpisodeCount} episodes · ${formatBytes(stats.sizeOnDisk)}` : ''}</span>
        {counts.wanted > 0 ? <Badge tone="error">{counts.wanted} wanted</Badge> : null}
        <span className="toolbar-spacer" />
        <Button
          size="sm"
          loading={search.isPending && search.variables.seasonNumber === season.seasonNumber}
          onClick={() => search.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber })}
        >
          Search season
        </Button>
        <Button
          size="sm"
          onClick={() => onInteractive({ target: { seriesId: series.id, seasonNumber: season.seasonNumber }, title: `${series.title} ${label}` })}
        >
          Interactive
        </Button>
      </header>
      {open ? (
        <div className="season-body" id={bodyId}>
          {loadingEpisodes ? (
            <LoadingBlock />
          ) : (
            <Table
              columns={columns}
              rows={episodes ?? []}
              rowKey={(ep) => ep.id}
              empty={<EmptyState title="No episodes" />}
              caption={`${label} episodes`}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function EditSeriesDialog({ open, onClose, series }: { open: boolean; onClose: () => void; series: Series }) {
  return (
    <Modal open={open} onClose={onClose} title={`Edit ${series.title}`} size="md">
      {open ? <EditSeriesForm series={series} onClose={onClose} /> : null}
    </Modal>
  );
}

function EditSeriesForm({ series, onClose }: { series: Series; onClose: () => void }) {
  const profiles = useQualityProfiles();
  const rootFolders = useRootFolders();
  const update = useUpdateSeries();
  const [monitored, setMonitored] = useState(series.monitored);
  const [monitorNewItems, setMonitorNewItems] = useState<NewItemMonitor>(series.monitorNewItems);
  const [qualityProfileId, setProfile] = useState(series.qualityProfileId);
  const [seriesType, setSeriesType] = useState<SeriesType>(series.seriesType);
  const [seasonFolder, setSeasonFolder] = useState(series.seasonFolder);
  const [path, setPath] = useState(series.path);
  const [tags, setTags] = useState<number[]>([...series.tags]);
  const [languageProfileId, setLanguageProfileId] = useState<number | null>(series.languageProfileId ?? null);
  const roots = (rootFolders.data ?? []).filter((r) => r.mediaType === 'series');

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          {
            id: series.id,
            body: {
              monitored,
              monitorNewItems,
              qualityProfileId,
              seriesType,
              seasonFolder,
              tags,
              ...(languageProfileId !== (series.languageProfileId ?? null) ? { languageProfileId } : {}),
              ...(path.trim() && path !== series.path ? { path: path.trim() } : {}),
            },
          },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="fields">
        <Toggle label="Monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        <FormField label="Monitor new seasons">
          <Select value={monitorNewItems} onChange={(e) => setMonitorNewItems(e.target.value as NewItemMonitor)}>
            <option value="all">All new seasons</option>
            <option value="none">None</option>
          </Select>
        </FormField>
        <FormField label="Quality profile">
          <Select value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <LanguageProfileSelect value={languageProfileId} onChange={setLanguageProfileId} />
        <FormField label="Series type">
          <Select value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType)}>
            {Object.entries(SERIES_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
        <Toggle label="Use season folders" checked={seasonFolder} onChange={(e) => setSeasonFolder(e.target.checked)} />
        <FormField label="Path" hint={roots.length ? `Root folders: ${roots.map((r) => r.path).join(', ')}` : undefined}>
          <Input value={path} onChange={(e) => setPath(e.target.value)} />
        </FormField>
        <div className="field">
          <span className="field-label">Tags</span>
          <TagPicker value={tags} onChange={setTags} />
        </div>
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
