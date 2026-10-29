import { useEffect, useId, useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { MetadataCollection, MetadataCollectionPart, MetadataSearchResult, MinimumAvailability } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { isMissingTmdbKey, metadataApi } from '../../api/metadata.js';
import { BackdropFrame, Button, Checkbox, Chip, EmptyState, ErrorBlock, FormRow, Meter, Modal, PageHeader, Pane, Poster, PosterCard, Select, Skeleton, Toggle } from '../../arclight/index.js';
import { BulkBar, type BulkAction } from '../../components/media/bulk-bar.js';
import { useBulkSearch, useBulkSelection } from '../../hooks/bulk.js';
import { useToast } from '../../components/toast.js';
import { useAddMovie, useBulkUpdateMovies, useMovieList, useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import { libraryKeys } from '../../hooks/library-keys.js';
import { AddDialog, loadDefaults, saveDefaults } from './add-dialog.js';
import { initialAddForm, MINIMUM_AVAILABILITY_LABELS } from './add-form.js';
import { collectionCounts, missingParts, partAsSearchResult, partStates } from './collection-model.js';
import { groupCollections, movieRow } from './library-filters.js';
import '../../components/media/media-kit.css';
import './library.css';
import { t } from '../../i18n/index.js';

const collectionKey = (tmdbId: number) => [...libraryKeys.library.all, 'collection', tmdbId] as const;
const collectionQuery = (tmdbId: number) => ({
  queryKey: collectionKey(tmdbId),
  queryFn: () => metadataApi.collection(tmdbId),
  staleTime: 60 * 60_000,
  retry: (n: number, err: unknown) => !isMissingTmdbKey(err) && n < 1,
});

/** "3/5" with a meter; owned = movies with a file. */
function CollectionMeter({ title, owned, total }: { title: string; owned: number; total: number }) {
  return (
    <Meter
      value={total > 0 ? (owned / total) * 100 : 0}
      tone={owned < total ? 'warn' : 'default'}
      label={`${title}: ${owned} of ${total} on disk`}
      valueText={`${owned}/${total}`}
    />
  );
}

/** Library → Collections (/library/collections): one card per TMDB collection in the library. */
export function CollectionsPage() {
  const movies = useMovieList();
  const navigate = useNavigate();
  const groups = useMemo(() => groupCollections((movies.data ?? []).map(movieRow)), [movies.data]);
  const details = useQueries({ queries: groups.map((g) => collectionQuery(g.tmdbId)) });
  const sel = useBulkSelection();
  useEffect(() => {
    document.title = t('library.collections.collectionsArclight');
  }, []);
  // The bulk bar acts on the library movies of the selected collections.
  const movieIds = useMemo(() => groups.filter((g) => sel.selected.has(g.tmdbId)).flatMap((g) => g.movies.map((m) => m.id)), [groups, sel.selected]);

  return (
    <>
      <PageHeader
        index="02"
        title={t('common.collections')}
        subtitle={movies.data ? t('library.collections.collections', { groupsCount: groups.length }) : undefined}
        actions={
          groups.length > 0 ? (
            <Button variant={sel.selectMode ? 'secondary' : 'ghost'} aria-pressed={sel.selectMode} onClick={() => (sel.selectMode ? sel.clear() : sel.setSelectMode(true))}>
              {sel.selectMode ? t('library.done') : t('common.select')}
            </Button>
          ) : undefined
        }
      />
      {movies.isPending ? (
        <Skeleton lines={4} />
      ) : movies.isError ? (
        <ErrorBlock title={t('library.collections.couldntLoadMovies')} onRetry={() => void movies.refetch()}>
          {errorMessage(movies.error)}
        </ErrorBlock>
      ) : groups.length === 0 ? (
        <EmptyState title={t('library.collections.noCollectionsYet')}>{t('library.collections.moviesThatBelongToA')}</EmptyState>
      ) : (
        <div className="mk-poster-grid" data-testid="collection-grid">
          {groups.map((g, i) => {
            const detail = details[i]?.data;
            const total = detail ? detail.parts.filter((p) => p.releaseDate).length || detail.parts.length : g.movies.length;
            return (
              <div key={g.tmdbId} className="lib-collection-card">
                <PosterCard
                  src={detail?.images.poster ?? g.movies[0]?.posterUrl}
                  title={detail?.name ?? g.title}
                  count={`${g.owned}/${total}`}
                  countTone={g.owned < total ? 'warn' : 'default'}
                  meta={<CollectionMeter title={g.title} owned={g.owned} total={total} />}
                  selected={sel.selectMode && sel.selected.has(g.tmdbId)}
                  overlay={
                    sel.selectMode ? (
                      <Checkbox
                        aria-label={t('library.selectTitle', { title: detail?.name ?? g.title })}
                        checked={sel.selected.has(g.tmdbId)}
                        onChange={() => sel.toggle(g.tmdbId)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : undefined
                  }
                  onClick={() => (sel.selectMode ? sel.toggle(g.tmdbId) : void navigate({ to: '/library/collections/$tmdbId', params: { tmdbId: String(g.tmdbId) } }))}
                />
              </div>
            );
          })}
        </div>
      )}
      {sel.selectMode || sel.selected.size > 0 ? (
        <CollectionsBulkBar
          collections={sel.selected.size}
          movieIds={movieIds}
          total={groups.length}
          open={sel.selectMode}
          onSelectAll={() => sel.selectAll(groups.map((g) => g.tmdbId))}
          onClear={sel.clear}
        />
      ) : null}
    </>
  );
}

/** Bulk bar of the Collections page: searches and monitoring over the selected collections' movies. */
function CollectionsBulkBar({
  collections,
  movieIds,
  total,
  open,
  onSelectAll,
  onClear,
}: {
  collections: number;
  movieIds: number[];
  total: number;
  open: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const search = useBulkSearch();
  const update = useBulkUpdateMovies();
  const toast = useToast();
  const none = movieIds.length === 0;
  const apply = (patch: { monitored?: boolean; refresh?: boolean }, done: string) =>
    update.mutate({ ids: movieIds, ...patch }, { onSuccess: () => toast.push({ tone: 'ok', title: done, durationMs: 4_000 }) });
  const actions: BulkAction[] = [
    { id: 'search-missing', label: t('bulk.searchMissing'), disabled: none || search.isPending, loading: search.isPending, onSelect: () => search.mutate({ mode: 'missing', movieIds }) },
    { id: 'search-upgrades', label: t('bulk.searchUpgrades'), disabled: none || search.isPending, onSelect: () => search.mutate({ mode: 'upgrade', movieIds }) },
    { id: 'monitor', label: t('common.monitor'), disabled: none || update.isPending, onSelect: () => apply({ monitored: true }, t('bulk.toast.updated', { count: movieIds.length })) },
    { id: 'unmonitor', label: t('common.unmonitor'), disabled: none || update.isPending, onSelect: () => apply({ monitored: false }, t('bulk.toast.updated', { count: movieIds.length })) },
    { id: 'refresh', label: t('common.refresh'), disabled: none || update.isPending, onSelect: () => apply({ refresh: true }, t('bulk.toast.refreshQueued', { count: movieIds.length })) },
  ];
  return <BulkBar count={collections} total={total} onSelectAll={onSelectAll} open={open} actions={actions} onClear={onClear} />;
}

const route = getRouteApi('/library/collections/$tmdbId');

interface MonitorProgress {
  done: number;
  total: number;
  failed: string[];
}

/** "Monitor collection": add every missing part with the add dialog's remembered defaults. */
function MonitorCollectionDialog({ collection, parts, onClose }: { collection: MetadataCollection; parts: MetadataCollectionPart[]; onClose: () => void }) {
  const roots = useRootFolders();
  const profiles = useQualityProfiles();
  const add = useAddMovie();
  const toast = useToast();
  const ids = { root: useId(), profile: useId(), avail: useId(), search: useId() };
  const defaults = useMemo(() => initialAddForm('movie', roots.data ?? [], profiles.data ?? [], loadDefaults('movie')), [roots.data, profiles.data]);
  const [rootFolderPath, setRoot] = useState('');
  const [qualityProfileId, setProfile] = useState<number | null>(null);
  const [minimumAvailability, setAvailability] = useState<MinimumAvailability>('released');
  const [searchOnAdd, setSearch] = useState(true);
  const [progress, setProgress] = useState<MonitorProgress | null>(null);
  const root = rootFolderPath || defaults.rootFolderPath;
  const profile = qualityProfileId ?? defaults.qualityProfileId;
  const movieRoots = (roots.data ?? []).filter((r) => r.mediaType === 'movie');

  const run = async () => {
    if (!root || profile === null) return;
    saveDefaults('movie', { rootFolderPath: root, qualityProfileId: profile });
    const state: MonitorProgress = { done: 0, total: parts.length, failed: [] };
    setProgress({ ...state });
    for (const part of parts) {
      try {
        await add.mutateAsync({ tmdbId: part.tmdbId, rootFolderPath: root, qualityProfileId: profile, monitored: true, minimumAvailability, tags: [], searchOnAdd });
      } catch (err) {
        state.failed.push(`${part.title}: ${errorMessage(err)}`);
      }
      state.done += 1;
      setProgress({ ...state });
    }
    const added = state.total - state.failed.length;
    toast.push({ tone: state.failed.length ? 'warning' : 'ok', title: t('library.collections.addedAddedOfTotalMovies', { added, total: state.total, name: collection.name }) });
    if (state.failed.length === 0) onClose();
  };

  const busy = progress !== null && progress.done < progress.total;
  return (
    <Modal
      open
      size={560}
      onClose={busy ? () => undefined : onClose}
      title={t('library.collections.monitorName', { name: collection.name })}
      footer={
        <div className="lib-form-foot">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!root || profile === null || parts.length === 0} onClick={() => void run()}>
            {t('library.collections.addMovies', { partsCount: parts.length })}
          </Button>
        </div>
      }
    >
      <div className="mk-stack-sm">
        <p className="al-caption" style={{ margin: 0 }}>
          {t('library.collections.addsTheMissingMoviesAs', { map: parts.map((p) => p.title).join(', ') })}
        </p>
        <FormRow label={t('common.rootFolder')} htmlFor={ids.root} caption={movieRoots.length === 0 ? t('library.collections.addAMovieRootFolder') : undefined}>
          <Select id={ids.root} value={root} onChange={(e) => setRoot(e.currentTarget.value)} options={movieRoots.map((r) => ({ value: r.path, label: r.path }))} />
        </FormRow>
        <FormRow label={t('common.qualityProfile')} htmlFor={ids.profile}>
          <Select id={ids.profile} value={profile?.toString() ?? ''} onChange={(e) => setProfile(Number(e.currentTarget.value))} options={(profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))} />
        </FormRow>
        <FormRow label={t('common.minimumAvailability')} htmlFor={ids.avail}>
          <Select
            id={ids.avail}
            value={minimumAvailability}
            onChange={(e) => setAvailability(e.currentTarget.value as MinimumAvailability)}
            options={Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </FormRow>
        <FormRow label={t('common.searchOnAdd')} htmlFor={ids.search} captionInline caption={t('library.collections.searchForEachMovieRight')}>
          <Toggle id={ids.search} checked={searchOnAdd} onChange={(e) => setSearch(e.currentTarget.checked)} />
        </FormRow>
        {progress ? (
          <div role="status">
            <Meter value={(progress.done / Math.max(1, progress.total)) * 100} live={busy} label={t('library.collections.addingMovies')} valueText={`${progress.done}/${progress.total}`} />
            {progress.failed.map((f) => (
              <p key={f} className="al-field__error" style={{ margin: '6px 0 0' }}>
                {f}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** Library → Collections → one collection: TMDB parts, owned/missing, monitor action. */
export function CollectionDetailPage() {
  const { tmdbId } = route.useParams();
  const id = Number(tmdbId);
  const collection = useQuery(collectionQuery(id));
  const movies = useMovieList();
  const roots = useRootFolders();
  const profiles = useQualityProfiles();
  const navigate = useNavigate();
  const [adding, setAdding] = useState<MetadataSearchResult | null>(null);
  const [monitoring, setMonitoring] = useState(false);

  const states = useMemo(() => (collection.data ? partStates(collection.data, movies.data ?? []) : []), [collection.data, movies.data]);
  const counts = collectionCounts(states);
  const missing = missingParts(states);
  useEffect(() => {
    document.title = t('library.collections.valueArclight', { value: collection.data?.name ?? 'Collection' });
  }, [collection.data?.name]);

  if (collection.isPending) return <Skeleton lines={6} />;
  if (collection.isError) {
    return (
      <ErrorBlock title={t('library.collections.couldntLoadTheCollection')} onRetry={() => void collection.refetch()}>
        {isMissingTmdbKey(collection.error) ? t('library.collections.setATmdbApiKey') : errorMessage(collection.error)}
      </ErrorBlock>
    );
  }
  const c = collection.data;
  return (
    <>
      <BackdropFrame src={c.images.backdrop} title={c.name} fade />
      <PageHeader
        index="02"
        title={c.name}
        subtitle={t('library.collections.ownedOfTotalOnDisk', { owned: counts.owned, total: counts.total, inLibrary: counts.inLibrary })}
        actions={
          <Button variant="primary" disabled={missing.length === 0} onClick={() => setMonitoring(true)}>
            {missing.length === 0 ? t('library.collections.collectionMonitored') : t('library.collections.monitorCollectionMissingcountMissing', { missingCount: missing.length })}
          </Button>
        }
      />
      <div className="mk-stack">
        <Pane flush={false}>
          <div className="lib-add-head">
            <Poster src={c.images.poster} title={c.name} />
            <div style={{ minWidth: 0 }} className="mk-stack-sm">
              <p style={{ margin: 0 }}>{c.overview || t('common.noOverviewAvailable')}</p>
              <div className="lib-collection-meter">
                <CollectionMeter title={c.name} owned={counts.owned} total={counts.total} />
              </div>
            </div>
          </div>
        </Pane>
        <div className="mk-poster-grid" data-testid="collection-parts">
          {states.map(({ part, movie }) => (
            <div key={part.tmdbId} className="lib-collection-card">
              <PosterCard
                src={part.images.poster}
                title={part.title}
                count={part.year ?? 'TBA'}
                meta={
                  movie ? (
                    <Chip tone={movie.hasFile ? 'accent' : 'warn'}>{movie.hasFile ? t('status.downloaded') : movie.monitored ? t('status.missing') : t('status.unmonitored')}</Chip>
                  ) : (
                    <span className="lib-collection-add">
                      <Chip tone="muted">{t('library.collections.notInLibrary')}</Chip>
                      {part.releaseDate ? (
                        <Button size="sm" variant="secondary" onClick={() => setAdding(partAsSearchResult(part))} aria-label={t('library.collections.addTitle', { title: part.title })}>
                          {t('common.add')}
                        </Button>
                      ) : null}
                    </span>
                  )
                }
                {...(movie ? { onClick: () => void navigate({ to: '/library/movie/$id', params: { id: String(movie.id) } }) } : {})}
              />
            </div>
          ))}
        </div>
      </div>
      <AddDialog result={adding} onClose={() => setAdding(null)} rootFolders={roots.data ?? []} profiles={profiles.data ?? []} />
      {monitoring ? <MonitorCollectionDialog collection={c} parts={missing} onClose={() => setMonitoring(false)} /> : null}
    </>
  );
}
