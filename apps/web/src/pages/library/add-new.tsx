import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MetadataSearchResult, MetadataSearchType } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { isMissingTmdbKey } from '../../api/metadata.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { Input } from '../../components/form.js';
import { Poster } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock, Spinner } from '../../components/spinner.js';
import { useMovieList, useQualityProfiles, useRootFolders, useSeriesList } from '../../hooks/library.js';
import { useDebouncedValue, useMetadataSearch } from '../../hooks/metadata.js';
import { AddDialog } from './add-dialog.js';

export function AddNewPage() {
  const [term, setTerm] = useState('');
  const [type, setType] = useState<MetadataSearchType>('all');
  const debounced = useDebouncedValue(term, 400);
  const search = useMetadataSearch(debounced, type);
  const [adding, setAdding] = useState<MetadataSearchResult | null>(null);

  const series = useSeriesList();
  const movies = useMovieList();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();

  const inLibrary = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of series.data ?? []) m.set(`series:${s.tmdbId}`, s.id);
    for (const mv of movies.data ?? []) m.set(`movie:${mv.tmdbId}`, mv.id);
    return m;
  }, [series.data, movies.data]);

  const active = debounced.trim().length >= 2;

  return (
    <Page title="Add new" subtitle="Search TMDB for a series or movie to add to the library">
      <div className="toolbar">
        <Input
          type="search"
          className="toolbar-search"
          aria-label="Search TMDB"
          placeholder="e.g. The Expanse"
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <div className="segmented" role="group" aria-label="Result type">
          {(['all', 'series', 'movie'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>
              {t === 'all' ? 'All' : t === 'series' ? 'Series' : 'Movies'}
            </button>
          ))}
        </div>
        {search.isFetching ? <Spinner inline size="sm" label="Searching" /> : null}
      </div>

      {!active ? (
        <Card>
          <EmptyState title="Start typing to search">
            <p className="muted">Results come from TMDB. Titles already in your library link to their page.</p>
          </EmptyState>
        </Card>
      ) : search.isError ? (
        isMissingTmdbKey(search.error) ? (
          <Card>
            <EmptyState
              title="No TMDB API key configured"
              action={
                // The TMDB key lives on Settings → General (metadata section).
                <Link className="btn btn-primary btn-md" to="/settings/general">
                  Open Settings → Metadata
                </Link>
              }
            >
              <p className="muted">{errorMessage(search.error)}</p>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <EmptyState title="Search failed" action={<Button onClick={() => void search.refetch()}>Try again</Button>}>
              <p className="muted">{errorMessage(search.error)}</p>
            </EmptyState>
          </Card>
        )
      ) : search.isPending ? (
        <LoadingBlock label="Searching" />
      ) : search.data.length === 0 ? (
        <Card>
          <EmptyState title={`No results for “${debounced.trim()}”`} />
        </Card>
      ) : (
        <div className="result-list">
          {search.data.map((r) => {
            const libraryId = inLibrary.get(`${r.mediaType}:${r.tmdbId}`);
            return <ResultCard key={`${r.mediaType}-${r.tmdbId}`} result={r} libraryId={libraryId} onAdd={() => setAdding(r)} />;
          })}
        </div>
      )}

      <AddDialog result={adding} onClose={() => setAdding(null)} rootFolders={rootFolders.data ?? []} profiles={profiles.data ?? []} />
    </Page>
  );
}

function ResultCard({ result, libraryId, onAdd }: { result: MetadataSearchResult; libraryId: number | undefined; onAdd: () => void }) {
  return (
    <article className="result-card" aria-label={result.title}>
      <Poster url={result.images.poster} title={result.title} />
      <div className="result-card-body">
        <h2 className="result-card-title">
          {result.title}
          {result.year ? <span className="muted">({result.year})</span> : null}
          <Badge tone="neutral">{result.mediaType === 'series' ? 'Series' : 'Movie'}</Badge>
          {result.ratings.tmdb.votes > 0 ? <span className="muted">★ {result.ratings.tmdb.value.toFixed(1)}</span> : null}
        </h2>
        {result.originalTitle && result.originalTitle !== result.title ? <span className="muted">{result.originalTitle}</span> : null}
        <p className="result-card-overview">{result.overview || 'No overview available.'}</p>
        <div>
          {libraryId !== undefined ? (
            <Link
              className="btn btn-secondary btn-sm"
              {...(result.mediaType === 'series'
                ? { to: '/library/series/$id' as const, params: { id: String(libraryId) } }
                : { to: '/library/movie/$id' as const, params: { id: String(libraryId) } })}
            >
              In library — view
            </Link>
          ) : (
            <Button size="sm" variant="primary" onClick={onAdd}>
              Add…
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
