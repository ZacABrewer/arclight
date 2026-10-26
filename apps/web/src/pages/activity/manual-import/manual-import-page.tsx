import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportMode, ManualImportQueryInput, ManualImportResult, MediaType, Movie, Series } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { manualImportApi } from '../../../api/manual-import.js';
import { queueApi } from '../../../api/queue.js';
import {
  Button,
  buttonClass,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  Input,
  PageHeader,
  Pane,
  Popover,
  RejectionList,
  SectionLabel,
  Segmented,
  Select,
  Skeleton,
  StatusChip,
  Stepper,
  Table,
  Tooltip,
  type Column,
} from '../../../arclight/index.js';
import { EntityPicker, type EntityOption } from '../../../components/entity-picker.js';
import { PathInput } from '../../../components/path-picker/index.js';
import { useEpisodes, useMovieList, useSeriesList } from '../../../hooks/library.js';
import { formatBytes, useDocumentTitle } from '../activity-shared.js';
import { queueChip } from '../queue-status.js';
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

export const WIZARD_STEPS = [
  { id: 'path', label: 'Path' },
  { id: 'files', label: 'Files' },
  { id: 'mapping', label: 'Mapping' },
  { id: 'mode', label: 'Mode' },
  { id: 'results', label: 'Results' },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]['id'];

const stepIndex = (s: WizardStep) => WIZARD_STEPS.findIndex((x) => x.id === s);

export const MODE_OPTIONS: ReadonlyArray<{ value: ImportMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'Moves files out of ordinary folders; copies or hardlinks out of an active download so seeding continues.' },
  { value: 'move', label: 'Move', hint: 'Moves the files into the library. The download client loses them.' },
  { value: 'copy', label: 'Copy or hardlink', hint: 'Hardlinks when the library is on the same disk, otherwise copies. The original stays in place.' },
];

// ---- Path ---------------------------------------------------------------------------------

function PathStep({ folder, onFolder, onChoose }: { folder: string; onFolder: (v: string) => void; onChoose: (s: ManualImportSearch) => void }) {
  const queue = useQuery({ queryKey: ['queue', 'list', 'manual-import'], queryFn: () => queueApi.list({ page: 1, pageSize: 100 }) });
  const candidates = (queue.data?.records ?? []).filter((q) => q.outputPath !== undefined);
  return (
    <div className="al-mi-step">
      <Field label="Folder" hint="Every video file under it is listed. Nothing moves until you confirm.">
        <PathInput aria-label="Folder" value={folder} onChange={onFolder} placeholder="/downloads/complete" pickerTitle="Choose a folder to import from" />
      </Field>
      <section className="al-mi-section">
        <SectionLabel as="h3">FROM THE QUEUE</SectionLabel>
        {queue.isPending ? (
          <Skeleton lines={3} />
        ) : candidates.length === 0 ? (
          <EmptyState title="No downloads with files on disk" />
        ) : (
          <ul className="al-mi-list">
            {candidates.map((q) => {
              const chip = queueChip(q);
              return (
                <li key={q.id}>
                  <button type="button" className="al-mi-list__row" onClick={() => onChoose({ downloadId: q.downloadId })}>
                    <span className="al-mi-list__title">{q.title}</span>
                    {needsManualImport(q) ? <Chip tone="warn">Needs import</Chip> : <StatusChip status={chip.status} cause={chip.cause} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---- Files --------------------------------------------------------------------------------

function MappingChip({ row }: { row: ImportRow }) {
  const permanent = row.rejections.find((r) => r.type === 'permanent');
  const problems = rowProblems(row);
  const chip =
    permanent && problems.length === 0 ? (
      <StatusChip status="failed" cause={permanent.message.toLowerCase()} />
    ) : problems.length ? (
      <Chip tone="warn">{problems[0]}</Chip>
    ) : (
      <Chip tone="accent">Mapped</Chip>
    );
  if (row.rejections.length === 0) return chip;
  return (
    <Tooltip content={<RejectionList reasons={row.rejections.map((r) => r.message)} />}>
      <span tabIndex={0} className="al-mi-chip-anchor">
        {chip}
      </span>
    </Tooltip>
  );
}

const FILE_COLUMNS: Column<ImportRow>[] = [
  { key: 'path', header: 'File', mono: true, cell: (r) => <span className="al-activity-break">{r.relativePath}</span> },
  { key: 'size', header: 'Size', mono: true, align: 'right', width: '100px', cell: (r) => formatBytes(r.sizeBytes) },
  { key: 'quality', header: 'Quality', mono: true, width: '140px', cell: (r) => r.quality.quality.name },
  { key: 'state', header: 'Mapping', cell: (r) => <MappingChip row={r} /> },
];

function FilesStep({ rows }: { rows: ImportRow[] }) {
  const mapped = rows.filter((r) => rowProblems(r).length === 0).length;
  return (
    <div className="al-mi-step">
      <p className="al-activity-muted">
        <span className="al-num">{rows.length}</span> files found · <span className="al-num">{mapped}</span> already mapped. Map the rest on the next step.
      </p>
      <Table caption="Files found" columns={FILE_COLUMNS} rows={rows} rowKey={(r) => r.path} sortable={false} />
    </div>
  );
}

// ---- Mapping ------------------------------------------------------------------------------

const ep = (n: number) => `E${String(n).padStart(2, '0')}`;

function EpisodesPicker({ row, dispatch }: { row: ImportRow; dispatch: (a: RowAction) => void }) {
  const episodes = useEpisodes(row.seriesId!);
  const inSeason = (episodes.data ?? []).filter((e) => e.seasonNumber === row.seasonNumber).sort((a, b) => a.episodeNumber - b.episodeNumber);
  const chosen = new Set(row.episodeIds);
  if (row.seasonNumber === null) return <span className="al-activity-muted">Pick a season</span>;
  const summary =
    row.episodeIds.length === 0
      ? 'Choose…'
      : inSeason
          .filter((e) => chosen.has(e.id))
          .map((e) => ep(e.episodeNumber))
          .join(', ') || `${row.episodeIds.length} selected`;
  return (
    <Popover
      width={280}
      label={`Episodes for ${row.name}`}
      trigger={(props) => (
        <Button {...props} size="sm" variant="secondary" aria-label={`Episodes for ${row.name}`}>
          <span className="al-num">{summary}</span>
        </Button>
      )}
    >
      <div className="al-mi-episodes">
        {episodes.isPending ? <Skeleton lines={3} /> : null}
        {inSeason.map((e) => (
          <Checkbox
            key={e.id}
            label={
              <>
                <span className="al-num">{ep(e.episodeNumber)}</span> {e.title}
              </>
            }
            checked={chosen.has(e.id)}
            onChange={(ev) => {
              const on = ev.currentTarget.checked;
              dispatch({ type: 'episodes', path: row.path, episodeIds: on ? [...row.episodeIds, e.id] : row.episodeIds.filter((id) => id !== e.id) });
            }}
          />
        ))}
        {!episodes.isPending && inSeason.length === 0 ? <p className="al-activity-muted">No episodes in this season.</p> : null}
      </div>
    </Popover>
  );
}

interface MappingContext {
  dispatch: (a: RowAction) => void;
  seriesList: readonly Series[];
  seriesOptions: EntityOption[];
  movieOptions: EntityOption[];
}

function mappingColumns({ dispatch, seriesList, seriesOptions, movieOptions }: MappingContext): Column<ImportRow>[] {
  return [
    {
      key: 'file',
      header: 'File',
      cell: (r) => (
        <div className="al-activity-title">
          <span className="al-activity-title__main al-num" title={r.relativePath}>
            {r.relativePath}
          </span>
          <span className="al-activity-title__sub al-num">
            {formatBytes(r.sizeBytes)}
            {rowProblems(r).length ? ` · ${rowProblems(r).join(', ')}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (r) => (
        <Select
          aria-label={`Type for ${r.name}`}
          value={r.mediaType}
          onChange={(e) => dispatch({ type: 'mediaType', path: r.path, mediaType: e.currentTarget.value as MediaType })}
          options={[
            { value: 'series', label: 'Episode' },
            { value: 'movie', label: 'Movie' },
          ]}
        />
      ),
    },
    {
      key: 'target',
      header: 'Series / movie',
      cell: (r) =>
        r.mediaType === 'series' ? (
          <EntityPicker aria-label={`Series for ${r.name}`} options={seriesOptions} value={r.seriesId} onChange={(id) => dispatch({ type: 'series', path: r.path, seriesId: id })} />
        ) : (
          <EntityPicker aria-label={`Movie for ${r.name}`} options={movieOptions} value={r.movieId} onChange={(id) => dispatch({ type: 'movie', path: r.path, movieId: id })} />
        ),
    },
    {
      key: 'season',
      header: 'Season',
      cell: (r) => {
        if (r.mediaType !== 'series') return <span className="al-activity-muted">—</span>;
        const series = r.seriesId !== null ? seriesList.find((s) => s.id === r.seriesId) : undefined;
        return (
          <Select
            aria-label={`Season for ${r.name}`}
            value={r.seasonNumber?.toString() ?? ''}
            disabled={!series}
            onChange={(e) => dispatch({ type: 'season', path: r.path, seasonNumber: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
          >
            <option value="">—</option>
            {(series?.seasons ?? []).map((s) => (
              <option key={s.seasonNumber} value={s.seasonNumber}>
                {s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`}
              </option>
            ))}
          </Select>
        );
      },
    },
    {
      key: 'episodes',
      header: 'Episodes',
      cell: (r) =>
        r.mediaType === 'series' && r.seriesId !== null ? <EpisodesPicker row={r} dispatch={dispatch} /> : <span className="al-activity-muted">—</span>,
    },
    {
      key: 'quality',
      header: 'Quality',
      cell: (r) => (
        <Select
          aria-label={`Quality for ${r.name}`}
          value={String(r.quality.quality.id)}
          onChange={(e) => dispatch({ type: 'quality', path: r.path, qualityId: Number(e.currentTarget.value) })}
          options={qualityOptions(r.mediaType).map((q) => ({ value: String(q.id), label: q.name }))}
        />
      ),
    },
    {
      key: 'languages',
      header: 'Languages',
      cell: (r) => (
        <Input
          aria-label={`Languages for ${r.name}`}
          className="al-mi-small"
          defaultValue={r.languages.join(', ')}
          onBlur={(e) => dispatch({ type: 'languages', path: r.path, languages: parseLanguages(e.currentTarget.value) })}
        />
      ),
    },
    {
      key: 'group',
      header: 'Group',
      cell: (r) => (
        <Input
          aria-label={`Release group for ${r.name}`}
          className="al-mi-small"
          mono
          value={r.releaseGroup}
          onChange={(e) => dispatch({ type: 'releaseGroup', path: r.path, releaseGroup: e.currentTarget.value })}
        />
      ),
    },
  ];
}

/** Mapping table: select files and map each one to a series episode or movie. */
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
  const columns = mappingColumns({ dispatch, seriesList: series.data ?? [], seriesOptions, movieOptions });
  const selected = new Set(rows.filter((r) => r.selected).map((r) => r.path));
  return (
    <Table
      caption="Files to import"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.path}
      rowLabel={(r) => `Import ${r.name}`}
      sortable={false}
      selectable
      selected={selected}
      onSelectionChange={(next) => {
        const all = rows.every((r) => next.has(r.path));
        const none = next.size === 0;
        if (all || none) {
          dispatch({ type: 'toggleAll', selected: all });
          return;
        }
        for (const r of rows) {
          const on = next.has(r.path);
          if (on !== r.selected) dispatch({ type: 'toggle', path: r.path, selected: on });
        }
      }}
    />
  );
}

// ---- Mode ---------------------------------------------------------------------------------

function ModeStep({ mode, onMode, count, error }: { mode: ImportMode; onMode: (m: ImportMode) => void; count: number; error: unknown }) {
  const current = MODE_OPTIONS.find((o) => o.value === mode)!;
  return (
    <div className="al-mi-step">
      <p>
        Import <span className="al-num">{count}</span> {count === 1 ? 'file' : 'files'} into the library.
      </p>
      <Field label="Import mode" hint={current.hint}>
        <Segmented aria-label="Import mode" variant="soft" value={mode} onChange={onMode} options={MODE_OPTIONS.map(({ value, label }) => ({ value, label }))} />
      </Field>
      {error ? (
        <ErrorBlock title="Import failed">{errorMessage(error)}</ErrorBlock>
      ) : null}
    </div>
  );
}

// ---- Results ------------------------------------------------------------------------------

interface ResultRow {
  path: string;
  ok: boolean;
  detail: string;
}

const RESULT_COLUMNS: Column<ResultRow>[] = [
  {
    key: 'status',
    header: 'Result',
    width: '220px',
    cell: (r) => (r.ok ? <StatusChip status="downloaded" label="Imported" /> : <StatusChip status="failed" cause={r.detail.toLowerCase().replace(/[.\s]+$/, '').slice(0, 40)} />),
  },
  { key: 'path', header: 'File', mono: true, cell: (r) => <span className="al-activity-break">{r.path}</span> },
  { key: 'detail', header: 'Destination / error', mono: true, muted: true, cell: (r) => <span className="al-activity-break">{r.detail}</span> },
];

export function ResultsView({ result }: { result: ManualImportResult }) {
  const rows: ResultRow[] = [
    ...result.imported.map((i) => ({ path: i.path, ok: true, detail: i.destination })),
    ...result.failed.map((f) => ({ path: f.path, ok: false, detail: f.error })),
  ];
  return (
    <div className="al-mi-step">
      <p>
        Imported <span className="al-num">{result.imported.length}</span>, failed <span className="al-num">{result.failed.length}</span>.
      </p>
      <Table caption="Import results" columns={RESULT_COLUMNS} rows={rows} rowKey={(r) => `${r.ok}-${r.path}`} sortable={false} />
    </div>
  );
}

// ---- page ---------------------------------------------------------------------------------

export function ManualImportPage() {
  useDocumentTitle('Manual import');
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const qc = useQueryClient();
  const query = toManualImportQuery(search);
  const [step, setStep] = useState<WizardStep>(query ? 'files' : 'path');
  const [folder, setFolder] = useState(search.folder ?? '');
  const [rows, dispatch] = useReducer(rowsReducer, []);
  const [mode, setMode] = useState<ImportMode>('auto');
  const fallbackType: MediaType = search.movieId !== undefined ? 'movie' : 'series';

  useEffect(() => {
    setStep(query ? 'files' : 'path');
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
    meta: { errorTitle: 'Manual import failed', silent: true },
    onSuccess: async () => {
      setStep('results');
      await Promise.all([qc.invalidateQueries({ queryKey: ['queue'] }), qc.invalidateQueries({ queryKey: ['history'] }), qc.invalidateQueries({ queryKey: ['library'] })]);
    },
  });

  const chosen = selectedCount(rows);
  const sourceLabel = search.folder ?? (search.downloadId ? `download ${search.downloadId}` : search.seriesId !== undefined ? 'series folder' : search.movieId !== undefined ? 'movie folder' : null);
  const index = stepIndex(step);

  const startOver = () => {
    run.reset();
    setFolder('');
    void navigate({ search: {} });
    setStep('path');
  };

  const goTo = (s: WizardStep) => {
    if (s === 'path') startOver();
    else setStep(s);
  };

  let body: ReactNode;
  let canContinue = false;
  let onContinue: () => void = () => {};
  let continueLabel = 'Continue';
  if (step === 'path') {
    body = <PathStep folder={folder} onFolder={setFolder} onChoose={(s) => void navigate({ search: s })} />;
    canContinue = folder.trim() !== '';
    onContinue = () => void navigate({ search: { folder: folder.trim() } });
  } else if (step === 'files' || step === 'mapping') {
    if (files.isPending) body = <Skeleton lines={5} />;
    else if (files.isError)
      body = (
        <ErrorBlock title="Couldn't list files" onRetry={() => void files.refetch()}>
          {errorMessage(files.error)}
        </ErrorBlock>
      );
    else if (rows.length === 0)
      body = <EmptyState title="No importable files found">Nothing under this source looks like a video file that is not already in the library.</EmptyState>;
    else body = step === 'files' ? <FilesStep rows={rows} /> : <FilesTable rows={rows} dispatch={dispatch} />;
    if (step === 'files') {
      canContinue = rows.length > 0;
      onContinue = () => setStep('mapping');
    } else {
      canContinue = chosen > 0;
      onContinue = () => setStep('mode');
    }
  } else if (step === 'mode') {
    body = <ModeStep mode={mode} onMode={setMode} count={chosen} error={run.error} />;
    canContinue = chosen > 0;
    continueLabel = `Import ${chosen} ${chosen === 1 ? 'file' : 'files'}`;
    onContinue = () => run.mutate();
  } else {
    body = run.data ? <ResultsView result={run.data} /> : null;
  }

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title="Manual import"
        subtitle={sourceLabel ? <span className="al-num al-activity-break">{sourceLabel}</span> : 'Choose files, map them to the library, and import.'}
        actions={
          <Link className={buttonClass({ variant: 'secondary', size: 'md' })} to="/activity/queue">
            Back to queue
          </Link>
        }
      />
      <Pane chamfer="tl" bare className="al-mi-wizard">
        <div className="al-mi-wizard__head">
          <Stepper aria-label="Manual import steps" steps={WIZARD_STEPS} current={index} onStepClick={step === 'results' ? undefined : (i) => goTo(WIZARD_STEPS[i]!.id)} />
          {step === 'mapping' ? (
            <span className="al-activity-muted">
              <span className="al-num">{chosen}</span> of <span className="al-num">{rows.length}</span> selected
            </span>
          ) : null}
        </div>
        <div className="al-mi-wizard__body">{body}</div>
        <footer className="al-mi-wizard__foot">
          {step === 'results' ? (
            <>
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
              <span className="al-activity-spacer" />
              <Button variant="secondary" onClick={() => void files.refetch().then(() => setStep('files'))}>
                Import more from this source
              </Button>
              <Link className={buttonClass({ variant: 'primary', size: 'md' })} to="/activity/queue">
                Go to queue
              </Link>
            </>
          ) : (
            <>
              {index > 0 ? (
                <Button variant="ghost" onClick={() => goTo(WIZARD_STEPS[index - 1]!.id)}>
                  Back
                </Button>
              ) : null}
              <span className="al-activity-spacer" />
              <Button variant="primary" disabled={!canContinue} loading={step === 'mode' && run.isPending} onClick={onContinue}>
                {continueLabel}
              </Button>
            </>
          )}
        </footer>
      </Pane>
    </div>
  );
}
