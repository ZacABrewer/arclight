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
  rowVersionTags,
  type ImportRow,
  type RowAction,
} from './mapping.js';
import { VersionPicker } from '../../library/versions/versions-editor.js';
import type { AudioManualImportQueryInput } from '@arclight/shared';
import { useFeatures } from '../../../hooks/music.js';
import { audioImportMode } from '../audiobook-media.js';
import { AudioImportWizard } from './audio-import.js';
import { AudiobookImportWizard } from './audiobook-import.js';
import type { AudiobookManualImportQuery } from '../../../api/audiobook-acquisition.js';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/activity/manual-import');

export interface ManualImportSearch {
  folder?: string;
  downloadId?: string;
  seriesId?: number;
  movieId?: number;
  /** Audio mode: music (artist / album / track mapping) or audiobooks (author / book / part order). */
  mediaType?: 'music' | 'audiobook';
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
  if (search['mediaType'] === 'music' || search['mediaType'] === 'audiobook') out.mediaType = search['mediaType'];
  return out;
}

/** The audio scan query for a music source, or null when none is chosen. */
export function toAudioImportQuery(s: ManualImportSearch): AudioManualImportQueryInput | null {
  if (s.mediaType !== 'music') return null;
  if (s.downloadId) return { downloadId: s.downloadId };
  if (s.folder) return { folder: s.folder };
  return null;
}

/** The audio scan query for an audiobook source, or null when none is chosen. */
export function toAudiobookImportQuery(s: ManualImportSearch): AudiobookManualImportQuery | null {
  if (s.mediaType !== 'audiobook') return null;
  if (s.downloadId) return { downloadId: s.downloadId };
  if (s.folder) return { folder: s.folder };
  return null;
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
  { id: 'path', get label() { return t('common.path'); } },
  { id: 'files', get label() { return t('common.files'); } },
  { id: 'mapping', get label() { return t('activity.manualImport.mapping'); } },
  { id: 'mode', get label() { return t('common.mode'); } },
  { id: 'results', get label() { return t('common.results'); } },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]['id'];

const stepIndex = (s: WizardStep) => WIZARD_STEPS.findIndex((x) => x.id === s);

export const MODE_OPTIONS: ReadonlyArray<{ value: ImportMode; label: string; hint: string }> = [
  { value: 'auto', get label() { return t('activity.manualImport.auto'); }, get hint() { return t('activity.manualImport.movesFilesOutOfOrdinary'); } },
  { value: 'move', get label() { return t('activity.manualImport.move'); }, get hint() { return t('activity.manualImport.movesTheFilesIntoThe'); } },
  { value: 'copy', get label() { return t('activity.manualImport.copyOrHardlink'); }, get hint() { return t('activity.manualImport.hardlinksWhenTheLibraryIs'); } },
];

// ---- Path ---------------------------------------------------------------------------------

type SourceKind = 'video' | 'music' | 'audiobook';

function PathStep({
  folder,
  onFolder,
  onChoose,
  kind,
  onKind,
}: {
  folder: string;
  onFolder: (v: string) => void;
  onChoose: (s: ManualImportSearch) => void;
  kind: SourceKind;
  onKind: (k: SourceKind) => void;
}) {
  const features = useFeatures();
  const queue = useQuery({ queryKey: ['queue', 'list', 'manual-import'], queryFn: () => queueApi.list({ page: 1, pageSize: 100 }) });
  const candidates = (queue.data?.records ?? []).filter((q) => q.outputPath !== undefined);
  return (
    <div className="al-mi-step">
      {features.music || features.audiobooks ? (
        <Field
          label={t('activity.manualImport.audio.filesAre')}
          hint={kind === 'music' ? t('activity.manualImport.audio.musicHint') : kind === 'audiobook' ? t('activity.manualImport.audiobook.hint') : undefined}
        >
          <Segmented
            aria-label={t('activity.manualImport.audio.filesAre')}
            value={kind}
            onChange={onKind}
            options={[
              { value: 'video' as const, label: t('activity.manualImport.audio.video') },
              ...(features.music ? [{ value: 'music' as const, label: t('common.music') }] : []),
              ...(features.audiobooks ? [{ value: 'audiobook' as const, label: t('common.audiobooks') }] : []),
            ]}
          />
        </Field>
      ) : null}
      <Field label={t('activity.manualImport.folder')} hint={t('activity.manualImport.everyVideoFileUnderIt')}>
        <PathInput aria-label={t('activity.manualImport.folder')} value={folder} onChange={onFolder} placeholder="/downloads/complete" pickerTitle={t('activity.manualImport.chooseAFolderToImport')} />
      </Field>
      <section className="al-mi-section">
        <SectionLabel as="h3">{t('activity.manualImport.fromTheQueue')}</SectionLabel>
        {queue.isPending ? (
          <Skeleton lines={3} />
        ) : candidates.length === 0 ? (
          <EmptyState title={t('activity.manualImport.noDownloadsWithFilesOn')} />
        ) : (
          <ul className="al-mi-list">
            {candidates.map((q) => {
              const chip = queueChip(q);
              return (
                <li key={q.id}>
                  <button type="button" className="al-mi-list__row" onClick={() => {
                      const audio = audioImportMode(q);
                      onChoose(audio ? { downloadId: q.downloadId, mediaType: audio } : { downloadId: q.downloadId });
                    }}>
                    <span className="al-mi-list__title">{q.title}</span>
                    {needsManualImport(q) ? <Chip tone="warn">{t('activity.manualImport.needsImport')}</Chip> : <StatusChip status={chip.status} cause={chip.cause} />}
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
      <Chip tone="accent">{t('activity.manualImport.mapped')}</Chip>
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
  { key: 'path', get header() { return t('common.file'); }, mono: true, cell: (r) => <span className="al-activity-break">{r.relativePath}</span> },
  { key: 'size', get header() { return t('common.size'); }, mono: true, align: 'right', width: '100px', cell: (r) => formatBytes(r.sizeBytes) },
  { key: 'quality', get header() { return t('common.quality'); }, mono: true, width: '140px', cell: (r) => r.quality.quality.name },
  { key: 'state', get header() { return t('activity.manualImport.mapping'); }, cell: (r) => <MappingChip row={r} /> },
];

function FilesStep({ rows }: { rows: ImportRow[] }) {
  const mapped = rows.filter((r) => rowProblems(r).length === 0).length;
  return (
    <div className="al-mi-step">
      <p className="al-activity-muted">
        <span className="al-num">{rows.length}</span> {t('activity.manualImport.filesFound')} <span className="al-num">{mapped}</span> {t('activity.manualImport.alreadyMappedMapTheRest')}
      </p>
      <Table caption={t('activity.manualImport.filesFound2')} columns={FILE_COLUMNS} rows={rows} rowKey={(r) => r.path} sortable={false} />
    </div>
  );
}

// ---- Mapping ------------------------------------------------------------------------------

const ep = (n: number) => `E${String(n).padStart(2, '0')}`;

function EpisodesPicker({ row, dispatch }: { row: ImportRow; dispatch: (a: RowAction) => void }) {
  const episodes = useEpisodes(row.seriesId!);
  const inSeason = (episodes.data ?? []).filter((e) => e.seasonNumber === row.seasonNumber).sort((a, b) => a.episodeNumber - b.episodeNumber);
  const chosen = new Set(row.episodeIds);
  if (row.seasonNumber === null) return <span className="al-activity-muted">{t('activity.manualImport.pickASeason')}</span>;
  const summary =
    row.episodeIds.length === 0
      ? t('activity.manualImport.choose')
      : inSeason
          .filter((e) => chosen.has(e.id))
          .map((e) => ep(e.episodeNumber))
          .join(', ') || t('activity.manualImport.episodeidscountSelected', { episodeIdsCount: row.episodeIds.length });
  return (
    <Popover
      width={280}
      label={t('activity.manualImport.episodesForName', { name: row.name })}
      trigger={(props) => (
        <Button {...props} size="sm" variant="secondary" aria-label={t('activity.manualImport.episodesForName', { name: row.name })}>
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
        {!episodes.isPending && inSeason.length === 0 ? <p className="al-activity-muted">{t('activity.manualImport.noEpisodesInThisSeason')}</p> : null}
      </div>
    </Popover>
  );
}

interface MappingContext {
  dispatch: (a: RowAction) => void;
  seriesList: readonly Series[];
  movieList: readonly Movie[];
  seriesOptions: EntityOption[];
  movieOptions: EntityOption[];
}

function mappingColumns({ dispatch, seriesList, movieList, seriesOptions, movieOptions }: MappingContext): Column<ImportRow>[] {
  const versionCol: Column<ImportRow>[] = [...seriesList, ...movieList].some((x) => (x.versions?.length ?? 0) > 0)
    ? [
        {
          key: 'version',
          header: t('common.version'),
          cell: (r) => (
            <VersionPicker
              tags={rowVersionTags(r, seriesList, movieList)}
              value={r.versionTag}
              label={t('activity.manualImport.versionForName', { name: r.name })}
              onChange={(versionTag) => dispatch({ type: 'version', path: r.path, versionTag })}
            />
          ),
        },
      ]
    : [];
  return [
    {
      key: 'file',
      header: t('common.file'),
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
      header: t('common.type'),
      cell: (r) => (
        <Select
          aria-label={t('activity.manualImport.typeForName', { name: r.name })}
          value={r.mediaType}
          onChange={(e) => dispatch({ type: 'mediaType', path: r.path, mediaType: e.currentTarget.value as MediaType })}
          options={[
            { value: 'series', label: t('common.episode') },
            { value: 'movie', label: t('common.movie') },
          ]}
        />
      ),
    },
    {
      key: 'target',
      header: t('activity.manualImport.seriesMovie'),
      cell: (r) =>
        r.mediaType === 'series' ? (
          <EntityPicker aria-label={t('activity.manualImport.seriesForName', { name: r.name })} options={seriesOptions} value={r.seriesId} onChange={(id) => dispatch({ type: 'series', path: r.path, seriesId: id })} />
        ) : (
          <EntityPicker aria-label={t('activity.manualImport.movieForName', { name: r.name })} options={movieOptions} value={r.movieId} onChange={(id) => dispatch({ type: 'movie', path: r.path, movieId: id })} />
        ),
    },
    {
      key: 'season',
      header: t('common.season'),
      cell: (r) => {
        if (r.mediaType !== 'series') return <span className="al-activity-muted">—</span>;
        const series = r.seriesId !== null ? seriesList.find((s) => s.id === r.seriesId) : undefined;
        return (
          <Select
            aria-label={t('activity.manualImport.seasonForName', { name: r.name })}
            value={r.seasonNumber?.toString() ?? ''}
            disabled={!series}
            onChange={(e) => dispatch({ type: 'season', path: r.path, seasonNumber: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
          >
            <option value="">—</option>
            {(series?.seasons ?? []).map((s) => (
              <option key={s.seasonNumber} value={s.seasonNumber}>
                {s.seasonNumber === 0 ? t('common.specials') : t('activity.manualImport.seasonSeasonnumber', { seasonNumber: s.seasonNumber })}
              </option>
            ))}
          </Select>
        );
      },
    },
    {
      key: 'episodes',
      header: t('common.episodes'),
      cell: (r) =>
        r.mediaType === 'series' && r.seriesId !== null ? <EpisodesPicker row={r} dispatch={dispatch} /> : <span className="al-activity-muted">—</span>,
    },
    ...versionCol,
    {
      key: 'quality',
      header: t('common.quality'),
      cell: (r) => (
        <Select
          aria-label={t('activity.manualImport.qualityForName', { name: r.name })}
          value={String(r.quality.quality.id)}
          onChange={(e) => dispatch({ type: 'quality', path: r.path, qualityId: Number(e.currentTarget.value) })}
          options={qualityOptions(r.mediaType).map((q) => ({ value: String(q.id), label: q.name }))}
        />
      ),
    },
    {
      key: 'languages',
      header: t('common.languages'),
      cell: (r) => (
        <Input
          aria-label={t('activity.manualImport.languagesForName', { name: r.name })}
          className="al-mi-small"
          defaultValue={r.languages.join(', ')}
          onBlur={(e) => dispatch({ type: 'languages', path: r.path, languages: parseLanguages(e.currentTarget.value) })}
        />
      ),
    },
    {
      key: 'group',
      header: t('common.group'),
      cell: (r) => (
        <Input
          aria-label={t('activity.manualImport.releaseGroupForName', { name: r.name })}
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
  const columns = mappingColumns({ dispatch, seriesList: series.data ?? [], movieList: movies.data ?? [], seriesOptions, movieOptions });
  const selected = new Set(rows.filter((r) => r.selected).map((r) => r.path));
  return (
    <Table
      caption={t('activity.manualImport.filesToImport')}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.path}
      rowLabel={(r) => t('activity.manualImport.importName', { name: r.name })}
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
        {t('common.import')} <span className="al-num">{count}</span> {t('activity.manualImport.filesIntoTheLibrary', { count })}
      </p>
      <Field label={t('activity.manualImport.importMode')} hint={current.hint}>
        <Segmented aria-label={t('activity.manualImport.importMode')} variant="soft" value={mode} onChange={onMode} options={MODE_OPTIONS.map(({ value, label }) => ({ value, label }))} />
      </Field>
      {error ? (
        <ErrorBlock title={t('activity.manualImport.importFailed')}>{errorMessage(error)}</ErrorBlock>
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
    get header() {
      return t('activity.manualImport.result');
    },
    width: '220px',
    cell: (r) => (r.ok ? <StatusChip status="downloaded" label={t('common.imported')} /> : <StatusChip status="failed" cause={r.detail.toLowerCase().replace(/[.\s]+$/, '').slice(0, 40)} />),
  },
  { key: 'path', get header() { return t('common.file'); }, mono: true, cell: (r) => <span className="al-activity-break">{r.path}</span> },
  { key: 'detail', get header() { return t('activity.manualImport.destinationError'); }, mono: true, muted: true, cell: (r) => <span className="al-activity-break">{r.detail}</span> },
];

export function ResultsView({ result }: { result: ManualImportResult }) {
  const rows: ResultRow[] = [
    ...result.imported.map((i) => ({ path: i.path, ok: true, detail: i.destination })),
    ...result.failed.map((f) => ({ path: f.path, ok: false, detail: f.error })),
  ];
  return (
    <div className="al-mi-step">
      <p>
        {t('common.imported')} <span className="al-num">{result.imported.length}</span>{t('activity.manualImport.failed')} <span className="al-num">{result.failed.length}</span>.
      </p>
      <Table caption={t('activity.manualImport.importResults')} columns={RESULT_COLUMNS} rows={rows} rowKey={(r) => `${r.ok}-${r.path}`} sortable={false} />
    </div>
  );
}

// ---- page ---------------------------------------------------------------------------------

export function ManualImportPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const books = toAudiobookImportQuery(search);
  if (books) {
    const label = search.folder ?? t('activity.manualImport.downloadDownloadid', { downloadId: search.downloadId ?? '' });
    return <AudiobookImportWizard key={JSON.stringify(books)} query={books} sourceLabel={label} onStartOver={() => void navigate({ search: {} })} />;
  }
  const audio = toAudioImportQuery(search);
  if (audio) {
    const label = search.folder ?? t('activity.manualImport.downloadDownloadid', { downloadId: search.downloadId ?? '' });
    return <AudioImportWizard key={JSON.stringify(audio)} query={audio} sourceLabel={label} onStartOver={() => void navigate({ search: {} })} />;
  }
  return <VideoManualImport />;
}

function VideoManualImport() {
  useDocumentTitle(t('activity.manualImport.documentTitle'));
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [kind, setKind] = useState<SourceKind>('video');
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
    meta: { errorTitle: t('activity.manualImport.manualImportFailed'), silent: true },
    onSuccess: async () => {
      setStep('results');
      await Promise.all([qc.invalidateQueries({ queryKey: ['queue'] }), qc.invalidateQueries({ queryKey: ['history'] }), qc.invalidateQueries({ queryKey: ['library'] })]);
    },
  });

  const chosen = selectedCount(rows);
  const sourceLabel = search.folder ?? (search.downloadId ? t('activity.manualImport.downloadDownloadid', { downloadId: search.downloadId }) : search.seriesId !== undefined ? t('activity.manualImport.seriesFolder') : search.movieId !== undefined ? t('activity.manualImport.movieFolder') : null);
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
  let continueLabel = t('activity.manualImport.continue');
  if (step === 'path') {
    body = <PathStep folder={folder} onFolder={setFolder} onChoose={(s) => void navigate({ search: s })} kind={kind} onKind={setKind} />;
    canContinue = folder.trim() !== '';
    onContinue = () => void navigate({ search: kind === 'video' ? { folder: folder.trim() } : { folder: folder.trim(), mediaType: kind } });
  } else if (step === 'files' || step === 'mapping') {
    if (files.isPending) body = <Skeleton lines={5} />;
    else if (files.isError)
      body = (
        <ErrorBlock title={t('activity.manualImport.couldntListFiles')} onRetry={() => void files.refetch()}>
          {errorMessage(files.error)}
        </ErrorBlock>
      );
    else if (rows.length === 0)
      body = <EmptyState title={t('activity.manualImport.noImportableFilesFound')}>{t('activity.manualImport.nothingUnderThisSourceLooks')}</EmptyState>;
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
    continueLabel = t('activity.manualImport.importFiles', { chosen });
    onContinue = () => run.mutate();
  } else {
    body = run.data ? <ResultsView result={run.data} /> : null;
  }

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title={t('common.manualImport')}
        subtitle={sourceLabel ? <span className="al-num al-activity-break">{sourceLabel}</span> : t('activity.manualImport.chooseFilesMapThemTo')}
        actions={
          <Link className={buttonClass({ variant: 'secondary', size: 'md' })} to="/activity/queue">
            {t('activity.manualImport.backToQueue')}
          </Link>
        }
      />
      <Pane chamfer="tl" bare className="al-mi-wizard">
        <div className="al-mi-wizard__head">
          <Stepper aria-label={t('activity.manualImport.manualImportSteps')} steps={WIZARD_STEPS} current={index} onStepClick={step === 'results' ? undefined : (i) => goTo(WIZARD_STEPS[i]!.id)} />
          {step === 'mapping' ? (
            <span className="al-activity-muted">
              <span className="al-num">{chosen}</span> {t('common.of')} <span className="al-num">{rows.length}</span> {t('activity.manualImport.selected')}
            </span>
          ) : null}
        </div>
        <div className="al-mi-wizard__body">{body}</div>
        <footer className="al-mi-wizard__foot">
          {step === 'results' ? (
            <>
              <Button variant="ghost" onClick={startOver}>
                {t('activity.manualImport.startOver')}
              </Button>
              <span className="al-activity-spacer" />
              <Button variant="secondary" onClick={() => void files.refetch().then(() => setStep('files'))}>
                {t('activity.manualImport.importMoreFromThisSource')}
              </Button>
              <Link className={buttonClass({ variant: 'primary', size: 'md' })} to="/activity/queue">
                {t('activity.manualImport.goToQueue')}
              </Link>
            </>
          ) : (
            <>
              {index > 0 ? (
                <Button variant="ghost" onClick={() => goTo(WIZARD_STEPS[index - 1]!.id)}>
                  {t('activity.manualImport.back')}
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
