import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { LibraryImportCandidate, LibraryImportMatch, LibraryImportMediaType, LibraryImportMode, LibraryImportScan } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import {
  Banner,
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  Input,
  Meter,
  Modal,
  PageHeader,
  Pane,
  Segmented,
  Select,
  Skeleton,
  buttonClass,
} from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { PathInput } from '../../../components/path-picker/index.js';
import { useAudiobookQualityProfiles } from '../../../hooks/audiobooks.js';
import { audiobookKeys } from '../../../hooks/audiobook-keys.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useLibraryImportLookup, useLibraryImportScan, useLibraryImportScans, useStartLibraryImport, useStartLibraryImportScan } from '../../../hooks/library-import.js';
import { useMusicQualityProfiles } from '../../../hooks/music.js';
import { musicKeys } from '../../../hooks/music-keys.js';
import { confidenceText, confidenceTone } from '../../activity/manual-import/audio-mapping.js';
import { AudiobookGate } from '../audiobooks/audiobook-kit.js';
import { MusicGate } from '../music/music-kit.js';
import { formatDuration } from '../music/music-model.js';
import {
  defaultSelection,
  effectiveMatch,
  filterCandidates,
  importable,
  isScanActive,
  matchLabel,
  progressPercent,
  progressText,
  searchTermFor,
  selectedImportable,
  toImportRequest,
  type CandidateFilter,
  type MatchOverrides,
} from './library-import-model.js';
import '../library.css';
import './library-import.css';
import { t } from '../../../i18n/index.js';

// Library → Audiobooks / Music → Import existing: pick a root folder (or a folder below one),
// scan it, review what was found with the proposed book / album for every folder, change the
// matches that are wrong, import the selection. One page, no tabs: the steps follow each other.

export function AudiobookLibraryImportPage() {
  return (
    <AudiobookGate>
      <LibraryImportPage mediaType="audiobook" />
    </AudiobookGate>
  );
}

export function MusicLibraryImportPage() {
  return (
    <MusicGate>
      <LibraryImportPage mediaType="music" />
    </MusicGate>
  );
}

function LibraryImportPage({ mediaType }: { mediaType: LibraryImportMediaType }) {
  const scans = useLibraryImportScans();
  const [scanId, setScanId] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const scan = useLibraryImportScan(scanId);
  const qc = useQueryClient();

  // Coming back to the page shows the latest scan of this media type.
  useEffect(() => {
    if (resumed || !scans.data) return;
    setResumed(true);
    const last = scans.data.find((s) => s.mediaType === mediaType);
    if (last) setScanId(last.id);
  }, [scans.data, resumed, mediaType]);

  // An import that finished changes the library: refetch its pages.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = scan.data?.status ?? null;
    if (lastStatus.current === 'importing' && status !== 'importing') void qc.invalidateQueries({ queryKey: mediaType === 'audiobook' ? audiobookKeys.all : musicKeys.all });
    lastStatus.current = status;
  }, [scan.data?.status, qc, mediaType]);

  const back = mediaType === 'audiobook' ? '/library/audiobooks' : '/library/music';
  const data = scan.data;
  return (
    <div className="lib-page li-page">
      <PageHeader
        index="01"
        title={mediaType === 'audiobook' ? t('libraryImport.titleAudiobooks') : t('libraryImport.titleMusic')}
        subtitle={data ? <span className="al-num li-break">{data.path}</span> : undefined}
        actions={
          <>
            {data && !isScanActive(data.status) ? (
              <Button variant="ghost" onClick={() => setScanId(null)}>
                {t('libraryImport.newScan')}
              </Button>
            ) : null}
            <Link to={back} className={buttonClass({ variant: 'secondary' })}>
              {t('libraryImport.backToLibrary')}
            </Link>
          </>
        }
      />
      {scanId === null ? (
        <ScanForm mediaType={mediaType} onStarted={setScanId} />
      ) : scan.isPending ? (
        <Skeleton lines={4} />
      ) : scan.isError ? (
        <ErrorBlock title={t('libraryImport.couldNotLoadScan')} onRetry={() => setScanId(null)}>
          {errorMessage(scan.error)}
        </ErrorBlock>
      ) : data ? (
        <ScanView key={data.id} scan={data} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------------------

function ScanForm({ mediaType, onStarted }: { mediaType: LibraryImportMediaType; onStarted: (id: string) => void }) {
  const roots = useRootFolders();
  const start = useStartLibraryImportScan();
  const list = useMemo(() => (roots.data ?? []).filter((r) => r.mediaType === mediaType), [roots.data, mediaType]);
  const [root, setRoot] = useState('');
  const [folder, setFolder] = useState('');
  useEffect(() => {
    if (!root && list[0]) setRoot(list[0].path);
  }, [list, root]);

  if (roots.isPending) return <Skeleton lines={3} />;
  if (list.length === 0) {
    return (
      <EmptyState title={t('libraryImport.noRootFolders')}>{mediaType === 'audiobook' ? t('libraryImport.noRootFoldersAudiobooks') : t('libraryImport.noRootFoldersMusic')}</EmptyState>
    );
  }
  const path = folder.trim() || root;
  return (
    <Pane title={t('libraryImport.folderStep')} className="li-form">
      <p className="li-muted">{mediaType === 'audiobook' ? t('libraryImport.introAudiobooks') : t('libraryImport.introMusic')}</p>
      <div className="li-form__fields">
        <Field label={t('libraryImport.rootFolder')}>
          <Select aria-label={t('libraryImport.rootFolder')} value={root} onChange={(e) => setRoot(e.currentTarget.value)} options={list.map((r) => ({ value: r.path, label: r.path }))} />
        </Field>
        <Field label={t('libraryImport.subFolder')} hint={t('libraryImport.subFolderHint')}>
          <PathInput aria-label={t('libraryImport.subFolder')} value={folder} onChange={setFolder} placeholder={root} pickerTitle={t('libraryImport.chooseFolder')} />
        </Field>
      </div>
      {start.error ? <ErrorBlock title={t('libraryImport.scanFailed')}>{errorMessage(start.error)}</ErrorBlock> : null}
      <div className="li-form__actions">
        <Button
          variant="primary"
          disabled={!root}
          loading={start.isPending}
          onClick={() => start.mutate({ mediaType, path, ...(folder.trim() ? { rootFolderPath: root } : {}) }, { onSuccess: (s) => onStarted(s.id) })}
        >
          {t('libraryImport.scan')}
        </Button>
      </div>
    </Pane>
  );
}

// ---------------------------------------------------------------------------------------
// Scan and review
// ---------------------------------------------------------------------------------------

const FILTERS: ReadonlyArray<{ value: CandidateFilter; label: string }> = [
  { value: 'all', get label() { return t('libraryImport.filter.all'); } },
  { value: 'matched', get label() { return t('libraryImport.filter.matched'); } },
  { value: 'unmatched', get label() { return t('libraryImport.filter.unmatched'); } },
  { value: 'warnings', get label() { return t('libraryImport.filter.warnings'); } },
  { value: 'imported', get label() { return t('libraryImport.filter.imported'); } },
  { value: 'failed', get label() { return t('libraryImport.filter.failed'); } },
];

const MODES: ReadonlyArray<{ value: LibraryImportMode; label: string }> = [
  { value: 'inPlace', get label() { return t('libraryImport.mode.inPlace'); } },
  { value: 'move', get label() { return t('libraryImport.mode.move'); } },
];

function ScanView({ scan }: { scan: LibraryImportScan }) {
  const active = isScanActive(scan.status);
  if (scan.status === 'failed') {
    return <ErrorBlock title={t('libraryImport.scanFailed')}>{scan.error ?? ''}</ErrorBlock>;
  }
  if (scan.status === 'scanning' || scan.status === 'matching') {
    return (
      <Pane className="li-progress" aria-live="polite">
        <Meter value={progressPercent(scan)} live label={t('libraryImport.scanProgress')} valueText={progressText(scan)} />
        <p className="li-muted">{t('libraryImport.scanRunning')}</p>
      </Pane>
    );
  }
  return (
    <>
      {active ? (
        <Pane className="li-progress" aria-live="polite">
          <Meter value={progressPercent(scan)} live label={t('libraryImport.importProgress')} valueText={progressText(scan)} />
        </Pane>
      ) : null}
      <Review scan={scan} />
    </>
  );
}

function Review({ scan }: { scan: LibraryImportScan }) {
  const audiobook = scan.mediaType === 'audiobook';
  const abProfiles = useAudiobookQualityProfiles(audiobook);
  const musicProfiles = useMusicQualityProfiles(!audiobook);
  const profiles = (audiobook ? abProfiles.data : musicProfiles.data) ?? [];
  const run = useStartLibraryImport();
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(scan.candidates));
  const [overrides, setOverrides] = useState<MatchOverrides>(new Map());
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [search, setSearch] = useState('');
  const [profileId, setProfileId] = useState<number | null>(null);
  const [mode, setMode] = useState<LibraryImportMode>('inPlace');
  const [picking, setPicking] = useState<LibraryImportCandidate | null>(null);
  useEffect(() => {
    if (profileId === null && profiles[0]) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  const rows = useMemo(() => filterCandidates(scan.candidates, filter, search, overrides), [scan.candidates, filter, search, overrides]);
  const chosen = selectedImportable(scan.candidates, selected, overrides);
  const busy = scan.status === 'importing' || run.isPending;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectVisible = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of rows) if (on && importable(c, overrides)) next.add(c.id);
      else if (!on) next.delete(c.id);
      return next;
    });
  const pick = (c: LibraryImportCandidate, m: LibraryImportMatch | null) => {
    setOverrides((prev) => new Map(prev).set(c.id, m));
    toggle(c.id, m !== null);
    setPicking(null);
  };

  const s = scan.stats;
  if (scan.candidates.length === 0) {
    return (
      <EmptyState title={t('libraryImport.nothingToImport')}>
        {t('libraryImport.nothingToImportHint', { files: s.files, linked: s.alreadyInLibrary })}
      </EmptyState>
    );
  }
  return (
    <>
      <p className="li-summary">
        {t('libraryImport.summary', { candidates: s.candidates, files: s.files, linked: s.alreadyInLibrary })}
        {s.unreadable > 0 ? ` ${t('libraryImport.unreadableSummary', { count: s.unreadable })}` : ''}
        {s.imported > 0 || s.failed > 0 ? ` ${t('libraryImport.resultSummary', { imported: s.imported, failed: s.failed })}` : ''}
      </p>

      <div className="li-toolbar">
        <Select aria-label={t('libraryImport.filterLabel')} value={filter} onChange={(e) => setFilter(e.currentTarget.value as CandidateFilter)} options={FILTERS} />
        <Input type="search" className="li-toolbar__search" aria-label={t('libraryImport.searchLabel')} placeholder={t('libraryImport.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        <Button size="sm" variant="ghost" onClick={() => selectVisible(true)}>
          {t('libraryImport.selectAll')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => selectVisible(false)}>
          {t('libraryImport.selectNone')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t('libraryImport.noneMatchFilter')} />
      ) : (
        <ul className="li-list" aria-label={audiobook ? t('libraryImport.booksFound') : t('libraryImport.albumsFound')}>
          {rows.map((c) => (
            <CandidateRow
              key={c.id}
              candidate={c}
              match={effectiveMatch(c, overrides)}
              changed={overrides.has(c.id)}
              selected={selected.has(c.id)}
              disabled={busy || !importable(c, overrides)}
              onToggle={(on) => toggle(c.id, on)}
              onChange={() => setPicking(c)}
            />
          ))}
        </ul>
      )}

      <div className="li-footer">
        <Field label={t('libraryImport.qualityProfile')} hint={audiobook ? t('libraryImport.qualityProfileHintAudiobooks') : t('libraryImport.qualityProfileHintMusic')}>
          <Select
            aria-label={t('libraryImport.qualityProfile')}
            value={profileId?.toString() ?? ''}
            onChange={(e) => setProfileId(Number(e.currentTarget.value))}
            options={profiles.map((p) => ({ value: String(p.id), label: p.name }))}
          />
        </Field>
        <Field label={t('libraryImport.modeLabel')} hint={mode === 'inPlace' ? t('libraryImport.mode.inPlaceHint') : t('libraryImport.mode.moveHint')}>
          <Segmented aria-label={t('libraryImport.modeLabel')} variant="soft" value={mode} onChange={setMode} options={MODES} />
        </Field>
        {run.error ? <Banner tone="danger">{errorMessage(run.error)}</Banner> : null}
        <Button
          variant="primary"
          className="li-footer__go"
          disabled={busy || chosen.length === 0 || profileId === null}
          loading={busy}
          onClick={() => run.mutate(toImportRequest(scan, selected, overrides, { qualityProfileId: profileId!, mode }))}
        >
          {t('libraryImport.importSelected', { count: chosen.length })}
        </Button>
      </div>

      {picking ? <MatchPicker mediaType={scan.mediaType} candidate={picking} current={effectiveMatch(picking, overrides)} onPick={(m) => pick(picking, m)} onClose={() => setPicking(null)} /> : null}
    </>
  );
}

function Cover({ url, label }: { url: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="li-cover" aria-hidden="true">
      {url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="li-cover__blank">{label.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

function CandidateRow({
  candidate: c,
  match,
  changed,
  selected,
  disabled,
  onToggle,
  onChange,
}: {
  candidate: LibraryImportCandidate;
  match: LibraryImportMatch | null;
  changed: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onChange: () => void;
}) {
  const detected = [c.detected.author, c.detected.title].filter(Boolean).join(' – ');
  const meta = [
    t('libraryImport.fileCount', { count: c.files.length }),
    formatBytes(c.sizeBytes),
    c.durationMs ? formatDuration(c.durationMs) : null,
    c.detected.narrator ? t('libraryImport.narratedBy', { name: c.detected.narrator }) : null,
  ].filter(Boolean);
  const confidence = match ? (changed ? null : c.confidence) : null;
  return (
    <li className="li-row" data-status={c.status}>
      <span className="li-row__check">
        <Checkbox aria-label={t('libraryImport.selectRow', { name: c.relativeFolder })} checked={selected && !disabled} disabled={disabled} onChange={(e) => onToggle(e.currentTarget.checked)} />
      </span>
      <Cover url={match?.coverUrl ?? null} label={match?.title ?? c.relativeFolder} />
      <div className="li-row__source">
        <span className="li-row__folder al-num" title={c.folder}>
          {c.relativeFolder}
        </span>
        <span className="li-muted">{detected || t('libraryImport.nothingDetected')}</span>
        <details className="li-row__files">
          <summary className="li-muted al-num">{meta.join(' · ')}</summary>
          <ul>
            {c.files.map((f) => (
              <li key={f.path} className="al-num">
                {f.relativePath}
                {f.readable ? '' : ` (${t('libraryImport.unreadable')})`}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="li-row__match">
        {match ? (
          <>
            <span className="li-row__title">{matchLabel(match)}</span>
            <span className="li-chips">
              {confidence !== null ? (
                <Chip tone={confidenceTone(confidence)} dot="none" data-testid="confidence">
                  {confidenceText(confidence)}
                </Chip>
              ) : (
                <Chip tone="accent" dot="none">
                  {t('libraryImport.chosen')}
                </Chip>
              )}
              {match.inLibrary ? <Chip tone="neutral">{t('libraryImport.inLibrary')}</Chip> : null}
              {match.series ? <Chip tone="muted">{match.seriesPosition ? `${match.series} #${match.seriesPosition}` : match.series}</Chip> : null}
            </span>
          </>
        ) : (
          <span className="li-muted">{t('libraryImport.noMatch')}</span>
        )}
        {c.warnings.length > 0 ? (
          <ul className="li-warnings">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {c.status !== 'pending' ? (
          <span className="li-status" data-status={c.status}>
            {c.status === 'imported' ? t('libraryImport.status.imported') : c.status === 'failed' ? t('libraryImport.status.failed') : t('libraryImport.status.importing')}
            {c.message ? `: ${c.message}` : ''}
          </span>
        ) : null}
      </div>
      <div className="li-row__actions">
        <Button size="sm" variant="ghost" disabled={c.status === 'imported' || c.status === 'importing'} onClick={onChange}>
          {match ? t('libraryImport.change') : t('libraryImport.findMatch')}
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// Match picker
// ---------------------------------------------------------------------------------------

function MatchOption({ m, current, onPick }: { m: LibraryImportMatch; current: boolean; onPick: () => void }) {
  const details = [m.narrators.length ? t('libraryImport.narratedBy', { name: m.narrators.join(', ') }) : null, m.runtimeMinutes ? formatDuration(m.runtimeMinutes * 60_000) : null, m.albumType, m.subtitle].filter(Boolean);
  return (
    <li>
      <button type="button" className="li-option" aria-pressed={current} onClick={onPick}>
        <Cover url={m.coverUrl} label={m.title} />
        <span className="li-option__text">
          <span className="li-row__title">{matchLabel(m)}</span>
          {details.length > 0 ? <span className="li-muted">{details.join(' · ')}</span> : null}
          {m.inLibrary ? <span className="li-muted">{t('libraryImport.inLibrary')}</span> : null}
        </span>
      </button>
    </li>
  );
}

function MatchPicker({
  mediaType,
  candidate,
  current,
  onPick,
  onClose,
}: {
  mediaType: LibraryImportMediaType;
  candidate: LibraryImportCandidate;
  current: LibraryImportMatch | null;
  onPick: (m: LibraryImportMatch | null) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState(() => searchTermFor(candidate));
  const [query, setQuery] = useState(term);
  const results = useLibraryImportLookup(mediaType, query);
  const suggestions = [candidate.match, ...candidate.alternatives].filter((m): m is LibraryImportMatch => m !== null);
  const seen = new Set(suggestions.map((m) => m.foreignId));
  const found = (results.data ?? []).filter((m) => !seen.has(m.foreignId));
  return (
    <Modal
      open
      onClose={onClose}
      size={640}
      title={t('libraryImport.pickerTitle', { name: candidate.relativeFolder })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={() => onPick(null)}>
            {t('libraryImport.clearMatch')}
          </Button>
        </>
      }
    >
      <form
        className="li-picker__search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(term.trim());
        }}
      >
        <Input type="search" aria-label={t('libraryImport.pickerSearch')} placeholder={mediaType === 'audiobook' ? t('libraryImport.pickerPlaceholderAudiobooks') : t('libraryImport.pickerPlaceholderMusic')} value={term} onChange={(e) => setTerm(e.currentTarget.value)} />
        <Button type="submit" variant="secondary" loading={results.isFetching}>
          {t('common.search')}
        </Button>
      </form>
      {suggestions.length > 0 ? (
        <>
          <h3 className="li-picker__head">{t('libraryImport.suggestions')}</h3>
          <ul className="li-options">
            {suggestions.map((m) => (
              <MatchOption key={m.foreignId} m={m} current={current?.foreignId === m.foreignId} onPick={() => onPick(m)} />
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="li-picker__head">{t('libraryImport.searchResults')}</h3>
      {results.isError ? (
        <ErrorBlock title={t('libraryImport.searchFailed')}>{errorMessage(results.error)}</ErrorBlock>
      ) : results.isFetching && !results.data ? (
        <Skeleton lines={3} />
      ) : found.length === 0 ? (
        <p className="li-muted">{query ? t('libraryImport.noResults') : t('libraryImport.typeToSearch')}</p>
      ) : (
        <ul className="li-options">
          {found.map((m) => (
            <MatchOption key={m.foreignId} m={m} current={current?.foreignId === m.foreignId} onPick={() => onPick(m)} />
          ))}
        </ul>
      )}
    </Modal>
  );
}
