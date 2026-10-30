import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { MinimumAvailability, Movie } from '@arclight/shared';
import { Button, Chip, FormRow, Input, KeyValue, Modal, QualityTag, Select, StatusChip, Tabs, Toggle, buttonClass } from '../../arclight/index.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { formatBytes, imageUrl } from '../../components/media/format.js';
import { FoundInLists } from '../../components/media/found-in-lists.js';
import { Loading, MonitorSwitch, QueryError, movieChip, qualityName } from '../../components/media/media-kit.js';
import { AutoTagChips } from '../../components/media/auto-tag-chips.js';
import { QueueStateChip, SearchStatusLines } from '../../components/media/pipeline-status.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useSearchStatus } from '../../hooks/search-status.js';
import {
  useAutomaticSearch,
  useDeleteMovies,
  useMovie,
  useMovieFiles,
  useQualityProfiles,
  useSetMovieMonitored,
  useTags,
  useUpdateMovie,
} from '../../hooks/library.js';
import { LanguageProfileSelect } from '../subtitles/language-profile-select.js';
import { SubtitlesTab } from '../subtitles/subtitles-tab.js';
import { MINIMUM_AVAILABILITY_LABELS } from './add-form.js';
import { DetailsHero, HistoryTable, LibraryCrumb, RefreshButtons, RequestsTable, useQueueProgress } from './details-kit.js';
import { DecisionsPanel } from './decisions/decisions-panel.js';
import { InteractiveSearchModal } from './interactive-search.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';
import { ItemHealthPanel, useCanSeeHealth } from './item-health.js';
import { CrossSeedSearchButton } from '../../features/cross-seed/cross-seed-search.js';
import { SearchTab } from './series-details.js';
import { VersionsEditor, useVersionsDraft } from './versions/versions-editor.js';
import { AddAdditionalDialog } from '../../features/additional-languages/add-additional-dialog.js';
import { ItemLanguageChips } from '../../features/additional-languages/item-language-chips.js';
import { movieReleaseState } from '../../components/media/release-state.js';
import { t } from '../../i18n/index.js';
import { usePaletteContext } from '../../features/command-palette/registry.js';

const route = getRouteApi('/library/movie/$id');

/** One-word file state for the header chip, in the kit vocabulary. */
export function movieFileState(m: Pick<Movie, 'hasFile' | 'monitored' | 'isAvailable'>): { label: string; tone: 'ok' | 'error' | 'warning' | 'info' } {
  if (m.hasFile) return { label: t('status.downloaded'), tone: 'ok' };
  if (!m.isAvailable) return { label: t('status.unaired'), tone: 'info' };
  return m.monitored ? { label: t('status.missing'), tone: 'error' } : { label: t('status.unmonitored'), tone: 'warning' };
}

/** Availability chip: is the movie obtainable under its minimum availability? */
export function availabilityChip(m: Pick<Movie, 'isAvailable' | 'minimumAvailability'>): { label: string; tone: 'accent' | 'neutral' } {
  return m.isAvailable ? { label: t('common.available'), tone: 'accent' } : { label: t('library.movieDetails.notAvailableUntilValue', { value: MINIMUM_AVAILABILITY_LABELS[m.minimumAvailability].toLowerCase() }), tone: 'neutral' };
}

/** "In cinemas 2024-03-01 · Digital 2024-04-16 · Physical —" as label/date pairs. */
export function releaseDates(m: Pick<Movie, 'inCinemas' | 'digitalRelease' | 'physicalRelease'>): Array<[string, string]> {
  return [
    [t('common.inCinemas'), m.inCinemas ? m.inCinemas.slice(0, 10) : '—'],
    [t('library.movieDetails.digital'), m.digitalRelease ? m.digitalRelease.slice(0, 10) : '—'],
    [t('library.movieDetails.physical'), m.physicalRelease ? m.physicalRelease.slice(0, 10) : '—'],
  ];
}

export function MovieDetailsPage() {
  const canSeeHealth = useCanSeeHealth();
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const movie = useMovie(id);
  const files = useMovieFiles(id);
  const profiles = useQualityProfiles();
  const tags = useTags();
  const setMonitored = useSetMovieMonitored();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState('files');
  const del = useDeleteMovies();
  const search = useAutomaticSearch();
  const [interactive, setInteractive] = useState(false);
  const [addingLanguage, setAddingLanguage] = useState(false);
  const navigate = useNavigate();
  const progress = useQueueProgress(useMemo(() => ({ movieId: id }), [id]));
  const searchStatus = useSearchStatus('movie', Number.isInteger(id) && id > 0 ? [id] : []);

  usePaletteContext(movie.data ? { subject: { kind: 'movie', id: movie.data.id, title: movie.data.title, year: movie.data.year } } : null);
  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('library.movieDetails.invalidMovieIdRawid', { rawId }))} title={t('library.movieDetails.movieNotFound')} />;
  if (movie.isPending) return <Loading />;
  if (movie.isError) return <QueryError error={movie.error} onRetry={() => void movie.refetch()} title={t('library.movieDetails.couldNotLoadThisMovie')} />;
  const m = movie.data;
  const file = files.data?.find((f) => f.id === m.movieFileId) ?? files.data?.[0];
  const chip = movieChip(m);
  const avail = availabilityChip(m);
  const profile = profiles.data?.find((p) => p.id === m.qualityProfileId);

  return (
    <div className="lib-details">
      <DetailsHero
        label={t('library.movieDetails.movieOverview')}
        backdrop={imageUrl(m.images, 'fanart')}
        poster={imageUrl(m.images, 'poster')}
        title={m.title}
        year={m.year}
        crumb={<LibraryCrumb kind="movie" />}
        meta={[m.studio, m.genres.slice(0, 3).join(', ') || null, m.runtimeMinutes ? `${m.runtimeMinutes} min` : null, m.certification, STATUS_LABELS[m.status] ?? m.status]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch monitored={m.monitored} onChange={(v) => setMonitored.mutate({ id: m.id, monitored: v })} label={t('common.monitorTitle', { monitored: m.monitored, title: m.title })} />
            <StatusChip status={m.monitored ? 'monitored' : 'unmonitored'} large />
            {progress.movie ? <QueueStateChip item={progress.movie} large /> : <StatusChip status={chip.status} label={chip.label} large />}
            <Chip tone={avail.tone} large data-testid="availability">
              {avail.label}
            </Chip>
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <AutoTagChips entityType="movie" entityId={m.id} ids={m.tags} tags={tags.data} />
          </>
        }
        facts={
          <>
            <KeyValue
              layout="grid"
              columns={4}
              items={[
                { label: t('common.path'), value: m.path },
                { label: t('common.sizeOnDisk'), value: formatBytes(m.statistics?.sizeOnDisk) },
                { label: t('common.file'), value: qualityName(file?.quality) ?? '—' },
                { label: t('common.minimumAvailability'), value: MINIMUM_AVAILABILITY_LABELS[m.minimumAvailability], mono: false },
              ]}
            />
            <div className="mk-dates" aria-label={t('library.movieDetails.releaseDates')}>
              {releaseDates(m).map(([label, date]) => (
                <span key={label}>
                  {label}
                  <span className="al-num">{date}</span>
                </span>
              ))}
              {m.collection ? (
                <span>
                  {t('library.movieDetails.collection')}
                  <Link to="/library/collections/$tmdbId" params={{ tmdbId: String(m.collection.tmdbId) }} className="mk-link" style={{ marginLeft: 8 }}>
                    {m.collection.title}
                  </Link>
                </span>
              ) : null}
            </div>
            <ItemLanguageChips query={{ movieId: m.id }} />
            {searchStatus.data?.[0] ? (
              <div className="mk-dates" aria-label={t('components.media.pipeline.automaticSearch')}>
                <SearchStatusLines status={searchStatus.data[0]} />
              </div>
            ) : null}
          </>
        }
        overview={m.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ movieId: m.id })}>
              {t('library.movieDetails.searchMovie')}
            </Button>
            <Button onClick={() => setInteractive(true)}>{t('library.movieDetails.interactiveSearch')}</Button>
            <Button onClick={() => setAddingLanguage(true)}>{t('features.additionalLanguages.addAdditional')}</Button>
            <RefreshButtons target={{ movieId: m.id }} />
            <CrossSeedSearchButton target={{ movieId: m.id }} />
            <Link className={buttonClass({ variant: 'secondary' })} to="/activity/manual-import" search={{ movieId: m.id }}>
              {t('common.manualImport')}
            </Link>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <FoundInLists mediaType="movie" tmdbId={m.tmdbId} />
      </DetailsHero>

      <Tabs
        aria-label={t('library.movieDetails.movieSections')}
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'files',
            label: t('common.files'),
            count: files.data?.length,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="movie" ownerId={m.id} />,
          },
          ...(canSeeHealth ? [{ id: 'health', label: t('library.health.tab'), content: <ItemHealthPanel scope={{ movieId: m.id }} /> }] : []),
          { id: 'history', label: t('common.history'), content: <HistoryTable scope={{ movieId: m.id }} /> },
          { id: 'decisions', label: t('library.decisions.tab'), content: <DecisionsPanel scope={{ movieId: m.id }} /> },
          { id: 'search', label: t('common.search'), content: <SearchTab target={{ movieId: m.id }} /> },
          { id: 'subtitles', label: t('common.subtitles'), content: <SubtitlesTab scope={{ movieId: m.id }} /> },
          { id: 'requests', label: t('common.requests'), content: <RequestsTable kind="movie" tmdbId={m.tmdbId} /> },
        ]}
      />

      <AddAdditionalDialog open={addingLanguage} onClose={() => setAddingLanguage(false)} targets={[{ movieId: m.id }]} title={m.title} />
      <InteractiveSearchModal target={interactive ? { movieId: m.id } : null} title={m.title} release={movieReleaseState(m)} onClose={() => setInteractive(false)} />
      {editing ? <EditMovieModal movie={m} onClose={() => setEditing(false)} /> : null}
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={m.title}
        noun="movie"
        path={m.path}
        loading={del.isPending}
        onConfirm={(opts) =>
          del.mutate(
            { ids: [m.id], ...opts },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate({ to: '/library/movies' });
              },
            },
          )
        }
      />
    </div>
  );
}

function EditMovieModal({ movie, onClose }: { movie: Movie; onClose: () => void }) {
  const profiles = useQualityProfiles();
  const update = useUpdateMovie();
  const [monitored, setMonitored] = useState(movie.monitored);
  const [qualityProfileId, setProfile] = useState(movie.qualityProfileId);
  const [minimumAvailability, setMin] = useState<MinimumAvailability>(movie.minimumAvailability);
  const [path, setPath] = useState(movie.path);
  const [tags, setTags] = useState<number[]>([...movie.tags]);
  const [languageProfileId, setLanguageProfileId] = useState<number | null>(movie.languageProfileId ?? null);
  const versions = useVersionsDraft(movie.versions);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.movieDetails.editTitle', { title: movie.title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-movie-form" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-movie-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!versions.valid) return;
          update.mutate(
            {
              id: movie.id,
              body: {
                monitored,
                qualityProfileId,
                minimumAvailability,
                tags,
                ...(languageProfileId !== (movie.languageProfileId ?? null) ? { languageProfileId } : {}),
                ...versions.patch,
                ...(path.trim() && path !== movie.path ? { path: path.trim() } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="movie-monitored" captionInline caption={t('library.movieDetails.searchForThisMovieWhen')}>
          <Toggle id="movie-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label={t('common.qualityProfile')} htmlFor="movie-profile">
          <Select id="movie-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <LanguageProfileSelect value={languageProfileId} onChange={setLanguageProfileId} />
        <FormRow label={t('common.minimumAvailability')} htmlFor="movie-availability">
          <Select id="movie-availability" value={minimumAvailability} onChange={(e) => setMin(e.target.value as MinimumAvailability)}>
            {Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.path')} htmlFor="movie-path">
          <Input id="movie-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
        <VersionsEditor state={versions} profiles={profiles.data ?? []} defaultProfileId={qualityProfileId} idPrefix="edit-movie" />
      </form>
    </Modal>
  );
}

