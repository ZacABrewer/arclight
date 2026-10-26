import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { MinimumAvailability, Movie } from '@arclight/shared';
import { Button, Chip, FormRow, Input, KeyValue, Modal, QualityTag, Select, StatusChip, Tabs, Toggle, buttonClass } from '../../arclight/index.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { formatBytes, imageUrl } from '../../components/media/format.js';
import { FoundInLists } from '../../components/media/found-in-lists.js';
import { Loading, MonitorSwitch, QueryError, TagChips, movieChip, qualityName } from '../../components/media/media-kit.js';
import { TagPicker } from '../../components/media/tag-picker.js';
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
import { InteractiveSearchModal } from './interactive-search.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';
import { SearchTab } from './series-details.js';

const route = getRouteApi('/library/movie/$id');

/** The collection link opens the movies index on the Collections view. */
function showCollections() {
  try {
    localStorage.setItem('library.movie.view', JSON.stringify('collections'));
  } catch {
    // Storage unavailable: the index opens on its last view.
  }
}

/** One-word file state for the header chip, in the kit vocabulary. */
export function movieFileState(m: Pick<Movie, 'hasFile' | 'monitored' | 'isAvailable'>): { label: string; tone: 'ok' | 'error' | 'warning' | 'info' } {
  if (m.hasFile) return { label: 'Downloaded', tone: 'ok' };
  if (!m.isAvailable) return { label: 'Unaired', tone: 'info' };
  return m.monitored ? { label: 'Missing', tone: 'error' } : { label: 'Unmonitored', tone: 'warning' };
}

/** Availability chip: is the movie obtainable under its minimum availability? */
export function availabilityChip(m: Pick<Movie, 'isAvailable' | 'minimumAvailability'>): { label: string; tone: 'accent' | 'neutral' } {
  return m.isAvailable ? { label: 'Available', tone: 'accent' } : { label: `Not available until ${MINIMUM_AVAILABILITY_LABELS[m.minimumAvailability].toLowerCase()}`, tone: 'neutral' };
}

/** "In cinemas 2024-03-01 · Digital 2024-04-16 · Physical —" as label/date pairs. */
export function releaseDates(m: Pick<Movie, 'inCinemas' | 'digitalRelease' | 'physicalRelease'>): Array<[string, string]> {
  return [
    ['In cinemas', m.inCinemas ? m.inCinemas.slice(0, 10) : '—'],
    ['Digital', m.digitalRelease ? m.digitalRelease.slice(0, 10) : '—'],
    ['Physical', m.physicalRelease ? m.physicalRelease.slice(0, 10) : '—'],
  ];
}

export function MovieDetailsPage() {
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
  const navigate = useNavigate();
  const progress = useQueueProgress(useMemo(() => ({ movieId: id }), [id]));

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(`Invalid movie id: ${rawId}`)} title="Movie not found" />;
  if (movie.isPending) return <Loading />;
  if (movie.isError) return <QueryError error={movie.error} onRetry={() => void movie.refetch()} title="Could not load this movie" />;
  const m = movie.data;
  const file = files.data?.find((f) => f.id === m.movieFileId) ?? files.data?.[0];
  const chip = movieChip(m, progress.movie);
  const avail = availabilityChip(m);
  const profile = profiles.data?.find((p) => p.id === m.qualityProfileId);

  return (
    <div className="lib-details">
      <DetailsHero
        label="Movie overview"
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
            <MonitorSwitch monitored={m.monitored} onChange={(v) => setMonitored.mutate({ id: m.id, monitored: v })} label={`${m.monitored ? 'Unmonitor' : 'Monitor'} ${m.title}`} />
            <StatusChip status={m.monitored ? 'monitored' : 'unmonitored'} large />
            <StatusChip status={chip.status} label={chip.label} large />
            <Chip tone={avail.tone} large data-testid="availability">
              {avail.label}
            </Chip>
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <TagChips ids={m.tags} tags={tags.data} />
          </>
        }
        facts={
          <>
            <KeyValue
              layout="grid"
              columns={4}
              items={[
                { label: 'Path', value: m.path },
                { label: 'Size on disk', value: formatBytes(m.statistics?.sizeOnDisk) },
                { label: 'File', value: qualityName(file?.quality) ?? '—' },
                { label: 'Minimum availability', value: MINIMUM_AVAILABILITY_LABELS[m.minimumAvailability], mono: false },
              ]}
            />
            <div className="mk-dates" aria-label="Release dates">
              {releaseDates(m).map(([label, date]) => (
                <span key={label}>
                  {label}
                  <span className="al-num">{date}</span>
                </span>
              ))}
              {m.collection ? (
                <span>
                  Collection{' '}
                  <Link to="/library/movies" className="mk-link" style={{ marginLeft: 8 }} onClick={showCollections}>
                    {m.collection.title}
                  </Link>
                </span>
              ) : null}
            </div>
          </>
        }
        overview={m.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ movieId: m.id })}>
              Search movie
            </Button>
            <Button onClick={() => setInteractive(true)}>Interactive search</Button>
            <RefreshButtons target={{ movieId: m.id }} />
            <Link className={buttonClass({ variant: 'secondary' })} to="/activity/manual-import" search={{ movieId: m.id }}>
              Manual import
            </Link>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      >
        <FoundInLists mediaType="movie" tmdbId={m.tmdbId} />
      </DetailsHero>

      <Tabs
        aria-label="Movie sections"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'files',
            label: 'Files',
            count: files.data?.length,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="movie" ownerId={m.id} />,
          },
          { id: 'history', label: 'History', content: <HistoryTable scope={{ movieId: m.id }} /> },
          { id: 'search', label: 'Search', content: <SearchTab target={{ movieId: m.id }} /> },
          { id: 'subtitles', label: 'Subtitles', content: <SubtitlesTab scope={{ movieId: m.id }} /> },
          { id: 'requests', label: 'Requests', content: <RequestsTable kind="movie" tmdbId={m.tmdbId} /> },
        ]}
      />

      <InteractiveSearchModal target={interactive ? { movieId: m.id } : null} title={m.title} onClose={() => setInteractive(false)} />
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

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${movie.title}`}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-movie-form" variant="primary" loading={update.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-movie-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            {
              id: movie.id,
              body: {
                monitored,
                qualityProfileId,
                minimumAvailability,
                tags,
                ...(languageProfileId !== (movie.languageProfileId ?? null) ? { languageProfileId } : {}),
                ...(path.trim() && path !== movie.path ? { path: path.trim() } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label="Monitored" htmlFor="movie-monitored" captionInline caption="Search for this movie when it becomes available.">
          <Toggle id="movie-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label="Quality profile" htmlFor="movie-profile">
          <Select id="movie-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <LanguageProfileSelect value={languageProfileId} onChange={setLanguageProfileId} />
        <FormRow label="Minimum availability" htmlFor="movie-availability">
          <Select id="movie-availability" value={minimumAvailability} onChange={(e) => setMin(e.target.value as MinimumAvailability)}>
            {Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label="Path" htmlFor="movie-path">
          <Input id="movie-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
        </FormRow>
        <FormRow label="Tags">
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
      </form>
    </Modal>
  );
}

