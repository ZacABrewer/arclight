import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { Episode, MediaFile, NewItemMonitor, Season, Series, SeriesType } from '@arclight/shared';
import { PENDING_FEATURES } from '../../api/library.js';
import {
  Accordion,
  AccordionItem,
  BackdropFrame,
  Button,
  Drawer,
  EmptyState,
  FormRow,
  Input,
  KeyValue,
  Meter,
  Modal,
  QualityTag,
  Select,
  StatusChip,
  Tabs,
  Toggle,
  Tooltip,
  buttonClass,
} from '../../arclight/index.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { countStatuses, episodeStatus } from '../../components/media/episode-status.js';
import { episodeCode, formatBytes, formatDate, imageUrl, seasonLabel } from '../../components/media/format.js';
import { FoundInLists } from '../../components/media/found-in-lists.js';
import { EpisodeChip, Loading, MonitorSwitch, Num, QueryError, SwipeRow, TagChips, qualityName, useIsMobile } from '../../components/media/media-kit.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import {
  useAutomaticSearch,
  useDeleteMediaFile,
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
  type ReleaseSearchTarget,
} from '../../hooks/library.js';
import { LanguageProfileSelect } from '../subtitles/language-profile-select.js';
import { SubtitlesTab } from '../subtitles/subtitles-tab.js';
import { SERIES_TYPE_LABELS } from './add-form.js';
import { DetailsHero, HistoryEventChip, HistoryTable, LibraryCrumb, RequestsTable, historyEventLabel, useMediaHistory, useQueueProgress } from './details-kit.js';
import { InteractiveSearchModal, ReleaseTable } from './interactive-search.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';

const route = getRouteApi('/library/series/$id');

export interface InteractiveState {
  target: ReleaseSearchTarget;
  title: string;
}

export const PENDING_REFRESH = 'Refresh is not available yet: the api has no refresh command.';

/** Refresh stays visible but disabled until the api has a refresh command. */
export function RefreshButton() {
  if (PENDING_FEATURES.refresh) return <Button>Refresh</Button>;
  return (
    <Tooltip content={PENDING_REFRESH}>
      <Button aria-disabled="true" aria-label="Refresh (not available yet)" className="lib-disabled" onClick={(e) => e.preventDefault()}>
        Refresh
      </Button>
    </Tooltip>
  );
}

/** Season header text: "Airing · 1 of 9 aired", "Complete", "Not started". */
export function seasonSummary(season: Season, episodes: readonly Episode[] | undefined, now: Date = new Date()): string {
  const stats = season.statistics;
  const total = stats?.totalEpisodeCount ?? episodes?.length ?? 0;
  const aired = episodes ? episodes.filter((e) => episodeStatus(e, { now }) !== 'unaired' && episodeStatus(e, { now }) !== 'tba').length : (stats?.episodeCount ?? 0);
  if (total === 0) return 'No episodes';
  if (stats && stats.episodeCount > 0 && stats.episodeFileCount >= stats.episodeCount && aired >= total) return 'Complete';
  if (aired < total) return `Airing · ${aired} of ${total} aired`;
  return `${stats?.episodeFileCount ?? 0} of ${total} on disk`;
}

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
  const [tab, setTab] = useState('episodes');
  const del = useDeleteSeries();
  const search = useAutomaticSearch();
  const [interactive, setInteractive] = useState<InteractiveState | null>(null);
  const navigate = useNavigate();

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(`Invalid series id: ${rawId}`)} title="Series not found" />;
  if (series.isPending) return <Loading />;
  if (series.isError) return <QueryError error={series.error} onRetry={() => void series.refetch()} title="Could not load this series" />;
  const s = series.data;
  const profile = profiles.data?.find((p) => p.id === s.qualityProfileId);
  const stats = s.statistics;
  const seasonCount = s.seasons.filter((x) => x.seasonNumber > 0).length;

  return (
    <div className="lib-details">
      <DetailsHero
        label="Series overview"
        backdrop={imageUrl(s.images, 'fanart')}
        poster={imageUrl(s.images, 'poster')}
        title={s.title}
        year={s.year}
        crumb={<LibraryCrumb kind="series" />}
        meta={[
          s.network,
          s.genres.slice(0, 3).join(', ') || null,
          `${seasonCount} ${seasonCount === 1 ? 'season' : 'seasons'}`,
          s.runtimeMinutes ? `${s.runtimeMinutes} min` : null,
          STATUS_LABELS[s.status] ?? s.status,
        ]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch monitored={s.monitored} onChange={(m) => setMonitored.mutate({ id: s.id, monitored: m })} label={`${s.monitored ? 'Unmonitor' : 'Monitor'} ${s.title}`} />
            <StatusChip status={s.monitored ? 'monitored' : 'unmonitored'} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <span className="al-chip al-chip--nodot al-chip--lg">{SERIES_TYPE_LABELS[s.seriesType]}</span>
            <TagChips ids={s.tags} tags={tags.data} />
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: 'Path', value: s.path },
              { label: 'Size on disk', value: formatBytes(stats?.sizeOnDisk) },
              { label: 'Episodes', value: `${stats?.episodeFileCount ?? 0} / ${stats?.episodeCount ?? 0}` },
              { label: 'Next airing', value: formatDate(stats?.nextAiring, { dateStyle: 'medium', timeStyle: 'short' }) },
            ]}
          />
        }
        overview={s.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ seriesId: s.id })}>
              Search monitored
            </Button>
            <Button onClick={() => setInteractive({ target: { seriesId: s.id }, title: s.title })}>Interactive search</Button>
            <RefreshButton />
            <Link className={buttonClass({ variant: 'secondary' })} to="/activity/manual-import" search={{ seriesId: s.id }}>
              Manual import
            </Link>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      >
        <FoundInLists mediaType="series" tmdbId={s.tmdbId} />
      </DetailsHero>

      <Tabs
        aria-label="Series sections"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'episodes',
            label: 'Seasons & episodes',
            content: <SeasonList series={s} episodes={episodes.data} error={episodes.error} files={files.data} onInteractive={setInteractive} />,
          },
          {
            id: 'files',
            label: 'Files',
            count: files.data?.length,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="series" ownerId={s.id} />,
          },
          { id: 'history', label: 'History', content: <HistoryTable scope={{ seriesId: s.id }} /> },
          { id: 'search', label: 'Search', content: <SearchTab target={{ seriesId: s.id }} /> },
          { id: 'subtitles', label: 'Subtitles', content: <SubtitlesTab scope={{ seriesId: s.id }} episodes={episodes.data} /> },
          { id: 'requests', label: 'Requests', content: <RequestsTable kind="tv" tmdbId={s.tmdbId} /> },
        ]}
      />

      <InteractiveSearchModal target={interactive?.target ?? null} title={interactive?.title ?? ''} onClose={() => setInteractive(null)} />
      {editing ? <EditSeriesModal onClose={() => setEditing(false)} series={s} /> : null}
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={s.title}
        noun="series"
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
    </div>
  );
}

/** Details "Search" tab: runs an interactive search on demand. */
export function SearchTab({ target }: { target: ReleaseSearchTarget }) {
  const [started, setStarted] = useState(false);
  if (!started) {
    return (
      <EmptyState
        title="Search every indexer for releases"
        action={
          <Button variant="primary" onClick={() => setStarted(true)}>
            Search releases
          </Button>
        }
      >
        Results list every release with its rejections. Grab sends one to the download client.
      </EmptyState>
    );
  }
  return <ReleaseTable target={target} />;
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
  const progress = useQueueProgress(useMemo(() => ({ seriesId: series.id }), [series.id]));
  const seasons = orderSeasons(series.seasons);
  const [drawer, setDrawer] = useState<Episode | null>(null);
  const latest = seasons.find((x) => x.seasonNumber > 0)?.seasonNumber;

  if (error) return <QueryError error={error} title="Could not load episodes" />;
  if (seasons.length === 0) return <EmptyState title="No seasons yet">TMDB has not listed any seasons for this series.</EmptyState>;

  return (
    <>
      <Accordion>
        {seasons.map((season) => (
          <SeasonPanel
            key={season.seasonNumber}
            series={series}
            season={season}
            episodes={bySeason.get(season.seasonNumber)}
            loadingEpisodes={episodes === undefined}
            fileById={fileById}
            progress={progress.episodes}
            defaultOpen={season.seasonNumber === latest}
            onInteractive={onInteractive}
            onOpenEpisode={setDrawer}
          />
        ))}
      </Accordion>
      <EpisodeDrawer
        series={series}
        episode={drawer}
        file={drawer?.episodeFileId != null ? fileById.get(drawer.episodeFileId) : undefined}
        downloading={drawer ? progress.episodes.get(drawer.id) : undefined}
        onClose={() => setDrawer(null)}
        onInteractive={onInteractive}
      />
    </>
  );
}

function SeasonPanel({
  series,
  season,
  episodes,
  loadingEpisodes,
  fileById,
  progress,
  defaultOpen,
  onInteractive,
  onOpenEpisode,
}: {
  series: Series;
  season: Season;
  episodes: Episode[] | undefined;
  loadingEpisodes: boolean;
  fileById: Map<number, MediaFile>;
  progress: Map<number, number>;
  defaultOpen: boolean;
  onInteractive: (s: InteractiveState) => void;
  onOpenEpisode: (ep: Episode) => void;
}) {
  const search = useAutomaticSearch();
  const setSeason = useSetSeasonMonitored();
  const stats = season.statistics;
  const label = seasonLabel(season.seasonNumber);
  const counts = countStatuses(episodes ?? [], { seriesMonitored: series.monitored });
  const have = stats?.episodeFileCount ?? 0;
  const want = stats?.episodeCount ?? 0;

  return (
    <AccordionItem
      title={label}
      defaultOpen={defaultOpen}
      meta={seasonSummary(season, episodes)}
      aside={
        <div className="mk-season-aside">
          <MonitorSwitch
            monitored={season.monitored}
            label={`${season.monitored ? 'Unmonitor' : 'Monitor'} ${label}`}
            onChange={(m) => setSeason.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber, monitored: m })}
          />
          <span className="mk-muted mk-hide-mobile" style={{ fontSize: 13 }}>
            {season.monitored ? 'Monitored' : 'Unmonitored'}
          </span>
          <Meter
            value={want > 0 ? (have / want) * 100 : 0}
            tone={counts.wanted > 0 ? 'warn' : 'default'}
            label={`${label} progress`}
            valueText={`${have}/${want}${stats ? ` · ${formatBytes(stats.sizeOnDisk)}` : ''}`}
          />
          <span className="mk-spacer" />
          <button
            type="button"
            className="mk-action-link"
            disabled={search.isPending && search.variables.seasonNumber === season.seasonNumber}
            onClick={() => search.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber })}
          >
            Search season
          </button>
          <button
            type="button"
            className="mk-action-link mk-hide-mobile"
            aria-label={`Interactive search ${label}`}
            onClick={() => onInteractive({ target: { seriesId: series.id, seasonNumber: season.seasonNumber }, title: `${series.title} ${label}` })}
          >
            Interactive
          </button>
        </div>
      }
    >
      {loadingEpisodes ? (
        <Loading />
      ) : !episodes || episodes.length === 0 ? (
        <EmptyState title="No episodes yet" />
      ) : (
        <div className="mk-eps" role="table" aria-label={`${label} episodes`}>
          <div className="mk-eps__head" role="row">
            <span role="columnheader">
              <span className="al-sr-only">Monitored</span>
            </span>
            <span role="columnheader">#</span>
            <span role="columnheader">Title</span>
            <span role="columnheader">Aired</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Size</span>
            <span role="columnheader">
              <span className="al-sr-only">Actions</span>
            </span>
          </div>
          {episodes.map((ep) => (
            <EpisodeRow
              key={ep.id}
              series={series}
              episode={ep}
              file={ep.episodeFileId != null ? fileById.get(ep.episodeFileId) : undefined}
              downloading={progress.get(ep.id)}
              onOpen={() => onOpenEpisode(ep)}
              onInteractive={onInteractive}
            />
          ))}
        </div>
      )}
    </AccordionItem>
  );
}

function EpisodeRow({
  series,
  episode: ep,
  file,
  downloading,
  onOpen,
  onInteractive,
}: {
  series: Series;
  episode: Episode;
  file: MediaFile | undefined;
  downloading: number | undefined;
  onOpen: () => void;
  onInteractive: (s: InteractiveState) => void;
}) {
  const search = useAutomaticSearch();
  const setEpisode = useSetEpisodeMonitored();
  const delFile = useDeleteMediaFile();
  const isMobile = useIsMobile();
  const code = episodeCode(ep.seasonNumber, ep.episodeNumber);
  const runSearch = () => search.mutate({ episodeIds: [ep.id] });
  const row = (
    <div className="mk-ep" role="row" data-live={downloading != null || undefined}>
      <span className="mk-ep__monitor" role="cell">
        <MonitorSwitch
          monitored={ep.monitored}
          label={`${ep.monitored ? 'Unmonitor' : 'Monitor'} episode ${ep.episodeNumber}`}
          onChange={(m) => setEpisode.mutate({ seriesId: series.id, episodeId: ep.id, monitored: m })}
        />
      </span>
      <span className="mk-ep__num" role="cell">
        {String(ep.episodeNumber).padStart(2, '0')}
      </span>
      <span role="cell" style={{ minWidth: 0, display: 'flex' }}>
        <button type="button" className="mk-ep__title" onClick={onOpen} title={ep.title || 'TBA'}>
          {ep.title || 'TBA'}
        </button>
      </span>
      <span className="mk-ep__date al-num" role="cell">
        {formatDate(ep.airDateUtc ?? ep.airDate)}
      </span>
      <span role="cell">
        <EpisodeChip episode={ep} seriesMonitored={series.monitored} downloading={downloading} />
      </span>
      <span className="mk-ep__size" role="cell">
        {file ? formatBytes(file.sizeBytes) : '—'}
      </span>
      <span className="mk-ep__actions" role="cell">
        <button type="button" className="mk-action-link" aria-label={`Search ${code}`} disabled={search.isPending} onClick={runSearch}>
          Search
        </button>
        <button
          type="button"
          className="mk-action-link"
          aria-label={`Interactive search ${code}`}
          onClick={() => onInteractive({ target: { episodeId: ep.id }, title: `${series.title} ${code}` })}
        >
          Interactive
        </button>
      </span>
    </div>
  );
  if (!isMobile) return row;
  return (
    <SwipeRow
      onSearch={runSearch}
      searchLabel={`Search ${code}`}
      onDelete={file ? () => delFile.mutate({ fileId: file.id, mediaType: 'series', ownerId: series.id }) : undefined}
      deleteLabel={`Delete ${code} file`}
    >
      {row}
    </SwipeRow>
  );
}

function EpisodeDrawer({
  series,
  episode,
  file,
  downloading,
  onClose,
  onInteractive,
}: {
  series: Series;
  episode: Episode | null;
  file: MediaFile | undefined;
  downloading: number | undefined;
  onClose: () => void;
  onInteractive: (s: InteractiveState) => void;
}) {
  const search = useAutomaticSearch();
  const history = useMediaHistory({ episodeId: episode?.id ?? 0 }, episode !== null);
  if (!episode) return null;
  const code = episodeCode(episode.seasonNumber, episode.episodeNumber);
  return (
    <Drawer
      open
      onClose={onClose}
      title={`${code} · ${episode.title || 'TBA'}`}
      footer={
        <>
          <Button onClick={() => onInteractive({ target: { episodeId: episode.id }, title: `${series.title} ${code}` })}>Interactive search</Button>
          <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ episodeIds: [episode.id] })}>
            Search episode
          </Button>
        </>
      }
    >
      <BackdropFrame className="mk-drawer-still" src={imageUrl(series.images, 'fanart')} title={`${series.title} ${code}`} />
      <div className="mk-row" style={{ marginBottom: 12 }}>
        <EpisodeChip episode={episode} seriesMonitored={series.monitored} downloading={downloading} />
        <StatusChip status={episode.monitored ? 'monitored' : 'unmonitored'} />
      </div>
      <p className="mk-hero__overview" style={{ fontSize: 14 }}>
        {episode.overview || 'No overview available.'}
      </p>
      <KeyValue
        items={[
          { label: 'Aired', value: formatDate(episode.airDateUtc ?? episode.airDate, { dateStyle: 'medium', timeStyle: episode.airDateUtc ? 'short' : undefined }) },
          { label: 'Runtime', value: episode.runtimeMinutes ? `${episode.runtimeMinutes} min` : '—' },
          ...(episode.absoluteEpisodeNumber ? [{ label: 'Absolute', value: String(episode.absoluteEpisodeNumber) }] : []),
        ]}
      />
      <section className="mk-drawer-section" aria-label="File">
        <div className="al-label">File</div>
        {file ? (
          <KeyValue
            items={[
              { label: 'Path', value: file.relativePath },
              { label: 'Size', value: formatBytes(file.sizeBytes) },
              { label: 'Quality', value: qualityName(file.quality) ?? '—' },
              { label: 'Video', value: [file.mediaInfo?.videoCodec, file.mediaInfo?.resolution, file.mediaInfo?.videoDynamicRange].filter(Boolean).join(' · ') || '—' },
              { label: 'Audio', value: [file.mediaInfo?.audioCodec, file.mediaInfo?.audioChannels].filter(Boolean).join(' · ') || '—' },
              { label: 'Languages', value: file.languages.join(', ') || '—' },
              { label: 'Group', value: file.releaseGroup ?? '—' },
            ]}
          />
        ) : (
          <span className="mk-muted">No file on disk.</span>
        )}
      </section>
      <section className="mk-drawer-section" aria-label="History">
        <div className="al-label">History</div>
        {history.isPending ? (
          <Loading lines={2} />
        ) : history.isError || !history.data?.records.length ? (
          <span className="mk-muted">No history for this episode.</span>
        ) : (
          <ol className="lib-history">
            {history.data.records.map((h) => (
              <li key={h.id} aria-label={historyEventLabel(h.eventType)}>
                <Num className="mk-muted">{formatDate(h.date, { dateStyle: 'short', timeStyle: 'short' })}</Num>
                <HistoryEventChip type={h.eventType} />
                <span className="mk-release-title">{h.sourceTitle}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Drawer>
  );
}

function EditSeriesModal({ series, onClose }: { series: Series; onClose: () => void }) {
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
    <Modal
      open
      onClose={onClose}
      title={`Edit ${series.title}`}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-series-form" variant="primary" loading={update.isPending}>
            Save changes
          </Button>
        </>
      }
    >
    <form
      id="edit-series-form"
      className="mk-stack-sm"
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
      <FormRow label="Monitored" htmlFor="edit-monitored" captionInline caption="Search for missing episodes of this series.">
        <Toggle id="edit-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
      </FormRow>
      <FormRow label="Monitor new seasons" htmlFor="edit-new-seasons">
        <Select id="edit-new-seasons" value={monitorNewItems} onChange={(e) => setMonitorNewItems(e.target.value as NewItemMonitor)}>
          <option value="all">All new seasons</option>
          <option value="none">None</option>
        </Select>
      </FormRow>
      <FormRow label="Quality profile" htmlFor="edit-profile">
        <Select id="edit-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
          {(profiles.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>
      <LanguageProfileSelect value={languageProfileId} onChange={setLanguageProfileId} />
      <FormRow label="Series type" htmlFor="edit-type">
        <Select id="edit-type" value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType)}>
          {Object.entries(SERIES_TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow label="Season folders" htmlFor="edit-season-folder" captionInline caption="Put each season in its own folder.">
        <Toggle id="edit-season-folder" checked={seasonFolder} onChange={(e) => setSeasonFolder(e.target.checked)} />
      </FormRow>
      <FormRow label="Path" htmlFor="edit-path" caption={roots.length ? `Root folders: ${roots.map((r) => r.path).join(', ')}` : undefined} captionMono>
        <Input id="edit-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
      </FormRow>
      <FormRow label="Tags">
        <TagPicker value={tags} onChange={setTags} />
      </FormRow>
    </form>
    </Modal>
  );
}
