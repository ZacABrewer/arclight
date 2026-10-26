import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { MinimumAvailability, Movie } from '@media-tron/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../components/form.js';
import { DeleteMediaDialog } from '../../components/media/delete-media-dialog.js';
import { formatBytes, formatDate, imageUrl } from '../../components/media/format.js';
import { Facts, MonitorToggle, PendingButton, Poster, QualityBadge, TagList } from '../../components/media/media-ui.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { Modal } from '../../components/modal.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Tabs } from '../../components/tabs.js';
import {
  useDeleteMovies,
  useMovie,
  useMovieFiles,
  useQualityProfiles,
  useSetMovieMonitored,
  useTags,
  useUpdateMovie,
  useAutomaticSearch,
} from '../../hooks/library.js';
import { MINIMUM_AVAILABILITY_LABELS } from './add-form.js';
import { STATUS_LABELS } from './library-filters.js';
import { MediaFilesTable } from './media-files-table.js';
import { InteractiveSearchModal } from './interactive-search.js';
import { PENDING_REFRESH } from './series-details.js';

const route = getRouteApi('/library/movie/$id');

/** One-word file state for the header badge. */
export function movieFileState(m: Pick<Movie, 'hasFile' | 'monitored' | 'isAvailable'>): { label: string; tone: 'ok' | 'error' | 'warning' | 'info' } {
  if (m.hasFile) return { label: 'Downloaded', tone: 'ok' };
  if (!m.isAvailable) return { label: 'Not available', tone: 'info' };
  return m.monitored ? { label: 'Wanted', tone: 'error' } : { label: 'Missing', tone: 'warning' };
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
  const del = useDeleteMovies();
  const search = useAutomaticSearch();
  const [interactive, setInteractive] = useState(false);
  const navigate = useNavigate();

  if (!Number.isInteger(id) || id <= 0) return <ErrorView error={new Error(`Invalid movie id: ${rawId}`)} />;
  if (movie.isPending) return <LoadingBlock />;
  if (movie.isError) return <ErrorView error={movie.error} onRetry={() => void movie.refetch()} />;
  const m = movie.data;
  const fanart = imageUrl(m.images, 'fanart');
  const file = files.data?.find((f) => f.id === m.movieFileId) ?? files.data?.[0];
  const state = movieFileState(m);

  return (
    <Page title={m.title} subtitle={`${m.year || ''}${m.studio ? ` · ${m.studio}` : ''}`}>
      <section className="media-hero" aria-label="Movie overview">
        {fanart ? <div className="media-hero-fanart" style={{ backgroundImage: `url("${fanart}")` }} aria-hidden="true" /> : null}
        <Poster url={imageUrl(m.images, 'poster')} title={m.title} size="lg" />
        <div className="media-hero-body">
          <h2 className="media-hero-title">
            <MonitorToggle monitored={m.monitored} onChange={(v) => setMonitored.mutate({ id: m.id, monitored: v })} />
            {m.title}
            <Badge tone="neutral">{STATUS_LABELS[m.status] ?? m.status}</Badge>
            <Badge tone={state.tone}>{state.label}</Badge>
          </h2>
          <Facts
            items={[
              ['In cinemas', formatDate(m.inCinemas)],
              ['Digital release', formatDate(m.digitalRelease)],
              ['Physical release', formatDate(m.physicalRelease)],
              ['Quality profile', profiles.data?.find((p) => p.id === m.qualityProfileId)?.name ?? `#${m.qualityProfileId}`],
              ['Minimum availability', MINIMUM_AVAILABILITY_LABELS[m.minimumAvailability]],
              ['Path', <code key="p">{m.path}</code>],
              ['Size on disk', formatBytes(m.statistics?.sizeOnDisk)],
              ['File', file ? <QualityBadge key="q" quality={file.quality} /> : '—'],
              ['Runtime', m.runtimeMinutes ? `${m.runtimeMinutes} min` : '—'],
              ['Genres', m.genres.join(', ') || '—'],
              ['Collection', m.collection?.title ?? '—'],
              ['Tags', m.tags.length ? <TagList key="t" ids={m.tags} tags={tags.data} /> : '—'],
            ]}
          />
          {m.overview ? <p className="media-hero-overview">{m.overview}</p> : null}
          <div className="media-hero-actions">
            {/* TODO(contract): wire Refresh to a refresh command once packages/shared defines one. */}
            <PendingButton reason={PENDING_REFRESH} size="md">
              Refresh
            </PendingButton>
            <Button loading={search.isPending} onClick={() => search.mutate({ movieId: m.id })}>
              Search
            </Button>
            <Button onClick={() => setInteractive(true)}>Interactive search</Button>
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
            id: 'files',
            label: `Files${files.data ? ` (${files.data.length})` : ''}`,
            content: <MediaFilesTable files={files.data} error={files.error} loading={files.isPending} mediaType="movie" ownerId={m.id} />,
          },
          {
            id: 'history',
            label: 'History',
            content: (
              <Card>
                {/* TODO(contract): packages/shared/src/history.ts is still empty; render GET /history?movieId= when it lands. */}
                <EmptyState title="History is coming soon">
                  <p className="muted">Grabs, imports and failures for this movie will be listed here once the history module lands.</p>
                </EmptyState>
              </Card>
            ),
          },
        ]}
      />

      <InteractiveSearchModal target={interactive ? { movieId: m.id } : null} title={m.title} onClose={() => setInteractive(false)} />
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${m.title}`}>
        {editing ? <EditMovieForm movie={m} onClose={() => setEditing(false)} /> : null}
      </Modal>
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={m.title}
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
    </Page>
  );
}

function EditMovieForm({ movie, onClose }: { movie: Movie; onClose: () => void }) {
  const profiles = useQualityProfiles();
  const update = useUpdateMovie();
  const [monitored, setMonitored] = useState(movie.monitored);
  const [qualityProfileId, setProfile] = useState(movie.qualityProfileId);
  const [minimumAvailability, setMin] = useState<MinimumAvailability>(movie.minimumAvailability);
  const [path, setPath] = useState(movie.path);
  const [tags, setTags] = useState<number[]>([...movie.tags]);

  return (
    <form
      className="stack"
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
              ...(path.trim() && path !== movie.path ? { path: path.trim() } : {}),
            },
          },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="fields">
        <Toggle label="Monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        <FormField label="Quality profile">
          <Select value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Minimum availability">
          <Select value={minimumAvailability} onChange={(e) => setMin(e.target.value as MinimumAvailability)}>
            {Object.entries(MINIMUM_AVAILABILITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Path">
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
