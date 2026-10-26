import { useEffect, useMemo, useReducer, useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportMode, ManualImportQueryInput, ManualImportResult, MediaType, Movie, Series } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { manualImportApi } from '../../../api/manual-import.js';
import { queueApi } from '../../../api/queue.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { EntityPicker, type EntityOption } from '../../../components/entity-picker.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select } from '../../../components/form.js';
import { Page } from '../../../components/page.js';
import { PathInput } from '../../../components/path-picker/index.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useEpisodes, useMovieList, useSeriesList } from '../../../hooks/library.js';
import { formatBytes } from '../activity-shared.js';
import {
  initRows,
  needsManualImport,
  parseLanguages,
  qualityOptions,
  rowProblems,
  rowsReducer,
  selectedCount,
  toImportRequest,
  type ImportRow,
  type RowAction,
} from './mapping.js';

const route = getRouteApi('/activity/manual-import');

export interface ManualImportSearch {
  folder?: string;
  downloadId?: string;
  seriesId?: number;
  movieId?: number;
}

/** Route search parsing: unknown or malformed params are dropped. */
export function parseManualImportSearch(search: Record<string, unknown>): ManualImportSearch {
  const out: ManualImportSearch = {};
  if (typeof search['folder'] === 'string' && search['folder']) out.folder = search['folder'];
  if (typeof search['downloadId'] === 'string' && search['downloadId']) out.downloadId = search['downloadId'];
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
  const seriesId = num(search['seriesId']);
  const movieId = num(search['movieId']);
  if (seriesId !== undefined) out.seriesId = seriesId;
  if (movieId !== undefined) out.movieId = movieId;
  return out;
}

/** The GET /manualimport query for a wizard source, or null when nothing is chosen. */
export function toManualImportQuery(s: ManualImportSearch): ManualImportQueryInput | null {
  if (s.downloadId) return { downloadId: s.downloadId };
  if (s.folder) return { folder: s.folder };
  if (s.seriesId !== undefined) return { seriesId: s.seriesId };
  if (s.movieId !== undefined) return { movieId: s.movieId };
  return null;
}


type Step = 'source' | 'files' | 'confirm' | 'results';

// ---- step 1 ------------------------------------------------------------------------------

function SourceStep({ onChoose }: { onChoose: (s: ManualImportSearch) => void }) {
  const [folder, setFolder] = useState('');
  const queue = useQuery({ queryKey: ['queue', 'list', 'manual-import'], queryFn: () => queueApi.list({ page: 1, pageSize: 100 }) });
  const candidates = (queue.data?.records ?? []).filter((q) => q.outputPath !== undefined);
  return (
    <div className="stack">
      <Card title="From a folder">
        <div className="stack-sm">
          <FormField label="Folder" hint="Every video file under it is listed; nothing moves until you confirm.">
            <PathInput value={folder} onChange={setFolder} placeholder="/downloads/complete" pickerTitle="Choose a folder to import from" />
          </FormField>
          <div>
            <Button variant="primary" disabled={!folder.trim()} onClick={() => onChoose({ folder: folder.trim() })}>
              List files
            </Button>
          </div>
        </div>
      </Card>
      <Card title="From the queue" flush>
        {queue.isPending ? (
          <LoadingBlock />
        ) : candidates.length === 0 ? (
          <EmptyState title="No downloads with content on disk" />
        ) : (
          <ul className="mi-queue-list">
            {candidates.map((q) => (
              <li key={q.id}>
                <button type="button" className="path-picker-entry" onClick={() => onChoose({ downloadId: q.downloadId })}>
                  <span className="break">{q.title}</span>
                  {needsManualImport(q) ? <Badge tone="warning">needs import</Badge> : <Badge>{q.trackedState}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---- step 2 ------------------------------------------------------------------------------

function EpisodesPicker({ row, dispatch }: { row: ImportRow; dispatch: (a: RowAction) => void }) {
  const episodes = useEpisodes(row.seriesId!);
  const inSeason = (episodes.data ?? []).filter((e) => e.seasonNumber === row.seasonNumber).sort((a, b) => a.episodeNumber - b.episodeNumber);
  const chosen = new Set(row.episodeIds);
  const summary =
    row.episodeIds.length === 0
      ? 'Choose…'
      : inSeason
          .filter((e) => chosen.has(e.id))
          .map((e) => `E${String(e.episodeNumber).padStart(2, '0')}`)
          .join(', ') || `${row.episodeIds.length} selected`;
  return (
    <details className="popover mi-episodes">
      <summary aria-label={`Episodes for ${row.name}`} className={row.seasonNumber === null ? 'muted' : undefined}>
        {row.seasonNumber === null ? 'Pick a season' : summary}
      </summary>
      {row.seasonNumber !== null ? (
        <div className="popover-body">
          {episodes.isPending ? <LoadingBlock /> : null}
          {inSeason.map((e) => (
            <label key={e.id} className="mi-episode-option">
              <input
                type="checkbox"
                checked={chosen.has(e.id)}
                onChange={(ev) => {
                  const on = ev.currentTarget.checked;
                  dispatch({ type: 'episodes', path: row.path, episodeIds: on ? [...row.episodeIds, e.id] : row.episodeIds.filter((id) => id !== e.id) });
                }}
              />
              {`E${String(e.episodeNumber).padStart(2, '0')}`} <span className="muted">{e.title}</span>
            </label>
          ))}
          {!episodes.isPending && inSeason.length === 0 ? <p className="muted">No episodes in this season.</p> : null}
        </div>
      ) : null}
    </details>
  );
}

function Rejections({ row }: { row: ImportRow }) {
  if (row.rejections.length === 0) return null;
  const text = row.rejections.map((r) => r.message).join('\n');
  return (
    <span title={text} aria-label={`Rejections: ${text}`} className="mi-rejections">
      <Badge tone={row.rejections.some((r) => r.type === 'permanent') ? 'error' : 'warning'}>
        {row.rejections.length} issue{row.rejections.length === 1 ? '' : 's'}
      </Badge>
    </span>
  );
}

function FileRow({
  row,
  dispatch,
  seriesList,
  seriesOptions,
  movieOptions,
}: {
  row: ImportRow;
  dispatch: (a: RowAction) => void;
  seriesList: readonly Series[];
  seriesOptions: EntityOption[];
  movieOptions: EntityOption[];
}) {
  const series = row.seriesId !== null ? seriesList.find((s) => s.id === row.seriesId) : undefined;
  const problems = rowProblems(row);
  return (
    <tr className={problems.length ? 'mi-row-incomplete' : undefined}>
      <td>
        <input
          type="checkbox"
          aria-label={`Import ${row.name}`}
          checked={row.selected}
          disabled={problems.length > 0}
          title={problems.join(', ') || undefined}
          onChange={(e) => dispatch({ type: 'toggle', path: row.path, selected: e.currentTarget.checked })}
        />
      </td>
      <td className="break">
        <div>{row.relativePath}</div>
        <div className="muted">
          {formatBytes(row.sizeBytes)} <Rejections row={row} />
        </div>
      </td>
      <td>
        <Select
          aria-label={`Type for ${row.name}`}
          value={row.mediaType}
          onChange={(e) => dispatch({ type: 'mediaType', path: row.path, mediaType: e.currentTarget.value as MediaType })}
          options={[
            { value: 'series', label: 'Episode' },
            { value: 'movie', label: 'Movie' },
          ]}
        />
      </td>
      {row.mediaType === 'series' ? (
        <>
          <td>
            <EntityPicker
              aria-label={`Series for ${row.name}`}
              options={seriesOptions}
              value={row.seriesId}
              onChange={(id) => dispatch({ type: 'series', path: row.path, seriesId: id })}
            />
          </td>
          <td>
            <Select
              aria-label={`Season for ${row.name}`}
              value={row.seasonNumber?.toString() ?? ''}
              disabled={!series}
              onChange={(e) => dispatch({ type: 'season', path: row.path, seasonNumber: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            >
              <option value="">—</option>
              {(series?.seasons ?? []).map((s) => (
                <option key={s.seasonNumber} value={s.seasonNumber}>
                  {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`}
                </option>
              ))}
            </Select>
          </td>
          <td>{row.seriesId !== null ? <EpisodesPicker row={row} dispatch={dispatch} /> : <span className="muted">—</span>}</td>
        </>
      ) : (
        <td colSpan={3}>
          <EntityPicker
            aria-label={`Movie for ${row.name}`}
            options={movieOptions}
            value={row.movieId}
            onChange={(id) => dispatch({ type: 'movie', path: row.path, movieId: id })}
          />
        </td>
      )}
      <td>
        <Select
          aria-label={`Quality for ${row.name}`}
          value={String(row.quality.quality.id)}
          onChange={(e) => dispatch({ type: 'quality', path: row.path, qualityId: Number(e.currentTarget.value) })}
          options={qualityOptions(row.mediaType).map((q) => ({ value: String(q.id), label: q.name }))}
        />
      </td>
      <td>
        <Input
          aria-label={`Languages for ${row.name}`}
          className="mi-small-input"
          defaultValue={row.languages.join(', ')}
          onBlur={(e) => dispatch({ type: 'languages', path: row.path, languages: parseLanguages(e.currentTarget.value) })}
        />
      </td>
      <td>
        <Input
          aria-label={`Release group for ${row.name}`}
          className="mi-small-input"
          value={row.releaseGroup}
          onChange={(e) => dispatch({ type: 'releaseGroup', path: row.path, releaseGroup: e.currentTarget.value })}
        />
      </td>
    </tr>
  );
}

export function FilesTable({ rows, dispatch }: { rows: ImportRow[]; dispatch: (a: RowAction) => void }) {
  const series = useSeriesList();
  const movies = useMovieList();
  const seriesOptions = useMemo(
    () => (series.data ?? []).map((s) => ({ id: s.id, label: s.title, detail: s.year ? String(s.year) : undefined })).sort((a, b) => a.label.localeCompare(b.label)),
    [series.data],
  );
  const movieOptions = useMemo(
    () => (movies.data ?? []).map((m: Movie) => ({ id: m.id, label: m.title, detail: m.year ? String(m.year) : undefined })).sort((a, b) => a.label.localeCompare(b.label)),
    [movies.data],
  );
  const selectable = rows.filter((r) => rowProblems(r).length === 0);
  const allSelected = selectable.length > 0 && selectable.every((r) => r.selected);
  return (
    <div className="table-wrap">
      <table className="table mi-table">
        <caption className="sr-only">Files to import</caption>
        <thead>
          <tr>
            <th scope="col">
              <input type="checkbox" aria-label="Select all files" checked={allSelected} onChange={(e) => dispatch({ type: 'toggleAll', selected: e.currentTarget.checked })} />
            </th>
            <th scope="col">File</th>
            <th scope="col">Type</th>
            <th scope="col">Series / Movie</th>
            <th scope="col">Season</th>
            <th scope="col">Episodes</th>
            <th scope="col">Quality</th>
            <th scope="col">Languages</th>
            <th scope="col">Release group</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <FileRow key={r.path} row={r} dispatch={dispatch} seriesList={series.data ?? []} seriesOptions={seriesOptions} movieOptions={movieOptions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- step 3 ------------------------------------------------------------------------------

function ResultsView({ result }: { result: ManualImportResult }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Import results</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">File</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {result.imported.map((i) => (
            <tr key={`ok-${i.path}`}>
              <td>
                <Badge tone="ok">imported</Badge>
              </td>
              <td className="break">{i.path}</td>
              <td className="break">{i.destination}</td>
            </tr>
          ))}
          {result.failed.map((f) => (
            <tr key={`fail-${f.path}`}>
              <td>
                <Badge tone="error">failed</Badge>
              </td>
              <td className="break">{f.path}</td>
              <td className="break">{f.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- page --------------------------------------------------------------------------------

export function ManualImportPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const qc = useQueryClient();
  const query = toManualImportQuery(search);
  const [step, setStep] = useState<Step>(query ? 'files' : 'source');
  const [rows, dispatch] = useReducer(rowsReducer, []);
  const [mode, setMode] = useState<ImportMode>('auto');
  const fallbackType: MediaType = search.movieId !== undefined ? 'movie' : 'series';

  useEffect(() => {
    setStep(query ? 'files' : 'source');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialised query is the dependency
  }, [JSON.stringify(query)]);

  const files = useQuery({
    queryKey: ['manualimport', query],
    queryFn: () => manualImportApi.list(query!),
    enabled: query !== null,
    retry: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (files.data) dispatch({ type: 'reset', rows: initRows(files.data, fallbackType) });
  }, [files.data, fallbackType]);

  const run = useMutation({
    mutationFn: () => manualImportApi.execute(toImportRequest(rows, mode)),
    meta: { errorTitle: 'Manual import failed' },
    onSuccess: async () => {
      setStep('results');
      await Promise.all([qc.invalidateQueries({ queryKey: ['queue'] }), qc.invalidateQueries({ queryKey: ['history'] }), qc.invalidateQueries({ queryKey: ['library'] })]);
    },
  });

  const chosen = selectedCount(rows);
  const sourceLabel = search.folder ?? (search.downloadId ? `download ${search.downloadId}` : search.seriesId !== undefined ? 'series folder' : search.movieId !== undefined ? 'movie folder' : null);

  return (
    <Page
      title="Manual import"
      subtitle={sourceLabel ? <span className="break">{sourceLabel}</span> : 'Choose files, map them to the library, and import'}
      actions={
        step !== 'source' ? (
          <Button
            variant="ghost"
            onClick={() => {
              run.reset();
              void navigate({ search: {} });
              setStep('source');
            }}
          >
            Start over
          </Button>
        ) : null
      }
    >
      <ol className="mi-steps" aria-label="Steps">
        <li className={step === 'source' ? 'mi-step-active' : undefined}>1. Source</li>
        <li className={step === 'files' ? 'mi-step-active' : undefined}>2. Map files</li>
        <li className={step === 'confirm' || step === 'results' ? 'mi-step-active' : undefined}>3. Import</li>
      </ol>

      {step === 'source' ? <SourceStep onChoose={(s) => void navigate({ search: s })} /> : null}

      {step === 'files' ? (
        <Card flush>
          {files.isPending ? (
            <LoadingBlock label="Scanning files" />
          ) : files.isError ? (
            <ErrorView error={files.error} onRetry={() => void files.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title="No importable files found">Nothing under this source looks like a video file that is not already in the library.</EmptyState>
          ) : (
            <>
              <FilesTable rows={rows} dispatch={dispatch} />
              <div className="card-footer-form row-end">
                <span className="muted">
                  {chosen} of {rows.length} selected
                </span>
                <Button variant="primary" disabled={chosen === 0} onClick={() => setStep('confirm')}>
                  Next
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}

      {step === 'confirm' ? (
        <Card title="Import options">
          <div className="stack-sm">
            <p>
              Import {chosen} file{chosen === 1 ? '' : 's'} into the library.
            </p>
            <FormField label="Import mode" hint="Auto moves files out of non-download folders and copies (or hardlinks) out of an active download so seeding continues.">
              <Select
                value={mode}
                onChange={(e) => setMode(e.currentTarget.value as ImportMode)}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'move', label: 'Move' },
                  { value: 'copy', label: 'Copy / hardlink' },
                ]}
              />
            </FormField>
            {run.error ? (
              <p className="field-error-text" role="alert">
                {errorMessage(run.error)}
              </p>
            ) : null}
            <div className="row">
              <Button variant="ghost" onClick={() => setStep('files')}>
                Back
              </Button>
              <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
                Import
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 'results' && run.data ? (
        <Card
          title={`Imported ${run.data.imported.length}, failed ${run.data.failed.length}`}
          flush
        >
          <ResultsView result={run.data} />
          <div className="card-footer-form row">
            <Link to="/activity/queue">Back to queue</Link>
            <Button variant="ghost" onClick={() => void files.refetch().then(() => setStep('files'))}>
              Import more from this source
            </Button>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
