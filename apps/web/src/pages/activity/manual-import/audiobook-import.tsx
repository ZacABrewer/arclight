import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { matchesListSearch, type AudioManualImportResult, type ImportMode } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import type { AudiobookManualImportQuery } from '../../../api/audiobook-acquisition.js';
import {
  Button,
  buttonClass,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  PageHeader,
  Pane,
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
import { useAuthorBooks, useAuthorList } from '../../../hooks/audiobooks.js';
import { useAudiobookImport, useAudiobookImportScan } from '../../../hooks/audiobook-acquisition.js';
import { formatDuration } from '../../library/music/music-model.js';
import { AudiobookChip } from '../../library/audiobooks/audiobook-kit.js';
import { formatBytes, useDocumentTitle } from '../activity-shared.js';
import { confidenceText, confidenceTone } from './audio-mapping.js';
import {
  bookGroupProblems,
  bookImportableCount,
  bookReducer,
  includedDurationMs,
  initBookState,
  partNumbers,
  toBookImportRequest,
  type BookAction,
  type BookFileRow,
  type BookGroupState,
} from './audiobook-mapping.js';
import { t } from '../../../i18n/index.js';

// Manual import, audiobook mode: scan a folder (or a download) for audiobooks, review the book
// proposed for every folder and the order of its parts, fix what the matcher got wrong, import.

const STEPS = [
  { id: 'path', get label() { return t('common.path'); } },
  { id: 'files', get label() { return t('common.files'); } },
  { id: 'mapping', get label() { return t('activity.manualImport.mapping'); } },
  { id: 'mode', get label() { return t('common.mode'); } },
  { id: 'results', get label() { return t('common.results'); } },
] as const;
type Step = (typeof STEPS)[number]['id'];

const MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
  { value: 'auto', get label() { return t('activity.manualImport.auto'); } },
  { value: 'move', get label() { return t('activity.manualImport.move'); } },
  { value: 'copy', get label() { return t('activity.manualImport.copyOrHardlink'); } },
];

function ConfidenceChip({ value }: { value: number | null }) {
  return (
    <Chip tone={confidenceTone(value)} dot="none" data-testid="confidence">
      {confidenceText(value)}
    </Chip>
  );
}

/** "9:58:00 of 10:00:00" for the group header. */
function durationLine(g: BookGroupState): string | null {
  const total = includedDurationMs(g);
  if (total === null) return null;
  return g.runtimeMs ? t('activity.manualImport.audiobook.durationOfRuntime', { duration: formatDuration(total), runtime: formatDuration(g.runtimeMs) }) : formatDuration(total);
}

function GroupSummary({ group }: { group: BookGroupState }) {
  const authors = useAuthorList();
  const books = useAuthorBooks(group.authorId);
  const author = authors.data?.find((a) => a.id === group.authorId)?.name;
  const title = group.bookTitle ?? books.data?.find((b) => b.id === group.bookId)?.title;
  return (
    <li className="al-mi-audio-summary">
      <span className="al-mi-list__title al-num">{group.folder || '—'}</span>
      <span className="al-activity-muted">
        {author && title ? t('activity.audiobook.authorTitle', { author, title }) : (author ?? t('activity.manualImport.audio.notMatched'))}
      </span>
      <span className="al-chip-row">
        <ConfidenceChip value={group.confidence} />
        <Chip tone="neutral" dot="none">
          {t('activity.manualImport.audiobook.partCount', { count: group.files.length })}
        </Chip>
      </span>
    </li>
  );
}

function FilesStep({ groups, shown, toolbar, empty }: { groups: BookGroupState[]; shown: BookGroupState[]; toolbar?: ReactNode; empty?: ReactNode }) {
  const files = groups.reduce((n, g) => n + g.files.length, 0);
  const matched = groups.filter((g) => g.bookId !== null).length;
  return (
    <div className="al-mi-step">
      <p className="al-activity-muted">{t('activity.manualImport.audiobook.foundSummary', { files, books: groups.length, matched })}</p>
      {toolbar}
      {shown.length ? (
        <ul className="al-mi-list" aria-label={t('activity.manualImport.audiobook.booksFound')}>
          {shown.map((g) => (
            <GroupSummary key={g.key} group={g} />
          ))}
        </ul>
      ) : (
        empty
      )}
    </div>
  );
}

function GroupMapping({ group, dispatch }: { group: BookGroupState; dispatch: (a: BookAction) => void }) {
  const authors = useAuthorList();
  const books = useAuthorBooks(group.authorId);
  const authorOptions = useMemo(
    () => (authors.data ?? []).map((a) => ({ id: a.id, label: a.name })).sort((a, b) => a.label.localeCompare(b.label)),
    [authors.data],
  );
  const parts = partNumbers(group);
  const problems = bookGroupProblems(group);
  const name = group.folder || group.key;
  const duration = durationLine(group);
  const last = group.files.length - 1;

  const columns: Column<BookFileRow>[] = [
    {
      key: 'include',
      header: <span className="al-sr-only">{t('activity.manualImport.audiobook.include')}</span>,
      width: '44px',
      cell: (f) => (
        <Checkbox
          aria-label={t('activity.manualImport.audiobook.includeFile', { name: f.relativePath })}
          checked={f.included}
          onChange={(e) => dispatch({ type: 'include', key: group.key, path: f.path, included: e.currentTarget.checked })}
        />
      ),
    },
    {
      key: 'part',
      header: t('activity.manualImport.audiobook.part'),
      mono: true,
      width: '64px',
      cell: (f) => {
        const n = parts.get(f.path);
        return n == null ? <span className="al-activity-muted">—</span> : String(n).padStart(2, '0');
      },
    },
    {
      key: 'file',
      header: t('common.file'),
      cell: (f) => (
        <div className="al-activity-title">
          <span className="al-activity-title__main al-num" title={f.relativePath}>
            {f.relativePath}
          </span>
          <span className="al-activity-title__sub al-num">
            {[formatBytes(f.sizeBytes), f.durationMs ? formatDuration(f.durationMs) : null, f.tagTitle, ...f.rejections, ...f.warnings].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    { key: 'quality', header: t('common.quality'), mono: true, width: '110px', cell: (f) => f.qualityName ?? '—' },
    {
      key: 'order',
      header: <span className="al-sr-only">{t('activity.manualImport.audiobook.order')}</span>,
      align: 'right',
      width: '96px',
      cell: (f) => {
        const i = group.files.indexOf(f);
        return (
          <span className="mk-row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            <Button size="sm" variant="ghost" disabled={i === 0} aria-label={t('activity.manualImport.audiobook.moveUp', { name: f.relativePath })} onClick={() => dispatch({ type: 'move', key: group.key, path: f.path, by: -1 })}>
              ↑
            </Button>
            <Button size="sm" variant="ghost" disabled={i === last} aria-label={t('activity.manualImport.audiobook.moveDown', { name: f.relativePath })} onClick={() => dispatch({ type: 'move', key: group.key, path: f.path, by: 1 })}>
              ↓
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <section className="al-mi-audio-group" aria-label={t('activity.manualImport.audiobook.groupLabel', { name })}>
      <header className="al-mi-audio-group__head">
        <span className="al-mi-list__title al-num al-activity-break">{name}</span>
        <ConfidenceChip value={group.confidence} />
        {duration ? <span className="al-activity-muted al-num">{duration}</span> : null}
        {problems.map((p) => (
          <Chip key={p} tone="warn">
            {p}
          </Chip>
        ))}
      </header>
      <div className="al-mi-audio-pickers">
        <Field label={t('audiobooks.author')}>
          <EntityPicker
            aria-label={t('activity.manualImport.audiobook.authorFor', { name })}
            options={authorOptions}
            value={group.authorId}
            onChange={(id) => dispatch({ type: 'author', key: group.key, authorId: id })}
          />
        </Field>
        <Field label={t('audiobooks.book')}>
          <Select
            aria-label={t('activity.manualImport.audiobook.bookFor', { name })}
            value={group.bookId?.toString() ?? ''}
            disabled={group.authorId === null}
            onChange={(e) => dispatch({ type: 'book', key: group.key, bookId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
          >
            <option value="">{t('activity.manualImport.audiobook.chooseBook')}</option>
            {group.bookId !== null && !(books.data ?? []).some((b) => b.id === group.bookId) ? <option value={group.bookId}>{group.bookTitle ?? `#${group.bookId}`}</option> : null}
            {(books.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.year ? `${b.title} (${b.year})` : b.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Table caption={t('activity.manualImport.audiobook.partOrder', { name })} columns={columns} rows={group.files} rowKey={(f) => f.path} sortable={false} density="dense" />
    </section>
  );
}

function Results({ result }: { result: AudioManualImportResult }) {
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

/** The audiobook wizard for a chosen source (folder or download). `onStartOver` goes back to the path step. */
export function AudiobookImportWizard({ query, sourceLabel, onStartOver }: { query: AudiobookManualImportQuery; sourceLabel: string; onStartOver: () => void }) {
  useDocumentTitle(t('activity.manualImport.documentTitle'));
  const scan = useAudiobookImportScan(query);
  const run = useAudiobookImport();
  const [state, dispatch] = useReducer(bookReducer, { groups: [] });
  const [step, setStep] = useState<Step>('files');
  const [mode, setMode] = useState<ImportMode>('auto');

  useEffect(() => {
    if (scan.data) dispatch({ type: 'reset', state: initBookState(scan.data) });
  }, [scan.data]);

  const count = bookImportableCount(state);
  const index = STEPS.findIndex((s) => s.id === step);
  // Book search: a book shows whole (its parts keep their order) when its folder, author, title
  // or any part's path, title tag, narrator, quality or rejection matches.
  const listSearch = useListSearch();
  const names = useAudioNames(
    [],
    state.groups.map((g) => g.authorId),
  );
  const shownGroups = listSearch.active
    ? state.groups.filter((g) =>
        matchesListSearch(listSearch.q, [
          g.folder,
          names.author(g.authorId),
          g.bookTitle,
          names.book(g.authorId, g.bookId),
          g.files.flatMap((f) => [f.relativePath, f.tagTitle, f.narrator, f.qualityName, ...f.rejections, ...f.warnings]),
        ]),
      )
    : state.groups;
  const toolbar = <ListSearchBar value={listSearch.q} onChange={listSearch.setQ} placeholder={t('listSearch.ph.files')} shown={shownGroups.length} total={state.groups.length} />;
  const noMatch = listSearch.active ? <ListSearchEmpty query={listSearch.q} onClear={listSearch.clear} /> : undefined;
  const goTo = (s: Step) => (s === 'path' ? onStartOver() : setStep(s));

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
    else
      body =
        step === 'files' ? (
          <FilesStep groups={state.groups} shown={shownGroups} toolbar={toolbar} empty={noMatch} />
        ) : (
          <div className="al-mi-step">
            {toolbar}
            {shownGroups.length ? shownGroups.map((g) => <GroupMapping key={g.key} group={g} dispatch={dispatch} />) : noMatch}
          </div>
        );
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
          <Segmented aria-label={t('activity.manualImport.importMode')} variant="soft" value={mode} onChange={setMode} options={MODES} />
        </Field>
        {run.error ? <ErrorBlock title={t('activity.manualImport.importFailed')}>{errorMessage(run.error)}</ErrorBlock> : null}
      </div>
    );
    canContinue = count > 0;
    continueLabel = t('activity.manualImport.importFiles', { chosen: count });
    onContinue = () => run.mutate(toBookImportRequest(state, mode), { onSuccess: () => setStep('results') });
  } else if (step === 'results') {
    body = run.data ? <Results result={run.data} /> : null;
  }

  return (
    <div className="al-activity">
      <PageHeader
        index="06"
        title={t('common.manualImport')}
        subtitle={<span className="al-num al-activity-break">{sourceLabel}</span>}
        actions={
          <>
            <AudiobookChip />
            <Link className={buttonClass({ variant: 'secondary', size: 'md' })} to="/activity/queue">
              {t('activity.manualImport.backToQueue')}
            </Link>
          </>
        }
      />
      <Pane chamfer="tl" bare className="al-mi-wizard">
        <div className="al-mi-wizard__head">
          <Stepper aria-label={t('activity.manualImport.manualImportSteps')} steps={STEPS} current={index} onStepClick={step === 'results' ? undefined : (i) => goTo(STEPS[i]!.id)} />
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
              <Button variant="ghost" onClick={() => goTo(STEPS[index - 1]!.id)}>
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
