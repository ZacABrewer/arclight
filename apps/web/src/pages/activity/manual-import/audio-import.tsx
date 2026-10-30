import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { matchesListSearch, type AudioManualImportQueryInput, type AudioManualImportResult, type ImportMode } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import {
  Button,
  buttonClass,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  PageHeader,
  Pane,
  SectionLabel,
  Segmented,
  Select,
  Skeleton,
  StatusChip,
  Stepper,
  Table,
  type Column,
} from '../../../arclight/index.js';
import { EntityPicker } from '../../../components/entity-picker.js';
import { ListSearchBar, ListSearchEmpty, useListSearch } from '../../../components/list-search.js';
import { useAudioNames } from '../audio-names.js';
import { formatDuration } from '../../library/music/music-model.js';
import { useAlbum, useArtistAlbums, useArtistList, useUpdateAlbum } from '../../../hooks/music.js';
import { useAudioImport, useAudioImportScan } from '../../../hooks/music-acquisition.js';
import { formatBytes, useDocumentTitle } from '../activity-shared.js';
import {
  audioReducer,
  confidenceText,
  confidenceTone,
  duplicateTracks,
  groupProblems,
  importableCount,
  initAudioState,
  isMapped,
  toAudioImportRequest,
  trackOptions,
  unmatchedFiles,
  type AudioAction,
  type AudioFileRow,
  type AudioGroupState,
  type TrackOption,
} from './audio-mapping.js';
import { t } from '../../../i18n/index.js';

// Manual import, audio mode: scan a folder (or a download) for music, review the proposed
// artist, album, edition and track of every file, fix what the matcher got wrong, import.

export const AUDIO_STEPS = [
  { id: 'path', get label() { return t('common.path'); } },
  { id: 'files', get label() { return t('common.files'); } },
  { id: 'mapping', get label() { return t('activity.manualImport.mapping'); } },
  { id: 'mode', get label() { return t('common.mode'); } },
  { id: 'results', get label() { return t('common.results'); } },
] as const;
type AudioStep = (typeof AUDIO_STEPS)[number]['id'];

function ConfidenceChip({ value }: { value: number | null }) {
  return (
    <Chip tone={confidenceTone(value)} dot="none" data-testid="confidence">
      {confidenceText(value)}
    </Chip>
  );
}

// ---- Files: what the scan found ------------------------------------------------------------

function GroupSummary({ group }: { group: AudioGroupState }) {
  const artists = useArtistList();
  const albums = useArtistAlbums(group.artistId);
  const artist = artists.data?.find((a) => a.id === group.artistId)?.name;
  const album = albums.data?.find((a) => a.id === group.albumId)?.title;
  const unmatched = unmatchedFiles(group).length;
  return (
    <li className="al-mi-audio-summary">
      <span className="al-mi-list__title al-num">{group.folder || '—'}</span>
      <span className="al-activity-muted">
        {artist && album ? t('activity.music.artistAlbum', { artist, album }) : (artist ?? t('activity.manualImport.audio.notMatched'))}
      </span>
      <span className="al-chip-row">
        <ConfidenceChip value={group.confidence} />
        <Chip tone="neutral" dot="none">
          {t('activity.manualImport.audio.fileCount', { count: group.files.length })}
        </Chip>
        {unmatched ? <Chip tone="warn">{t('activity.manualImport.audio.unmatchedCount', { count: unmatched })}</Chip> : null}
      </span>
    </li>
  );
}

function UnmatchedList({ files }: { files: AudioFileRow[] }) {
  if (files.length === 0) return null;
  return (
    <section className="al-mi-section" aria-label={t('activity.manualImport.audio.unmatchedFiles')}>
      <SectionLabel as="h3" count={files.length}>
        {t('activity.manualImport.audio.unmatchedFiles')}
      </SectionLabel>
      <p className="al-activity-muted">{t('activity.manualImport.audio.unmatchedHint')}</p>
      <ul className="al-mi-list">
        {files.map((f) => (
          <li key={f.path} className="al-mi-audio-stray al-num al-activity-break">
            {f.relativePath}
            {f.rejections.length ? <span className="al-activity-muted"> · {f.rejections.join('; ')}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A search's view of the groups: the matching files of each group with any (all when blank). */
export interface AudioSearchView {
  toolbar?: ReactNode;
  /** Matching files per group key; groups without an entry are hidden. */
  visible: Map<string, AudioFileRow[]>;
  empty?: ReactNode;
}

function AudioFilesStep({ groups, view }: { groups: AudioGroupState[]; view?: AudioSearchView | undefined }) {
  const files = groups.reduce((n, g) => n + g.files.length, 0);
  const mapped = groups.reduce((n, g) => n + g.files.filter(isMapped).length, 0);
  const shown = view ? groups.filter((g) => view.visible.has(g.key)) : groups;
  const unmatched = view ? shown.flatMap((g) => unmatchedFiles({ ...g, files: view.visible.get(g.key) ?? [] })) : groups.flatMap(unmatchedFiles);
  return (
    <div className="al-mi-step">
      <p className="al-activity-muted">
        {t('activity.manualImport.audio.foundSummary', { files, albums: groups.length, mapped })}
      </p>
      {view?.toolbar}
      {shown.length ? (
        <ul className="al-mi-list" aria-label={t('activity.manualImport.audio.albumsFound')}>
          {shown.map((g) => (
            <GroupSummary key={g.key} group={g} />
          ))}
        </ul>
      ) : (
        view?.empty
      )}
      <UnmatchedList files={unmatched} />
    </div>
  );
}

// ---- Mapping: artist / album / release pickers and the track table ------------------------

/** `files`: the rows the track table shows (a search's matches); the whole group otherwise. */
function GroupMapping({ group, dispatch, files }: { group: AudioGroupState; dispatch: (a: AudioAction) => void; files?: AudioFileRow[] | undefined }) {
  const artists = useArtistList();
  const albums = useArtistAlbums(group.artistId);
  const album = useAlbum(group.albumId ?? 0);
  const update = useUpdateAlbum();
  const artistOptions = useMemo(
    () => (artists.data ?? []).map((a) => ({ id: a.id, label: a.name, detail: a.disambiguation ?? undefined })).sort((a, b) => a.label.localeCompare(b.label)),
    [artists.data],
  );
  const details = group.albumId !== null && album.data?.id === group.albumId ? album.data : undefined;
  // Only tracks of the album's selected edition can be imported to (a just-switched edition
  // lists none until its tracks have loaded).
  const options = useMemo(
    () => (details ? trackOptions(details.tracks.filter((tr) => tr.albumReleaseId === details.selectedReleaseId)) : []),
    [details],
  );
  const byId = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  useEffect(() => {
    if (options.length) dispatch({ type: 'resolve', key: group.key, tracks: options });
  }, [options, group.key, dispatch]);
  const dup = duplicateTracks(group);
  const problems = groupProblems(group);
  const name = group.folder || group.key;

  const columns: Column<AudioFileRow>[] = [
    {
      key: 'file',
      header: t('common.file'),
      cell: (f) => (
        <div className="al-activity-title">
          <span className="al-activity-title__main al-num" title={f.relativePath}>
            {f.relativePath}
          </span>
          <span className="al-activity-title__sub al-num">
            {[formatBytes(f.sizeBytes), f.durationMs ? formatDuration(f.durationMs) : null, f.tagTitle].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'track',
      header: t('music.discTrack'),
      cell: (f) => (
        <Select
          aria-label={t('activity.manualImport.audio.trackFor', { name: f.relativePath })}
          value={f.trackId !== null ? String(f.trackId) : ''}
          disabled={!details}
          invalid={f.trackId !== null && dup.has(f.trackId) ? true : undefined}
          onChange={(e) => {
            const o = byId.get(e.currentTarget.value);
            dispatch({ type: 'track', key: group.key, path: f.path, discNumber: o?.discNumber ?? null, trackNumber: o?.trackNumber ?? null, trackId: o?.trackId ?? null });
          }}
        >
          <option value="">{t('activity.manualImport.audio.notImported')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ),
    },
    {
      key: 'confidence',
      header: t('activity.manualImport.audio.confidence'),
      width: '120px',
      cell: (f) =>
        f.trackId !== null ? (
          dup.has(f.trackId) ? (
            <Chip tone="danger">{t('activity.manualImport.audio.duplicate')}</Chip>
          ) : (
            <ConfidenceChip value={f.confidence} />
          )
        ) : (
          <Chip tone="warn">{t('activity.manualImport.audio.unmatched')}</Chip>
        ),
    },
    { key: 'quality', header: t('common.quality'), mono: true, width: '120px', cell: (f) => f.qualityName ?? '—' },
  ];

  return (
    <section className="al-mi-audio-group" aria-label={t('activity.manualImport.audio.groupLabel', { name })}>
      <header className="al-mi-audio-group__head">
        <span className="al-mi-list__title al-num al-activity-break">{name}</span>
        <ConfidenceChip value={group.confidence} />
        {problems.map((p) => (
          <Chip key={p} tone="warn">
            {p}
          </Chip>
        ))}
      </header>
      <div className="al-mi-audio-pickers">
        <Field label={t('music.artist')}>
          <EntityPicker
            aria-label={t('activity.manualImport.audio.artistFor', { name })}
            options={artistOptions}
            value={group.artistId}
            onChange={(id) => dispatch({ type: 'artist', key: group.key, artistId: id })}
          />
        </Field>
        <Field label={t('music.album')}>
          <Select
            aria-label={t('activity.manualImport.audio.albumFor', { name })}
            value={group.albumId?.toString() ?? ''}
            disabled={group.artistId === null}
            onChange={(e) => dispatch({ type: 'album', key: group.key, albumId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
          >
            <option value="">{t('activity.manualImport.audio.chooseAlbum')}</option>
            {(albums.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.year ? `${a.title} (${a.year})` : a.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('music.edition')} hint={t('activity.manualImport.audio.editionHint')}>
          <Select
            aria-label={t('activity.manualImport.audio.releaseFor', { name })}
            value={details?.selectedReleaseId?.toString() ?? ''}
            disabled={!details || update.isPending}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              if (!details || !Number.isInteger(next) || next === details.selectedReleaseId) return;
              dispatch({ type: 'edition', key: group.key });
              update.mutate({ id: details.id, body: { selectedReleaseId: next } });
            }}
          >
            {details?.selectedReleaseId == null ? <option value="">{t('music.chooseAnEdition')}</option> : null}
            {(details?.releases ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {[r.title, r.country, r.date, r.formats.join(', '), t('music.trackCount', { count: r.trackCount })].filter(Boolean).join(' · ')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Table
        caption={t('activity.manualImport.audio.trackMapping', { name })}
        columns={columns}
        rows={files ?? group.files}
        rowKey={(f) => f.path}
        sortable={false}
        density="dense"
      />
    </section>
  );
}

function AudioMappingStep({ groups, dispatch, view }: { groups: AudioGroupState[]; dispatch: (a: AudioAction) => void; view?: AudioSearchView | undefined }) {
  const shown = view ? groups.filter((g) => view.visible.has(g.key)) : groups;
  return (
    <div className="al-mi-step">
      {view?.toolbar}
      {shown.length
        ? shown.map((g) => <GroupMapping key={g.key} group={g} dispatch={dispatch} files={view?.visible.get(g.key)} />)
        : view?.empty}
    </div>
  );
}

// ---- Mode and results -----------------------------------------------------------------------

function AudioResults({ result }: { result: AudioManualImportResult }) {
  const rows = [
    ...result.imported.map((i) => ({ path: i.path, ok: true, detail: i.destination })),
    ...result.failed.map((f) => ({ path: f.path, ok: false, detail: f.error })),
  ];
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'status',
      header: t('activity.manualImport.result'),
      width: '200px',
      cell: (r) => (r.ok ? <StatusChip status="downloaded" label={t('common.imported')} /> : <StatusChip status="failed" cause={r.detail.toLowerCase().slice(0, 40)} />),
    },
    { key: 'path', header: t('common.file'), mono: true, cell: (r) => <span className="al-activity-break">{r.path}</span> },
    { key: 'detail', header: t('activity.manualImport.destinationError'), mono: true, muted: true, cell: (r) => <span className="al-activity-break">{r.detail}</span> },
  ];
  return (
    <div className="al-mi-step">
      <p>{t('activity.manualImport.audio.resultSummary', { imported: result.imported.length, failed: result.failed.length })}</p>
      <Table caption={t('activity.manualImport.importResults')} columns={columns} rows={rows} rowKey={(r) => `${r.ok}-${r.path}`} sortable={false} />
    </div>
  );
}

const AUDIO_MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
  { value: 'auto', get label() { return t('activity.manualImport.auto'); } },
  { value: 'move', get label() { return t('activity.manualImport.move'); } },
  { value: 'copy', get label() { return t('activity.manualImport.copyOrHardlink'); } },
];

// ---- wizard ---------------------------------------------------------------------------------

/** The audio wizard for a chosen source (folder or download). `onStartOver` goes back to the path step. */
export function AudioImportWizard({ query, sourceLabel, onStartOver }: { query: AudioManualImportQueryInput; sourceLabel: string; onStartOver: () => void }) {
  useDocumentTitle(t('activity.manualImport.documentTitle'));
  const scan = useAudioImportScan(query);
  const run = useAudioImport();
  const [state, dispatch] = useReducer(audioReducer, { groups: [] });
  const [step, setStep] = useState<AudioStep>('files');
  const [mode, setMode] = useState<ImportMode>('auto');

  useEffect(() => {
    if (scan.data) dispatch({ type: 'reset', state: initAudioState(scan.data) });
  }, [scan.data]);

  const count = importableCount(state);
  const index = AUDIO_STEPS.findIndex((s) => s.id === step);
  // File search: path, title tag, quality, rejections and the group's folder, artist and album.
  const listSearch = useListSearch();
  const names = useAudioNames(
    state.groups.map((g) => g.artistId),
    [],
  );
  const totalFiles = state.groups.reduce((n, g) => n + g.files.length, 0);
  let view: AudioSearchView | undefined;
  if (state.groups.length) {
    const visible = new Map<string, AudioFileRow[]>();
    let shown = 0;
    for (const g of state.groups) {
      const groupFields = [g.folder, names.artist(g.artistId), names.album(g.artistId, g.albumId)];
      const files = listSearch.active ? g.files.filter((f) => matchesListSearch(listSearch.q, [...groupFields, f.relativePath, f.tagTitle, f.qualityName, f.rejections, f.warnings])) : g.files;
      if (files.length || (!listSearch.active && g.files.length === 0)) visible.set(g.key, files);
      shown += files.length;
    }
    view = {
      visible,
      toolbar: <ListSearchBar value={listSearch.q} onChange={listSearch.setQ} placeholder={t('listSearch.ph.files')} shown={shown} total={totalFiles} />,
      empty: listSearch.active ? <ListSearchEmpty query={listSearch.q} onClear={listSearch.clear} /> : undefined,
    };
  }
  const goTo = (s: AudioStep) => (s === 'path' ? onStartOver() : setStep(s));

  let body: ReactNode;
  let canContinue = false;
  let onContinue: () => void = () => {};
  let continueLabel = t('activity.manualImport.continue');
  if (step === 'files' || step === 'mapping') {
    if (scan.isPending) body = <Skeleton lines={5} />;
    else if (scan.isError)
      body = (
        <ErrorBlock title={t('activity.manualImport.couldntListFiles')} onRetry={() => void scan.refetch()}>
          {errorMessage(scan.error)}
        </ErrorBlock>
      );
    else if (state.groups.length === 0)
      body = <EmptyState title={t('activity.manualImport.audio.noAudioFound')}>{t('activity.manualImport.audio.noAudioFoundHint')}</EmptyState>;
    else body = step === 'files' ? <AudioFilesStep groups={state.groups} view={view} /> : <AudioMappingStep groups={state.groups} dispatch={dispatch} view={view} />;
    if (step === 'files') {
      canContinue = state.groups.length > 0;
      onContinue = () => setStep('mapping');
    } else {
      canContinue = count > 0;
      onContinue = () => setStep('mode');
    }
  } else if (step === 'mode') {
    body = (
      <div className="al-mi-step">
        <p>{t('activity.manualImport.audio.importCount', { count })}</p>
        <Field label={t('activity.manualImport.importMode')}>
          <Segmented aria-label={t('activity.manualImport.importMode')} variant="soft" value={mode} onChange={setMode} options={AUDIO_MODES} />
        </Field>
        {run.error ? <ErrorBlock title={t('activity.manualImport.importFailed')}>{errorMessage(run.error)}</ErrorBlock> : null}
      </div>
    );
    canContinue = count > 0;
    continueLabel = t('activity.manualImport.importFiles', { chosen: count });
    onContinue = () => run.mutate(toAudioImportRequest(state, mode), { onSuccess: () => setStep('results') });
  } else if (step === 'results') {
    body = run.data ? <AudioResults result={run.data} /> : null;
  }

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title={t('common.manualImport')}
        subtitle={<span className="al-num al-activity-break">{sourceLabel}</span>}
        actions={
          <>
            <Chip tone="neutral" dot="none" data-kind="music">
              {t('common.music')}
            </Chip>
            <Link className={buttonClass({ variant: 'secondary', size: 'md' })} to="/activity/queue">
              {t('activity.manualImport.backToQueue')}
            </Link>
          </>
        }
      />
      <Pane chamfer="tl" bare className="al-mi-wizard">
        <div className="al-mi-wizard__head">
          <Stepper aria-label={t('activity.manualImport.manualImportSteps')} steps={AUDIO_STEPS} current={index} onStepClick={step === 'results' ? undefined : (i) => goTo(AUDIO_STEPS[i]!.id)} />
          {step === 'mapping' ? <span className="al-activity-muted">{t('activity.manualImport.audio.importCount', { count })}</span> : null}
        </div>
        <div className="al-mi-wizard__body">{body}</div>
        <footer className="al-mi-wizard__foot">
          {step === 'results' ? (
            <>
              <Button variant="ghost" onClick={onStartOver}>
                {t('activity.manualImport.startOver')}
              </Button>
              <span className="al-activity-spacer" />
              <Link className={buttonClass({ variant: 'primary', size: 'md' })} to="/activity/queue">
                {t('activity.manualImport.goToQueue')}
              </Link>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => goTo(AUDIO_STEPS[index - 1]!.id)}>
                {t('activity.manualImport.back')}
              </Button>
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
