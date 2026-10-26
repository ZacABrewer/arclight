import { useMemo, useState } from 'react';
import type { Episode, MediaFileSubtitles, SubtitleLanguageRef, SubtitleSearchResult, SubtitleState } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import type { SubtitleScope } from '../../api/subtitles.js';
import {
  Accordion,
  AccordionItem,
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  Field,
  Icon,
  Modal,
  Pane,
  Select,
  Skeleton,
  Table,
  type Column,
} from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useToast } from '../../components/toast.js';
import {
  useBlacklistSubtitle,
  useDeleteSubtitle,
  useDownloadSubtitle,
  useExtractSubtitle,
  useLanguageProfiles,
  useManualSubtitleSearch,
  useMediaFileSubtitles,
  useScanSubtitles,
  useSubtitleLanguages,
  useSubtitleSearchCommand,
  useSyncSubtitle,
  useUploadSubtitle,
} from '../../hooks/subtitles.js';
import { PendingApiNotice } from '../settings/shared.js';
import { MissingChip, SubtitleChip, refLabel, useLanguageName } from './subtitle-ui.js';

// Per-item Subtitles tab for series and movie details (handoff §8): per media file, a table of
// languages (on disk, embedded, still missing) with Search / Upload / Delete / Sync actions.

/** Bitmap codecs cannot be extracted to a text file. */
const IMAGE_CODECS = new Set(['hdmv_pgs_subtitle', 'pgs', 'pgssub', 'dvd_subtitle', 'vobsub', 'dvdsub', 'dvb_subtitle', 'xsub']);

export function isExtractable(s: SubtitleState): boolean {
  return s.embedded && s.streamIndex !== null && !IMAGE_CODECS.has((s.codec ?? '').toLowerCase());
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** "S01E02-E03" for the file's episodes, falling back to the file name. */
export function fileLabel(file: MediaFileSubtitles, episodes: readonly Episode[] | undefined): string {
  if (file.mediaType === 'series' && episodes) {
    const eps = file.episodeIds
      .map((id) => episodes.find((e) => e.id === id))
      .filter((e): e is Episode => !!e)
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
    if (eps.length) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const first = eps[0]!;
      const code = `S${pad(first.seasonNumber)}${eps.map((e) => `E${pad(e.episodeNumber)}`).join('-')}`;
      return eps.length === 1 && first.title ? `${code} · ${first.title}` : code;
    }
  }
  return fileName(file.path);
}

/** One row of a file's language table. */
export type LanguageRow = { key: string; kind: 'external' | 'embedded'; subtitle: SubtitleState } | { key: string; kind: 'missing'; missing: SubtitleLanguageRef };

/** Present subtitles first (external, then embedded), then the languages still missing. */
export function languageRows(file: Pick<MediaFileSubtitles, 'subtitles' | 'missing'>): LanguageRow[] {
  const present = [...file.subtitles]
    .sort((a, b) => Number(a.embedded) - Number(b.embedded))
    .map((s): LanguageRow => ({ key: `s-${s.id}`, kind: s.embedded ? 'embedded' : 'external', subtitle: s }));
  const missing = file.missing.map((m): LanguageRow => ({ key: `m-${m.language}-${m.forced}-${m.hi}`, kind: 'missing', missing: m }));
  return [...present, ...missing];
}

export function SubtitlesTab({ scope, episodes }: { scope: { seriesId: number } | { movieId: number }; episodes?: readonly Episode[] | undefined }) {
  const files = useMediaFileSubtitles(scope);
  const scan = useScanSubtitles();
  const search = useSubtitleSearchCommand();
  const toast = useToast();
  const [manual, setManual] = useState<{ file: MediaFileSubtitles; label: string } | null>(null);
  const [upload, setUpload] = useState<{ file: MediaFileSubtitles; label: string } | null>(null);
  const pending = files.error instanceof ApiError && files.error.status === 404;

  const groups = useMemo(() => {
    const m = new Map<number | null, MediaFileSubtitles[]>();
    for (const f of files.data ?? []) {
      const key = f.mediaType === 'series' ? f.seasonNumber : null;
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()].sort(([a], [b]) => (b ?? -1) - (a ?? -1));
  }, [files.data]);

  if (pending) return <PendingApiNotice what="subtitles" />;
  if (files.isPending)
    return (
      <Pane>
        <Skeleton lines={3} />
      </Pane>
    );
  if (files.isError)
    return (
      <ErrorBlock title="Subtitles did not load" onRetry={() => void files.refetch()}>
        {errorMessage(files.error)}
      </ErrorBlock>
    );

  const notifySearch = (message: string) => toast.push({ tone: 'info', title: 'Subtitle search finished', message });
  const ctx: FileContext = {
    episodes,
    onManual: (file, label) => setManual({ file, label }),
    onUpload: (file, label) => setUpload({ file, label }),
    onSearch: (file) => search.mutate({ mediaFileId: file.mediaFileId }, { onSuccess: (r) => notifySearch(r.message) }),
    onRescan: (file) => scan.mutate({ mediaFileId: file.mediaFileId }),
    searching: search.isPending ? (search.variables.mediaFileId ?? null) : null,
  };

  const seasonLabel = (season: number) => (season === 0 ? 'Specials' : `Season ${season}`);

  return (
    <Pane
      title="Files"
      flush
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="search" />}
            loading={search.isPending && search.variables.mediaFileId === undefined}
            onClick={() => search.mutate(scope, { onSuccess: (r) => notifySearch(r.message) })}
          >
            Search all
          </Button>
          <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={scan.isPending} onClick={() => scan.mutate(scope as SubtitleScope)}>
            Rescan all
          </Button>
        </>
      }
    >
      {files.data.length === 0 ? (
        <EmptyState title="No files">Subtitles are tracked once a video file is imported.</EmptyState>
      ) : groups.length === 1 && groups[0]![0] === null ? (
        groups[0]![1].map((f) => <FileBlock key={f.mediaFileId} file={f} ctx={ctx} />)
      ) : (
        <Accordion className="sub-seasons">
          {groups.map(([season, list], i) => (
            <AccordionItem
              key={String(season)}
              title={season === null ? 'Files' : seasonLabel(season)}
              meta={
                <span className="al-num">
                  {list.length} {list.length === 1 ? 'file' : 'files'}
                </span>
              }
              defaultOpen={i === 0}
            >
              <section aria-label={season === null ? 'Files' : seasonLabel(season)}>
                {list.map((f) => (
                  <FileBlock key={f.mediaFileId} file={f} ctx={ctx} />
                ))}
              </section>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      {manual ? <ManualSearchModal file={manual.file} label={manual.label} onClose={() => setManual(null)} /> : null}
      {upload ? <UploadSubtitleModal file={upload.file} label={upload.label} onClose={() => setUpload(null)} /> : null}
    </Pane>
  );
}

interface FileContext {
  episodes: readonly Episode[] | undefined;
  onManual: (file: MediaFileSubtitles, label: string) => void;
  onUpload: (file: MediaFileSubtitles, label: string) => void;
  onSearch: (file: MediaFileSubtitles) => void;
  onRescan: (file: MediaFileSubtitles) => void;
  searching: number | null;
}

function FileBlock({ file, ctx }: { file: MediaFileSubtitles; ctx: FileContext }) {
  const label = fileLabel(file, ctx.episodes);
  const name = useLanguageName();
  const rows = languageRows(file);

  const columns: Column<LanguageRow>[] = [
    {
      key: 'language',
      header: 'Language',
      cell: (r) =>
        r.kind === 'missing' ? (
          <span className="sub-lang">
            <MissingChip refItem={r.missing} /> {refLabel(r.missing, name)}
          </span>
        ) : (
          <span className="sub-lang">
            <SubtitleChip subtitle={r.subtitle} /> {refLabel(r.subtitle, name)}
          </span>
        ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (r) =>
        r.kind === 'missing' ? (
          <Chip tone="warn">Missing</Chip>
        ) : r.kind === 'embedded' ? (
          <span className="sub-state">
            Embedded{r.subtitle.codec ? <span className="sub-code">{r.subtitle.codec}</span> : null}
          </span>
        ) : (
          <span className="sub-state">External</span>
        ),
    },
    { key: 'provider', header: 'Provider', muted: true, cell: (r) => (r.kind !== 'missing' && r.subtitle.provider) || '—' },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      mono: true,
      cell: (r) => (r.kind !== 'missing' && r.subtitle.percent !== null ? `${Math.round(r.subtitle.percent)}%` : '—'),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.kind === 'missing' ? (
          <span className="sub-actions">
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Search ${refLabel(r.missing, name)} subtitle for ${label}`}
              loading={ctx.searching === file.mediaFileId}
              onClick={() => ctx.onSearch(file)}
            >
              Search
            </Button>
          </span>
        ) : (
          <SubtitleActions subtitle={r.subtitle} />
        ),
    },
  ];

  return (
    <div className="sub-file" aria-label={label} role="group">
      <div className="sub-file__head">
        <div className="sub-file__name">
          <span className="sub-file__label">{label}</span>
          <span className="sub-file__path al-num" title={file.path}>
            {file.path}
          </span>
        </div>
        <div className="sub-actions">
          <Button size="sm" variant="secondary" icon={<Icon name="search" />} aria-label={`Search subtitles ${label}`} loading={ctx.searching === file.mediaFileId} onClick={() => ctx.onSearch(file)}>
            Search
          </Button>
          <Button size="sm" variant="secondary" aria-label={`Manual search ${label}`} onClick={() => ctx.onManual(file, label)}>
            Manual search
          </Button>
          <Button size="sm" variant="secondary" icon={<Icon name="upload" />} aria-label={`Upload subtitle ${label}`} onClick={() => ctx.onUpload(file, label)}>
            Upload
          </Button>
          <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} aria-label={`Rescan ${label}`} onClick={() => ctx.onRescan(file)}>
            Rescan
          </Button>
        </div>
      </div>
      <Table
        caption={`Subtitle languages for ${label}`}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        sortable={false}
        empty={<EmptyState title="No subtitles">This file has no subtitles and its language profile asks for none.</EmptyState>}
      />
    </div>
  );
}

/** Row actions for a present subtitle: Sync / Blacklist / Delete (external) or Extract (embedded text track). */
function SubtitleActions({ subtitle }: { subtitle: SubtitleState }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBlacklist, setConfirmBlacklist] = useState(false);
  const remove = useDeleteSubtitle();
  const sync = useSyncSubtitle();
  const blacklist = useBlacklistSubtitle();
  const extract = useExtractSubtitle();
  const toast = useToast();
  const name = useLanguageName();
  const label = refLabel(subtitle, name);

  if (subtitle.embedded) {
    return isExtractable(subtitle) ? (
      <span className="sub-actions">
        <Button size="sm" variant="secondary" aria-label={`Extract ${label} embedded subtitle`} loading={extract.isPending} onClick={() => extract.mutate(subtitle.id)}>
          Extract
        </Button>
      </span>
    ) : (
      <span className="sub-none">—</span>
    );
  }

  return (
    <span className="sub-actions">
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Sync ${label} subtitle`}
        loading={sync.isPending}
        onClick={() =>
          sync.mutate(subtitle.id, {
            onSuccess: (r) => toast.push({ tone: r.ok ? 'ok' : 'warning', title: r.ok ? 'Subtitle synced' : 'Sync failed', message: r.message }),
          })
        }
      >
        Sync
      </Button>
      {subtitle.provider ? (
        <Button size="sm" variant="ghost" aria-label={`Blacklist ${label} subtitle`} onClick={() => setConfirmBlacklist(true)}>
          Blacklist
        </Button>
      ) : null}
      <Button size="sm" variant="danger" aria-label={`Delete ${label} subtitle`} onClick={() => setConfirmDelete(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${label} subtitle?`}
        confirmLabel="Delete subtitle"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await remove.mutateAsync(subtitle.id);
          setConfirmDelete(false);
        }}
      >
        <p>
          The file <span className="al-num mt-break">{subtitle.path}</span> is removed from disk.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmBlacklist}
        title={`Blacklist ${label} subtitle?`}
        confirmLabel="Blacklist subtitle"
        onCancel={() => setConfirmBlacklist(false)}
        onConfirm={async () => {
          await blacklist.mutateAsync(subtitle.id);
          setConfirmBlacklist(false);
        }}
      >
        <p>The subtitle is deleted, never downloaded again from {subtitle.provider}, and a replacement is searched for.</p>
      </ConfirmDialog>
    </span>
  );
}

/** Languages a file's profile asks for (for the manual-search filter). */
function useProfileLanguages(profileId: number | null): string[] {
  const profiles = useLanguageProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  return [...new Set((profile?.languages ?? []).map((l) => l.code))];
}

export function ManualSearchModal({ file, label, onClose }: { file: MediaFileSubtitles; label: string; onClose: () => void }) {
  const [language, setLanguage] = useState('');
  const results = useManualSubtitleSearch(file.mediaFileId, language);
  const download = useDownloadSubtitle();
  const toast = useToast();
  const name = useLanguageName();
  const profileLanguages = useProfileLanguages(file.languageProfileId);
  const languageOptions = [...new Set([...profileLanguages, ...file.missing.map((m) => m.language)])];

  const columns: Column<SubtitleSearchResult>[] = [
    { key: 'provider', header: 'Provider', cell: (r) => r.provider },
    { key: 'language', header: 'Language', cell: (r) => name(r.language) },
    {
      key: 'flags',
      header: 'Flags',
      cell: (r) => (
        <span className="sub-chips">
          {r.forced ? <Chip tone="neutral">Forced</Chip> : null}
          {r.hi ? <Chip tone="neutral">HI</Chip> : null}
          {r.matches.includes('hash') ? <Chip tone="accent">Hash</Chip> : null}
        </span>
      ),
    },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      mono: true,
      sortValue: (r) => r.percent,
      cell: (r) => <span title={`${r.score} / ${r.scoreOutOf}`}>{Math.round(r.percent)}%</span>,
    },
    {
      key: 'release',
      header: 'Release',
      cell: (r) => (
        <span className="mt-break al-num" title={r.releaseInfo.join('\n')}>
          {r.releaseInfo[0] ?? '—'}
          {r.releaseInfo.length > 1 ? <span className="sub-none"> +{r.releaseInfo.length - 1}</span> : null}
        </span>
      ),
    },
    { key: 'uploader', header: 'Uploader', muted: true, cell: (r) => r.uploader ?? '—' },
    {
      key: 'matches',
      header: 'Matches',
      muted: true,
      cell: (r) => <span title={r.dontMatches.length ? `Does not match: ${r.dontMatches.join(', ')}` : undefined}>{r.matches.join(', ') || '—'}</span>,
    },
    {
      key: 'download',
      header: <span className="al-sr-only">Download</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="download" />}
          aria-label={`Download ${r.provider} ${r.language} ${r.providerSubtitleId}`}
          loading={download.isPending && download.variables.key === r.key}
          onClick={() =>
            download.mutate(
              { mediaFileId: file.mediaFileId, key: r.key },
              { onSuccess: () => toast.push({ tone: 'ok', title: `Downloaded ${name(r.language)} subtitle from ${r.provider}` }) },
            )
          }
        >
          Download
        </Button>
      ),
    },
  ];

  return (
    <Modal open onClose={onClose} size={1100} title={`Manual search · ${label}`}>
      <div className="sub-toolbar">
        <Field label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">All profile languages</option>
            {languageOptions.map((code) => (
              <option key={code} value={code}>
                {name(code)}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={results.isFetching} onClick={() => void results.refetch()}>
          Search again
        </Button>
      </div>
      {results.isPending ? (
        <Skeleton lines={4} />
      ) : results.isError ? (
        <ErrorBlock title="Subtitle search failed" onRetry={() => void results.refetch()}>
          {errorMessage(results.error)}
        </ErrorBlock>
      ) : (
        <>
          {results.data.allThrottled ? (
            <p className="sub-notice" role="status">
              Every provider is throttled right now. Try again later.
            </p>
          ) : null}
          {results.data.errors.length ? (
            <p className="sub-notice" role="status">
              {results.data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · ')}
            </p>
          ) : null}
          <Table
            caption="Subtitle candidates"
            columns={columns}
            rows={results.data.results}
            rowKey={(r) => r.key}
            defaultSort={{ key: 'score', direction: 'desc' }}
            empty={<EmptyState title="No subtitles found">No enabled provider returned a candidate.</EmptyState>}
          />
        </>
      )}
    </Modal>
  );
}

export function UploadSubtitleModal({ file, label, onClose }: { file: MediaFileSubtitles; label: string; onClose: () => void }) {
  const languages = useSubtitleLanguages();
  const upload = useUploadSubtitle();
  const toast = useToast();
  const profileLanguages = useProfileLanguages(file.languageProfileId);
  const [language, setLanguage] = useState(file.missing[0]?.language ?? profileLanguages[0] ?? '');
  const [forced, setForced] = useState(file.missing[0]?.forced ?? false);
  const [hi, setHi] = useState(file.missing[0]?.hi ?? false);
  const [picked, setPicked] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!picked) return setError('Choose a subtitle file');
    if (!language) return setError('Choose a language');
    setError(null);
    upload.mutate(
      { mediaFileId: file.mediaFileId, language, forced, hi, file: picked },
      {
        onSuccess: () => {
          toast.push({ tone: 'ok', title: 'Subtitle uploaded' });
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const options = [...(languages.data ?? [])];
  if (language && !options.some((o) => o.code === language)) options.unshift({ code: language, name: language });

  return (
    <Modal
      open
      onClose={onClose}
      size={560}
      title={`Upload subtitle · ${label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Icon name="upload" />} loading={upload.isPending} onClick={submit}>
            Upload
          </Button>
        </>
      }
    >
      <div className="sub-fields">
        <Field label="Subtitle file">
          <input className="sub-file-input" type="file" accept=".srt,.ass,.ssa,.vtt,.sub,.smi,.txt" onChange={(e) => setPicked(e.currentTarget.files?.[0] ?? null)} />
        </Field>
        <Field label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">Select a language…</option>
            {options.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="Forced" checked={forced} onChange={(e) => setForced(e.currentTarget.checked)} />
        <Checkbox label="Hearing impaired" checked={hi} onChange={(e) => setHi(e.currentTarget.checked)} />
      </div>
      {error ? (
        <p className="al-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
