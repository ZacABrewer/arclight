import { useMemo, useState } from 'react';
import type { Episode, MediaFileSubtitles, SubtitleSearchResult, SubtitleState } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import type { SubtitleScope } from '../../api/subtitles.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Select } from '../../components/form.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Modal } from '../../components/modal.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column } from '../../components/table.js';
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

// Per-item Subtitles tab for series and movie details: one row per media file with the
// subtitles on disk / embedded, what is still missing, and the per-file actions.

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
  if (files.isPending) return <LoadingBlock />;
  if (files.isError) return <ErrorView error={files.error} onRetry={() => void files.refetch()} />;

  const notifySearch = (message: string) => toast.push({ tone: 'info', title: 'Subtitle search finished', message });
  const ctx: RowContext = {
    episodes,
    onManual: (file, label) => setManual({ file, label }),
    onUpload: (file, label) => setUpload({ file, label }),
    onSearch: (file) => search.mutate({ mediaFileId: file.mediaFileId }, { onSuccess: (r) => notifySearch(r.message) }),
    onRescan: (file) => scan.mutate({ mediaFileId: file.mediaFileId }),
    searching: search.isPending ? (search.variables.mediaFileId ?? null) : null,
  };

  return (
    <Card
      flush
      actions={
        <>
          <Button size="sm" loading={search.isPending && search.variables.mediaFileId === undefined} onClick={() => search.mutate(scope, { onSuccess: (r) => notifySearch(r.message) })}>
            Search all
          </Button>
          <Button size="sm" loading={scan.isPending} onClick={() => scan.mutate(scope as SubtitleScope)}>
            Rescan all
          </Button>
        </>
      }
    >
      {files.data.length === 0 ? (
        <EmptyState title="No files">Subtitles are tracked once a video file is imported.</EmptyState>
      ) : (
        groups.map(([season, list]) => (
          <section key={String(season)} aria-label={season === null ? 'Files' : season === 0 ? 'Specials' : `Season ${season}`}>
            {season !== null ? <h3 className="card-subtitle">{season === 0 ? 'Specials' : `Season ${season}`}</h3> : null}
            <FileTable files={list} ctx={ctx} />
          </section>
        ))
      )}
      {manual ? <ManualSearchModal file={manual.file} label={manual.label} onClose={() => setManual(null)} /> : null}
      {upload ? <UploadSubtitleModal file={upload.file} label={upload.label} onClose={() => setUpload(null)} /> : null}
    </Card>
  );
}

interface RowContext {
  episodes: readonly Episode[] | undefined;
  onManual: (file: MediaFileSubtitles, label: string) => void;
  onUpload: (file: MediaFileSubtitles, label: string) => void;
  onSearch: (file: MediaFileSubtitles) => void;
  onRescan: (file: MediaFileSubtitles) => void;
  searching: number | null;
}

function FileTable({ files, ctx }: { files: MediaFileSubtitles[]; ctx: RowContext }) {
  const columns: Column<MediaFileSubtitles>[] = [
    { key: 'file', header: 'File', cell: (f) => <span title={f.path}>{fileLabel(f, ctx.episodes)}</span> },
    {
      key: 'subtitles',
      header: 'Subtitles',
      cell: (f) => (
        <span className="sub-chips">
          {f.subtitles.map((s) => (
            <SubtitleWithActions key={s.id} subtitle={s} />
          ))}
          {f.missing.map((m) => (
            <MissingChip key={`${m.language}-${m.forced}-${m.hi}`} refItem={m} />
          ))}
          {f.subtitles.length === 0 && f.missing.length === 0 ? <span className="muted">None</span> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (f) => {
        const label = fileLabel(f, ctx.episodes);
        return (
          <span className="toolbar" style={{ margin: 0, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            <Button size="sm" aria-label={`Search subtitles ${label}`} loading={ctx.searching === f.mediaFileId} onClick={() => ctx.onSearch(f)}>
              Search
            </Button>
            <Button size="sm" aria-label={`Manual search ${label}`} onClick={() => ctx.onManual(f, label)}>
              Manual
            </Button>
            <Button size="sm" aria-label={`Upload subtitle ${label}`} onClick={() => ctx.onUpload(f, label)}>
              Upload
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Rescan ${label}`} onClick={() => ctx.onRescan(f)}>
              Rescan
            </Button>
          </span>
        );
      },
    },
  ];
  return <Table columns={columns} rows={files} rowKey={(f) => f.mediaFileId} sortable={false} caption="Subtitle files" />;
}

function SubtitleWithActions({ subtitle }: { subtitle: SubtitleState }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBlacklist, setConfirmBlacklist] = useState(false);
  const remove = useDeleteSubtitle();
  const sync = useSyncSubtitle();
  const blacklist = useBlacklistSubtitle();
  const extract = useExtractSubtitle();
  const toast = useToast();
  const name = useLanguageName();
  const label = refLabel(subtitle, name);
  const hasActions = !subtitle.embedded || isExtractable(subtitle);

  return (
    <SubtitleChip subtitle={subtitle}>
      {hasActions ? (
        <button
          type="button"
          className="sub-chip-menu"
          aria-expanded={open}
          aria-label={`Actions for ${label} ${subtitle.embedded ? 'embedded' : 'external'} subtitle`}
          onClick={() => setOpen((o) => !o)}
        >
          ⋯
        </button>
      ) : null}
      {open ? (
        <span className="sub-chip-actions">
          {subtitle.embedded ? (
            <Button size="sm" variant="ghost" loading={extract.isPending} onClick={() => extract.mutate(subtitle.id, { onSuccess: () => setOpen(false) })}>
              Extract
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
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
                <Button size="sm" variant="ghost" onClick={() => setConfirmBlacklist(true)}>
                  Blacklist
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </>
          )}
        </span>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${label} subtitle?`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await remove.mutateAsync(subtitle.id);
          setConfirmDelete(false);
        }}
      >
        <p>
          The file <code className="break">{subtitle.path}</code> is removed from disk.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmBlacklist}
        title={`Blacklist ${label} subtitle?`}
        confirmLabel="Blacklist"
        onCancel={() => setConfirmBlacklist(false)}
        onConfirm={async () => {
          await blacklist.mutateAsync(subtitle.id);
          setConfirmBlacklist(false);
        }}
      >
        <p>The subtitle is deleted, never downloaded again from {subtitle.provider}, and a replacement is searched for.</p>
      </ConfirmDialog>
    </SubtitleChip>
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
        <span className="badge-row">
          {r.forced ? <Badge>forced</Badge> : null}
          {r.hi ? <Badge>HI</Badge> : null}
          {r.matches.includes('hash') ? <Badge tone="ok">hash</Badge> : null}
        </span>
      ),
    },
    { key: 'score', header: 'Score', align: 'right', sortValue: (r) => r.percent, cell: (r) => <span title={`${r.score} / ${r.scoreOutOf}`}>{Math.round(r.percent)}%</span> },
    {
      key: 'release',
      header: 'Release',
      cell: (r) => (
        <span className="break" title={r.releaseInfo.join('\n')}>
          {r.releaseInfo[0] ?? '—'}
          {r.releaseInfo.length > 1 ? <span className="muted"> +{r.releaseInfo.length - 1}</span> : null}
        </span>
      ),
    },
    { key: 'uploader', header: 'Uploader', cell: (r) => r.uploader ?? '—' },
    {
      key: 'matches',
      header: 'Matches',
      cell: (r) => (
        <span className="muted" title={r.dontMatches.length ? `Does not match: ${r.dontMatches.join(', ')}` : undefined}>
          {r.matches.join(', ') || '—'}
        </span>
      ),
    },
    {
      key: 'download',
      header: <span className="sr-only">Download</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="primary"
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
    <Modal open onClose={onClose} size="lg" title={`Manual search · ${label}`}>
      <div className="toolbar">
        <FormField label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">All profile languages</option>
            {languageOptions.map((code) => (
              <option key={code} value={code}>
                {name(code)}
              </option>
            ))}
          </Select>
        </FormField>
        <Button size="sm" variant="ghost" loading={results.isFetching} onClick={() => void results.refetch()}>
          Search again
        </Button>
      </div>
      {results.isPending ? (
        <LoadingBlock />
      ) : results.isError ? (
        <ErrorView error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <>
          {results.data.allThrottled ? (
            <div className="notice notice-warning" role="status">
              Every provider is throttled right now; try again later.
            </div>
          ) : null}
          {results.data.errors.length ? (
            <div className="notice notice-warning" role="status">
              {results.data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · ')}
            </div>
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
      title={`Upload subtitle · ${label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={upload.isPending} onClick={submit}>
            Upload
          </Button>
        </>
      }
    >
      <div className="fields">
        <FormField label="Subtitle file">
          <input type="file" accept=".srt,.ass,.ssa,.vtt,.sub,.smi,.txt" onChange={(e) => setPicked(e.currentTarget.files?.[0] ?? null)} />
        </FormField>
        <FormField label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">Select a language…</option>
            {options.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </FormField>
        <label className="check">
          <input type="checkbox" checked={forced} onChange={(e) => setForced(e.currentTarget.checked)} /> Forced
        </label>
        <label className="check">
          <input type="checkbox" checked={hi} onChange={(e) => setHi(e.currentTarget.checked)} /> Hearing impaired
        </label>
      </div>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
