import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { AdditionalLanguageTarget, Episode, MediaFile, NewItemMonitor, Season, Series, SeriesType } from '@arclight/shared';
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
import { CrossSeedSearchButton } from '../../features/cross-seed/cross-seed-search.js';
import { EpisodeVersionFiles, VersionsEditor, useVersionsDraft } from './versions/versions-editor.js';
import { AddAdditionalDialog } from '../../features/additional-languages/add-additional-dialog.js';
import { ItemLanguageChips } from '../../features/additional-languages/item-language-chips.js';
import { t } from '../../i18n/index.js';

const route = getRouteApi('/library/series/$id');

/** Target of the "Add additional…" dialog opened from the series page. */
export interface AddLanguageState {
  targets: AdditionalLanguageTarget[];
  title: string;
}

export interface InteractiveState {
  target: ReleaseSearchTarget;
  title: string;
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
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <span className="al-chip al-chip--nodot al-chip--lg">{SERIES_TYPE_LABELS[s.seriesType]}</span>
            <TagChips ids={s.tags} tags={tags.data} />
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
          { id: 'history', label: t('common.history'), content: <HistoryTable scope={{ seriesId: s.id }} /> },
          { id: 'decisions', label: t('library.decisions.tab'), content: <DecisionsPanel scope={{ seriesId: s.id }} /> },
          { id: 'search', label: t('common.search'), content: <SearchTab target={{ seriesId: s.id }} /> },
          { id: 'scenemapping', label: t('library.sceneMapping.tab'), content: <SceneMappingPanel seriesId={s.id} /> },
          { id: 'subtitles', label: t('common.subtitles'), content: <SubtitlesTab scope={{ seriesId: s.id }} episodes={episodes.data} /> },
          { id: 'requests', label: t('common.requests'), content: <RequestsTable kind="tv" tmdbId={s.tmdbId} /> },
        ]}
      />

      <AddAdditionalDialog open={addLanguage !== null} onClose={() => setAddLanguage(null)} targets={addLanguage?.targets ?? []} title={addLanguage?.title ?? ''} />
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
  const seasons = orderSeasons(series.seasons);
  const [drawer, setDrawer] = useState<Episode | null>(null);
  const latest = seasons.find((x) => x.seasonNumber > 0)?.seasonNumber;

  if (error) return <QueryError error={error} title={t('library.seriesDetails.couldNotLoadEpisodes')} />;
  if (seasons.length === 0) return <EmptyState title={t('library.seriesDetails.noSeasonsYet')}>{t('library.seriesDetails.tmdbHasNotListedAny')}</EmptyState>;

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
            onAddLanguage={onAddLanguage}
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
  defaultOpen,
  onInteractive,
  onAddLanguage,
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
  onAddLanguage: (s: AddLanguageState) => void;
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
              downloading={progress.get(ep.id)}
              onOpen={() => onOpenEpisode(ep)}
              onInteractive={onInteractive}
              onAddLanguage={onAddLanguage}
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
  onAddLanguage,
}: {
  series: Series;
  episode: Episode;
  file: MediaFile | undefined;
  downloading: number | undefined;
  onOpen: () => void;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
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
          label={t('library.seriesDetails.valueEpisodeEpisodenumber', { value: ep.monitored ? 'Unmonitor' : 'Monitor', episodeNumber: ep.episodeNumber })}
          onChange={(m) => setEpisode.mutate({ seriesId: series.id, episodeId: ep.id, monitored: m })}
        />
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
      <span role="cell">
        <EpisodeChip episode={ep} seriesMonitored={series.monitored} downloading={downloading} />
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
          onClick={() => onInteractive({ target: { episodeId: ep.id }, title: `${series.title} ${code}` })}
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
  if (!isMobile) return row;
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

function EpisodeDrawer({
  series,
  episode,
  file,
  downloading,
  onClose,
  onInteractive,
  onAddLanguage,
}: {
  series: Series;
  episode: Episode | null;
  file: MediaFile | undefined;
  downloading: number | undefined;
  onClose: () => void;
  onInteractive: (s: InteractiveState) => void;
  onAddLanguage: (s: AddLanguageState) => void;
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
          <Button onClick={() => onAddLanguage({ targets: [{ seriesId: series.id, episodeIds: [episode.id] }], title: `${series.title} ${code}` })}>{t('features.additionalLanguages.addAdditional')}</Button>
          <Button onClick={() => onInteractive({ target: { episodeId: episode.id }, title: `${series.title} ${code}` })}>{t('library.seriesDetails.interactiveSearch')}</Button>
          <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ episodeIds: [episode.id] })}>
            {t('library.seriesDetails.searchEpisode')}
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
              { label: t('common.languages'), value: file.languages.join(', ') || '—' },
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
