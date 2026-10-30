import { languageNames } from '../../lib/format.js';
import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { AdditionalLanguageTarget, Episode, ItemSearchStatus, MediaFile, NewItemMonitor, QueueSummaryItem, Season, Series, SeriesType } from '@arclight/shared';
import {
  Accordion,
  AccordionItem,
  BackdropFrame,
  Button,
  Checkbox,
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
  buttonClass,
} from '../../arclight/index.js';
import { BulkBar, type BulkAction } from '../../components/media/bulk-bar.js';
import { BulkRenameDialog } from '../../components/media/bulk-rename-dialog.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { countStatuses, episodeStatus } from '../../components/media/episode-status.js';
import { episodeCode, formatBytes, formatDate, imageUrl, seasonLabel } from '../../components/media/format.js';
import { FoundInLists } from '../../components/media/found-in-lists.js';
import { EpisodeChip, Loading, MonitorSwitch, Num, QueryError, SwipeRow, qualityName, useIsMobile } from '../../components/media/media-kit.js';
import { AutoTagChips } from '../../components/media/auto-tag-chips.js';
import { groupSearchText, QueueStateChip, SearchStatusLines, searchStatusTitle } from '../../components/media/pipeline-status.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useQueueSummary } from '../../hooks/activity.js';
import { useBulkSearch, useBulkSelection, useDeleteMediaFiles, useSetEpisodesMonitored } from '../../hooks/bulk.js';
import { ConfirmModal } from '../system/confirm-modal.js';
import { useSearchStatus } from '../../hooks/search-status.js';
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
import {
  DetailsHero,
  HistoryEventChip,
  HistoryTable,
  LibraryCrumb,
  RefreshButtons,
  RequestsTable,
  historyEventLabel,
  useMediaHistory,
  useQueueProgress,
} from './details-kit.js';
import { DecisionsPanel } from './decisions/decisions-panel.js';
import { InteractiveSearchModal, ReleaseTable } from './interactive-search.js';
import { SceneMappingPanel } from './scene-mapping/scene-mapping-panel.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';
import { ItemHealthPanel, useCanSeeHealth } from './item-health.js';
import { CrossSeedSearchButton } from '../../features/cross-seed/cross-seed-search.js';
import { EpisodeVersionFiles, VersionsEditor, useVersionsDraft } from './versions/versions-editor.js';
import { AddAdditionalDialog } from '../../features/additional-languages/add-additional-dialog.js';
import { ItemLanguageChips } from '../../features/additional-languages/item-language-chips.js';
import { episodeReleaseState, type ReleaseState } from '../../components/media/release-state.js';
import { t } from '../../i18n/index.js';
import { usePaletteContext } from '../../features/command-palette/registry.js';

const route = getRouteApi('/library/series/$id');

/** Target of the "Add additional…" dialog opened from the series page. */
export interface AddLanguageState {
  targets: AdditionalLanguageTarget[];
  title: string;
}

export interface InteractiveState {
  target: ReleaseSearchTarget;
  title: string;
  /** One episode: whether it has aired (an unaired one is searched under a warning). */
  release?: ReleaseState | undefined;
}

/** Season header text: "Airing · 1 of 9 aired", "Complete", "Not started". */
export function seasonSummary(season: Season, episodes: readonly Episode[] | undefined, now: Date = new Date()): string {
  const stats = season.statistics;
  const total = stats?.totalEpisodeCount ?? episodes?.length ?? 0;
  const aired = episodes ? episodes.filter((e) => episodeStatus(e, { now }) !== 'unaired' && episodeStatus(e, { now }) !== 'tba').length : (stats?.episodeCount ?? 0);
  if (total === 0) return t('library.seriesDetails.noEpisodes');
  if (stats && stats.episodeCount > 0 && stats.episodeFileCount >= stats.episodeCount && aired >= total) return t('library.seriesDetails.complete');
  if (aired < total) return t('library.seriesDetails.airingAiredOfTotalAired', { aired, total });
  return t('library.seriesDetails.valueOfTotalOnDisk', { value: stats?.episodeFileCount ?? 0, total });
}

export function SeriesDetailsPage() {
  const canSeeHealth = useCanSeeHealth();
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
  const [addLanguage, setAddLanguage] = useState<AddLanguageState | null>(null);
  const navigate = useNavigate();
  const queue = useQueueSummary();

  usePaletteContext(series.data ? { subject: { kind: 'series', id: series.data.id, title: series.data.title, year: series.data.year } } : null);
  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('library.seriesDetails.invalidSeriesIdRawid', { rawId }))} title={t('library.seriesDetails.seriesNotFound')} />;
  if (series.isPending) return <Loading />;
  if (series.isError) return <QueryError error={series.error} onRetry={() => void series.refetch()} title={t('library.seriesDetails.couldNotLoadThisSeries')} />;
  const s = series.data;
  const profile = profiles.data?.find((p) => p.id === s.qualityProfileId);
  const stats = s.statistics;
  const seasonCount = s.seasons.filter((x) => x.seasonNumber > 0).length;

  return (
    <div className="lib-details">
      <DetailsHero
        label={t('library.seriesDetails.seriesOverview')}
        backdrop={imageUrl(s.images, 'fanart')}
        poster={imageUrl(s.images, 'poster')}
        title={s.title}
        year={s.year}
        crumb={<LibraryCrumb kind="series" />}
        meta={[
          s.network,
          s.genres.slice(0, 3).join(', ') || null,
          t('library.seriesDetails.seasonCount', { count: seasonCount }),
          s.runtimeMinutes ? t('library.seriesDetails.runtimeMinutes', { minutes: s.runtimeMinutes }) : null,
          STATUS_LABELS[s.status] ?? s.status,
        ]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch monitored={s.monitored} onChange={(m) => setMonitored.mutate({ id: s.id, monitored: m })} label={t('common.monitorTitle', { monitored: s.monitored, title: s.title })} />
            <StatusChip status={s.monitored ? 'monitored' : 'unmonitored'} large />
            <QueueStateChip items={(queue.data ?? []).filter((i) => i.seriesId === s.id)} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <span className="al-chip al-chip--nodot al-chip--lg">{SERIES_TYPE_LABELS[s.seriesType]}</span>
            <AutoTagChips entityType="series" entityId={s.id} ids={s.tags} tags={tags.data} />
          </>
        }
        facts={
          <>
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.path'), value: s.path },
              { label: t('common.sizeOnDisk'), value: formatBytes(stats?.sizeOnDisk) },
              { label: t('common.episodes'), value: `${stats?.episodeFileCount ?? 0} / ${stats?.episodeCount ?? 0}` },
              { label: t('library.seriesDetails.nextAiring'), value: formatDate(stats?.nextAiring, { dateStyle: 'medium', timeStyle: 'short' }) },
            ]}
          />
          <ItemLanguageChips query={{ seriesId: s.id }} />
          </>
        }
        overview={s.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ seriesId: s.id })}>
              {t('library.seriesDetails.searchMonitored')}
            </Button>
            <Button onClick={() => setInteractive({ target: { seriesId: s.id }, title: s.title })}>{t('library.seriesDetails.interactiveSearch')}</Button>
            <Button onClick={() => setAddLanguage({ targets: [{ seriesId: s.id }], title: s.title })}>{t('features.additionalLanguages.addAdditional')}</Button>
            <RefreshButtons target={{ seriesId: s.id }} />
            <CrossSeedSearchButton target={{ seriesId: s.id }} />
            <Link className={buttonClass({ variant: 'secondary' })} to="/activity/manual-import" search={{ seriesId: s.id }}>
              {t('common.manualImport')}
            </Link>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <FoundInLists mediaType="series" tmdbId={s.tmdbId} />
      </DetailsHero>

      <Tabs
        aria-label={t('library.seriesDetails.seriesSections')}
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'episodes',
            label: t('library.seriesDetails.seasonsEpisodes'),
            content: <SeasonList series={s} episodes={episodes.data} error={episodes.error} files={files.data} onInteractive={setInteractive} onAddLanguage={setAddLanguage} />,
          },
          {
            id: 'files',
            label: t('common.files'),
            count: files.data?.length,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="series" ownerId={s.id} />,
          },
          ...(canSeeHealth ? [{ id: 'health', label: t('library.health.tab'), content: <ItemHealthPanel scope={{ seriesId: s.id }} /> }] : []),
          { id: 'history', label: t('common.history'), content: <HistoryTable scope={{ seriesId: s.id }} /> },
          { id: 'decisions', label: t('library.decisions.tab'), content: <DecisionsPanel scope={{ seriesId: s.id }} /> },
          { id: 'search', label: t('common.search'), content: <SearchTab target={{ seriesId: s.id }} /> },
          { id: 'scenemapping', label: t('library.sceneMapping.tab'), content: <SceneMappingPanel seriesId={s.id} /> },
          { id: 'subtitles', label: t('common.subtitles'), content: <SubtitlesTab scope={{ seriesId: s.id }} episodes={episodes.data} /> },
          { id: 'requests', label: t('common.requests'), content: <RequestsTable kind="tv" tmdbId={s.tmdbId} /> },
        ]}
      />

      <AddAdditionalDialog open={addLanguage !== null} onClose={() => setAddLanguage(null)} targets={addLanguage?.targets ?? []} title={addLanguage?.title ?? ''} />
      <InteractiveSearchModal target={interactive?.target ?? null} title={interactive?.title ?? ''} release={interactive?.release} onClose={() => setInteractive(null)} />
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
        title={t('library.seriesDetails.searchEveryIndexerForReleases')}
        action={
          <Button variant="primary" onClick={() => setStarted(true)}>
            {t('library.seriesDetails.searchReleases')}
          </Button>
        }
      >
        {t('library.seriesDetails.resultsListEveryReleaseWith')}
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
  onAddLanguage,
}: {
  series: Series;
  episodes: Episode[] | undefined;
  error: unknown;
  files: MediaFile[] | undefined;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
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
  // Missing (wanted) episodes: when they were searched and when the scheduled search comes back.
  const wantedIds = useMemo(
    () => (episodes ?? []).filter((e) => episodeStatus(e, { seriesMonitored: series.monitored }) === 'wanted').map((e) => e.id),
    [episodes, series.monitored],
  );
  const searchStatus = useSearchStatus('episode', wantedIds);
  const searchById = useMemo(() => new Map((searchStatus.data ?? []).map((s) => [s.id, s])), [searchStatus.data]);
  const seasons = orderSeasons(series.seasons);
  const [drawer, setDrawer] = useState<Episode | null>(null);
  const latest = seasons.find((x) => x.seasonNumber > 0)?.seasonNumber;
  const sel = useBulkSelection();
  const select: EpisodeSelect = {
    active: sel.selectMode,
    selected: sel.selected,
    toggle: sel.toggle,
    selectMany: (ids) => sel.setSelected((prev) => new Set([...prev, ...ids])),
  };

  if (error) return <QueryError error={error} title={t('library.seriesDetails.couldNotLoadEpisodes')} />;
  if (seasons.length === 0) return <EmptyState title={t('library.seriesDetails.noSeasonsYet')}>{t('library.seriesDetails.tmdbHasNotListedAny')}</EmptyState>;

  return (
    <>
      {episodes && episodes.length > 0 ? (
        <div className="mk-bulk-toolbar">
          <Button size="sm" variant={sel.selectMode ? 'secondary' : 'ghost'} aria-pressed={sel.selectMode} onClick={() => (sel.selectMode ? sel.clear() : sel.setSelectMode(true))}>
            {sel.selectMode ? t('library.done') : t('bulk.selectEpisodes')}
          </Button>
        </div>
      ) : null}
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
            searchStatus={searchById}
            defaultOpen={season.seasonNumber === latest}
            onInteractive={onInteractive}
            onAddLanguage={onAddLanguage}
            onOpenEpisode={setDrawer}
            select={select}
          />
        ))}
      </Accordion>
      {sel.selectMode || sel.selected.size > 0 ? (
        <EpisodeBulkBar
          series={series}
          episodes={episodes ?? []}
          selected={sel.selected}
          open={sel.selectMode}
          onSelectAll={() => sel.selectAll((episodes ?? []).map((e) => e.id))}
          onClear={sel.clear}
        />
      ) : null}
      <EpisodeDrawer
        series={series}
        episode={drawer}
        file={drawer?.episodeFileId != null ? fileById.get(drawer.episodeFileId) : undefined}
        queued={drawer ? progress.episodes.get(drawer.id) : undefined}
        onClose={() => setDrawer(null)}
        onInteractive={onInteractive}
        onAddLanguage={onAddLanguage}
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
  searchStatus,
  defaultOpen,
  onInteractive,
  onAddLanguage,
  onOpenEpisode,
  select,
}: {
  series: Series;
  season: Season;
  episodes: Episode[] | undefined;
  loadingEpisodes: boolean;
  fileById: Map<number, MediaFile>;
  progress: Map<number, QueueSummaryItem>;
  /** Search status of the series's missing episodes. */
  searchStatus: Map<number, ItemSearchStatus>;
  defaultOpen: boolean;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
  onOpenEpisode: (ep: Episode) => void;
  select?: EpisodeSelect | undefined;
}) {
  const search = useAutomaticSearch();
  const setSeason = useSetSeasonMonitored();
  const stats = season.statistics;
  const label = seasonLabel(season.seasonNumber);
  const counts = countStatuses(episodes ?? [], { seriesMonitored: series.monitored });
  const have = stats?.episodeFileCount ?? 0;
  const want = stats?.episodeCount ?? 0;
  // Missing episodes not already in the queue: when will the scheduled search look for them?
  const waiting = (episodes ?? [])
    .filter((ep) => !progress.has(ep.id))
    .map((ep) => searchStatus.get(ep.id))
    .filter((s): s is ItemSearchStatus => s !== undefined);
  const waitingText = groupSearchText(waiting);

  return (
    <AccordionItem
      title={label}
      defaultOpen={defaultOpen}
      meta={seasonSummary(season, episodes)}
      aside={
        <div className="mk-season-aside">
          <MonitorSwitch
            monitored={season.monitored}
            label={t('common.monitorTitle', { monitored: season.monitored, title: label })}
            onChange={(m) => setSeason.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber, monitored: m })}
          />
          <span className="mk-muted mk-hide-mobile" style={{ fontSize: 13 }}>
            {season.monitored ? t('status.monitored') : t('status.unmonitored')}
          </span>
          <Meter
            value={want > 0 ? (have / want) * 100 : 0}
            tone={counts.wanted > 0 ? 'warn' : 'default'}
            label={t('library.seriesDetails.labelProgress', { label })}
            valueText={`${have}/${want}${stats ? ` · ${formatBytes(stats.sizeOnDisk)}` : ''}`}
          />
          <span className="mk-spacer" />
          {select?.active && episodes?.length ? (
            <button type="button" className="mk-action-link" onClick={() => select.selectMany(episodes.map((e) => e.id))}>
              {t('bulk.selectSeason')}
            </button>
          ) : null}
          <button
            type="button"
            className="mk-action-link"
            disabled={search.isPending && search.variables.seasonNumber === season.seasonNumber}
            onClick={() => search.mutate({ seriesId: series.id, seasonNumber: season.seasonNumber })}
          >
            {t('library.seriesDetails.searchSeason')}
          </button>
          <button
            type="button"
            className="mk-action-link mk-hide-mobile"
            aria-label={t('library.seriesDetails.interactiveSearchLabel', { label })}
            onClick={() => onInteractive({ target: { seriesId: series.id, seasonNumber: season.seasonNumber }, title: `${series.title} ${label}` })}
          >
            {t('library.seriesDetails.interactive')}
          </button>
          <button
            type="button"
            className="mk-action-link mk-hide-mobile"
            aria-label={t('features.additionalLanguages.addAdditionalTo', { title: label })}
            onClick={() => onAddLanguage({ targets: [{ seriesId: series.id, seasonNumber: season.seasonNumber }], title: `${series.title} ${label}` })}
          >
            {t('features.additionalLanguages.addLanguage')}
          </button>
        </div>
      }
    >
      {loadingEpisodes ? (
        <Loading />
      ) : !episodes || episodes.length === 0 ? (
        <EmptyState title={t('library.seriesDetails.noEpisodesYet')} />
      ) : (
        <>
        {waitingText ? (
          <p className="mk-muted" style={{ fontSize: 13, margin: '0 0 8px' }} data-testid="season-search">
            {waitingText}
          </p>
        ) : null}
        <div className="mk-eps" role="table" aria-label={t('library.seriesDetails.labelEpisodes', { label })}>
          <div className="mk-eps__head" role="row">
            <span role="columnheader">
              <span className="al-sr-only">{t('status.monitored')}</span>
            </span>
            <span role="columnheader">#</span>
            <span role="columnheader">{t('common.title')}</span>
            <span role="columnheader">{t('library.seriesDetails.aired')}</span>
            <span role="columnheader">{t('common.status')}</span>
            <span role="columnheader">{t('common.size')}</span>
            <span role="columnheader">
              <span className="al-sr-only">{t('common.actions')}</span>
            </span>
          </div>
          {episodes.map((ep) => (
            <EpisodeRow
              key={ep.id}
              series={series}
              episode={ep}
              file={ep.episodeFileId != null ? fileById.get(ep.episodeFileId) : undefined}
              queued={progress.get(ep.id)}
              search={searchStatus.get(ep.id)}
              onOpen={() => onOpenEpisode(ep)}
              onInteractive={onInteractive}
              onAddLanguage={onAddLanguage}
              selecting={select?.active ?? false}
              checked={select?.selected.has(ep.id) ?? false}
              onToggle={() => select?.toggle(ep.id)}
            />
          ))}
        </div>
        </>
      )}
    </AccordionItem>
  );
}

function EpisodeRow({
  series,
  episode: ep,
  file,
  queued,
  search: searchStatus,
  onOpen,
  onInteractive,
  onAddLanguage,
  selecting = false,
  checked = false,
  onToggle,
}: {
  series: Series;
  episode: Episode;
  file: MediaFile | undefined;
  /** The episode's download in the queue, if any. */
  queued: QueueSummaryItem | undefined;
  /** Last / next search (missing episodes only): the status chip's tooltip. */
  search: ItemSearchStatus | undefined;
  onOpen: () => void;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
  /** Select mode: the monitor cell holds the row's checkbox. */
  selecting?: boolean | undefined;
  checked?: boolean | undefined;
  onToggle?: (() => void) | undefined;
}) {
  const search = useAutomaticSearch();
  const setEpisode = useSetEpisodeMonitored();
  const delFile = useDeleteMediaFile();
  const isMobile = useIsMobile();
  const code = episodeCode(ep.seasonNumber, ep.episodeNumber);
  const runSearch = () => search.mutate({ episodeIds: [ep.id] });
  const row = (
    <div
      className="mk-ep"
      role="row"
      data-live={queued?.trackedState === 'downloading' || undefined}
      data-select={selecting || undefined}
      data-selected={(selecting && checked) || undefined}
      aria-selected={selecting ? checked : undefined}
    >
      <span className="mk-ep__monitor" role="cell">
        {selecting ? (
          <Checkbox aria-label={t('bulk.selectEpisode', { code })} checked={checked} onChange={() => onToggle?.()} />
        ) : (
          <MonitorSwitch
            monitored={ep.monitored}
            label={t('library.seriesDetails.valueEpisodeEpisodenumber', { value: ep.monitored ? 'Unmonitor' : 'Monitor', episodeNumber: ep.episodeNumber })}
            onChange={(m) => setEpisode.mutate({ seriesId: series.id, episodeId: ep.id, monitored: m })}
          />
        )}
      </span>
      <span className="mk-ep__num" role="cell">
        {String(ep.episodeNumber).padStart(2, '0')}
      </span>
      <span role="cell" style={{ minWidth: 0, display: 'flex' }}>
        <button type="button" className="mk-ep__title" onClick={onOpen} title={ep.title || t('common.tba')}>
          {ep.title || t('common.tba')}
        </button>
      </span>
      <span className="mk-ep__date al-num" role="cell">
        {formatDate(ep.airDateUtc ?? ep.airDate)}
      </span>
      <span role="cell" title={queued ? undefined : searchStatusTitle(searchStatus)}>
        <EpisodeChip episode={ep} seriesMonitored={series.monitored} queued={queued} />
      </span>
      <span className="mk-ep__size" role="cell">
        {file ? formatBytes(file.sizeBytes) : '—'}
      </span>
      <span className="mk-ep__actions" role="cell">
        <button type="button" className="mk-action-link" aria-label={t('library.seriesDetails.searchCode', { code })} disabled={search.isPending} onClick={runSearch}>
          {t('common.search')}
        </button>
        <button
          type="button"
          className="mk-action-link"
          aria-label={t('library.seriesDetails.interactiveSearchCode', { code })}
          onClick={() => onInteractive({ target: { episodeId: ep.id }, title: `${series.title} ${code}`, release: episodeReleaseState(ep) })}
        >
          {t('library.seriesDetails.interactive')}
        </button>
        <button
          type="button"
          className="mk-action-link mk-hide-mobile"
          aria-label={t('features.additionalLanguages.addAdditionalTo', { title: code })}
          onClick={() => onAddLanguage({ targets: [{ seriesId: series.id, episodeIds: [ep.id] }], title: `${series.title} ${code}` })}
        >
          {t('features.additionalLanguages.addLanguage')}
        </button>
      </span>
    </div>
  );
  if (!isMobile || selecting) return row;
  return (
    <SwipeRow
      onSearch={runSearch}
      searchLabel={t('library.seriesDetails.searchCode', { code })}
      onDelete={file ? () => delFile.mutate({ fileId: file.id, mediaType: 'series', ownerId: series.id }) : undefined}
      deleteLabel={t('library.seriesDetails.deleteCodeFile', { code })}
    >
      {row}
    </SwipeRow>
  );
}

/** Episode selection shared by the season panels (one bulk bar for the whole series). */
interface EpisodeSelect {
  active: boolean;
  selected: ReadonlySet<number>;
  toggle: (id: number) => void;
  selectMany: (ids: number[]) => void;
}

/** Bulk bar for selected episodes: searches, monitoring, rename and file deletion. */
function EpisodeBulkBar({
  series,
  episodes,
  selected,
  open,
  onSelectAll,
  onClear,
}: {
  series: Series;
  episodes: readonly Episode[];
  selected: ReadonlySet<number>;
  open: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const search = useBulkSearch();
  const monitor = useSetEpisodesMonitored();
  const delFiles = useDeleteMediaFiles();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ids = [...selected];
  const fileIds = [...new Set(episodes.filter((e) => selected.has(e.id) && e.episodeFileId != null).map((e) => e.episodeFileId as number))];
  const subject = t('bulk.episodeCount', { count: ids.length });
  const runSearch = (mode: 'all' | 'missing' | 'upgrade') => search.mutate({ mode, episodeIds: ids });
  const actions: BulkAction[] = [
    { id: 'search', label: t('common.search'), loading: search.isPending, onSelect: () => runSearch('all') },
    { id: 'search-missing', label: t('bulk.searchMissing'), disabled: search.isPending, onSelect: () => runSearch('missing') },
    { id: 'search-upgrades', label: t('bulk.searchUpgrades'), disabled: search.isPending, onSelect: () => runSearch('upgrade') },
    { id: 'monitor', label: t('common.monitor'), disabled: monitor.isPending, onSelect: () => monitor.mutate({ seriesId: series.id, episodeIds: ids, monitored: true }) },
    { id: 'unmonitor', label: t('common.unmonitor'), disabled: monitor.isPending, onSelect: () => monitor.mutate({ seriesId: series.id, episodeIds: ids, monitored: false }) },
    { id: 'rename', label: t('bulk.renameFiles'), disabled: fileIds.length === 0, onSelect: () => setRenaming(true) },
    { id: 'delete', label: t('bulk.deleteFiles'), danger: true, disabled: fileIds.length === 0, onSelect: () => setDeleting(true) },
  ];
  return (
    <BulkBar count={ids.length} total={episodes.length} onSelectAll={onSelectAll} open={open} actions={actions} onClear={onClear}>
      <BulkRenameDialog target={renaming ? { seriesIds: [series.id] } : null} fileIds={new Set(fileIds)} subject={`${series.title} · ${subject}`} onClose={() => setRenaming(false)} />
      <ConfirmModal
        open={deleting}
        title={t('bulk.deleteFilesTitle', { count: fileIds.length })}
        confirmLabel={t('bulk.deleteFiles')}
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          await delFiles.mutateAsync({ fileIds, mediaType: 'series', ownerId: series.id });
          setDeleting(false);
          onClear();
        }}
      >
        <p style={{ margin: 0 }}>{t('bulk.deleteFilesBody', { count: fileIds.length, title: series.title })}</p>
      </ConfirmModal>
    </BulkBar>
  );
}

function EpisodeDrawer({
  series,
  episode,
  file,
  queued,
  onClose,
  onInteractive,
  onAddLanguage,
}: {
  series: Series;
  episode: Episode | null;
  file: MediaFile | undefined;
  queued: QueueSummaryItem | undefined;
  onClose: () => void;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
}) {
  const search = useAutomaticSearch();
  const history = useMediaHistory({ episodeId: episode?.id ?? 0 }, episode !== null);
  const searchStatus = useSearchStatus('episode', episode ? [episode.id] : []);
  if (!episode) return null;
  const code = episodeCode(episode.seasonNumber, episode.episodeNumber);
  return (
    <Drawer
      open
      onClose={onClose}
      title={`${code} · ${episode.title || 'TBA'}`}
      footer={
        <>
          <Button onClick={() => onAddLanguage({ targets: [{ seriesId: series.id, episodeIds: [episode.id] }], title: `${series.title} ${code}` })}>{t('features.additionalLanguages.addAdditional')}</Button>
          <Button onClick={() => onInteractive({ target: { episodeId: episode.id }, title: `${series.title} ${code}`, release: episodeReleaseState(episode) })}>{t('library.seriesDetails.interactiveSearch')}</Button>
          <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ episodeIds: [episode.id] })}>
            {t('library.seriesDetails.searchEpisode')}
          </Button>
        </>
      }
    >
      <BackdropFrame className="mk-drawer-still" src={imageUrl(series.images, 'fanart')} title={`${series.title} ${code}`} />
      <div className="mk-row" style={{ marginBottom: 12 }}>
        <EpisodeChip episode={episode} seriesMonitored={series.monitored} queued={queued} />
        <StatusChip status={episode.monitored ? 'monitored' : 'unmonitored'} />
      </div>
      <section className="mk-drawer-section" aria-label={t('components.media.pipeline.automaticSearch')}>
        <div className="al-label">{t('components.media.pipeline.automaticSearch')}</div>
        {searchStatus.data?.[0] ? <SearchStatusLines status={searchStatus.data[0]} /> : <span className="mk-muted">—</span>}
      </section>
      <p className="mk-hero__overview" style={{ fontSize: 14 }}>
        {episode.overview || t('common.noOverviewAvailable')}
      </p>
      <KeyValue
        items={[
          { label: t('library.seriesDetails.aired'), value: formatDate(episode.airDateUtc ?? episode.airDate, { dateStyle: 'medium', timeStyle: episode.airDateUtc ? 'short' : undefined }) },
          { label: t('common.runtime'), value: episode.runtimeMinutes ? `${episode.runtimeMinutes} min` : '—' },
          ...(episode.absoluteEpisodeNumber ? [{ label: t('library.seriesDetails.absolute'), value: String(episode.absoluteEpisodeNumber) }] : []),
        ]}
      />
      <section className="mk-drawer-section" aria-label={t('common.file')}>
        <div className="al-label">{t('common.file')}</div>
        {file ? (
          <KeyValue
            items={[
              { label: t('common.path'), value: file.relativePath },
              { label: t('common.size'), value: formatBytes(file.sizeBytes) },
              { label: t('common.quality'), value: qualityName(file.quality) ?? '—' },
              { label: t('library.seriesDetails.video'), value: [file.mediaInfo?.videoCodec, file.mediaInfo?.resolution, file.mediaInfo?.videoDynamicRange].filter(Boolean).join(' · ') || '—' },
              { label: t('library.seriesDetails.audio'), value: [file.mediaInfo?.audioCodec, file.mediaInfo?.audioChannels].filter(Boolean).join(' · ') || '—' },
              { label: t('common.languages'), value: languageNames(file.languages) },
              { label: t('common.group'), value: file.releaseGroup ?? '—' },
            ]}
          />
        ) : (
          <span className="mk-muted">{t('library.seriesDetails.noFileOnDisk')}</span>
        )}
      </section>
      <EpisodeVersionFiles files={episode.files} />
      <section className="mk-drawer-section" aria-label={t('common.history')}>
        <div className="al-label">{t('common.history')}</div>
        {history.isPending ? (
          <Loading lines={2} />
        ) : history.isError || !history.data?.records.length ? (
          <span className="mk-muted">{t('library.seriesDetails.noHistoryForThisEpisode')}</span>
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
      <section className="mk-drawer-section" aria-label={t('library.decisions.tab')}>
        <div className="al-label">{t('library.decisions.tab')}</div>
        <DecisionsPanel key={episode.id} scope={{ episodeId: episode.id }} pageSize={5} />
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
  const versions = useVersionsDraft(series.versions);
  const roots = (rootFolders.data ?? []).filter((r) => r.mediaType === 'series');

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.seriesDetails.editTitle', { title: series.title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-series-form" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
    <form
      id="edit-series-form"
      className="mk-stack-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!versions.valid) return;
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
              ...versions.patch,
              ...(path.trim() && path !== series.path ? { path: path.trim() } : {}),
            },
          },
          { onSuccess: onClose },
        );
      }}
    >
      <FormRow label={t('status.monitored')} htmlFor="edit-monitored" captionInline caption={t('library.seriesDetails.searchForMissingEpisodesOf')}>
        <Toggle id="edit-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
      </FormRow>
      <FormRow label={t('library.seriesDetails.monitorNewSeasons')} htmlFor="edit-new-seasons">
        <Select id="edit-new-seasons" value={monitorNewItems} onChange={(e) => setMonitorNewItems(e.target.value as NewItemMonitor)}>
          <option value="all">{t('library.seriesDetails.allNewSeasons')}</option>
          <option value="none">{t('common.none')}</option>
        </Select>
      </FormRow>
      <FormRow label={t('common.qualityProfile')} htmlFor="edit-profile">
        <Select id="edit-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
          {(profiles.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormRow>
      <LanguageProfileSelect value={languageProfileId} onChange={setLanguageProfileId} />
      <FormRow label={t('common.seriesType')} htmlFor="edit-type">
        <Select id="edit-type" value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType)}>
          {Object.entries(SERIES_TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow label={t('common.seasonFolders')} htmlFor="edit-season-folder" captionInline caption={t('library.seriesDetails.putEachSeasonInIts')}>
        <Toggle id="edit-season-folder" checked={seasonFolder} onChange={(e) => setSeasonFolder(e.target.checked)} />
      </FormRow>
      <FormRow label={t('common.path')} htmlFor="edit-path" caption={roots.length ? t('library.seriesDetails.rootFoldersMap', { map: roots.map((r) => r.path).join(', ') }) : undefined} captionMono>
        <Input id="edit-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
      </FormRow>
      <FormRow label={t('common.tags')}>
        <TagPicker value={tags} onChange={setTags} />
      </FormRow>
      <VersionsEditor state={versions} profiles={profiles.data ?? []} defaultProfileId={qualityProfileId} idPrefix="edit-series" />
    </form>
    </Modal>
  );
}
