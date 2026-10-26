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
import { CheckSyncButton, SyncBadge } from './sync-ui.js';
import { t } from '../../i18n/index.js';

// Per-item Subtitles tab for series and movie details (handoff §8): per media file, a table of
// languages (on disk, embedded, still missing) with Search / Upload / Delete / Sync actions and
// the sync-quality badge (score, offset, drift) with a per-row Check sync.

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

  if (pending) return <PendingApiNotice what={t('subtitles.itemTab.subtitles')} />;
  if (files.isPending)
    return (
      <Pane>
        <Skeleton lines={3} />
      </Pane>
    );
  if (files.isError)
    return (
      <ErrorBlock title={t('subtitles.itemTab.subtitlesDidNotLoad')} onRetry={() => void files.refetch()}>
        {errorMessage(files.error)}
      </ErrorBlock>
    );

  const notifySearch = (message: string) => toast.push({ tone: 'info', title: t('subtitles.itemTab.subtitleSearchFinished'), message });
  const ctx: FileContext = {
    episodes,
    onManual: (file, label) => setManual({ file, label }),
    onUpload: (file, label) => setUpload({ file, label }),
    onSearch: (file) => search.mutate({ mediaFileId: file.mediaFileId }, { onSuccess: (r) => notifySearch(r.message) }),
    onRescan: (file) => scan.mutate({ mediaFileId: file.mediaFileId }),
    searching: search.isPending ? (search.variables.mediaFileId ?? null) : null,
  };

  const seasonLabel = (season: number) => (season === 0 ? t('common.specials') : t('subtitles.itemTab.seasonSeason', { season }));

  return (
    <Pane
      title={t('common.files')}
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
            {t('subtitles.itemTab.searchAll')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={scan.isPending} onClick={() => scan.mutate(scope as SubtitleScope)}>
            {t('subtitles.itemTab.rescanAll')}
          </Button>
        </>
      }
    >
      {files.data.length === 0 ? (
        <EmptyState title={t('subtitles.itemTab.noFiles')}>{t('subtitles.itemTab.subtitlesAreTrackedOnceA')}</EmptyState>
      ) : groups.length === 1 && groups[0]![0] === null ? (
        groups[0]![1].map((f) => <FileBlock key={f.mediaFileId} file={f} ctx={ctx} />)
      ) : (
        <Accordion className="sub-seasons">
          {groups.map(([season, list], i) => (
            <AccordionItem
              key={String(season)}
              title={season === null ? t('common.files') : seasonLabel(season)}
              meta={
                <span className="al-num">
                  {t('subtitles.itemTab.files', { listCount: list.length })}
                </span>
              }
              defaultOpen={i === 0}
            >
              <section aria-label={season === null ? t('common.files') : seasonLabel(season)}>
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
      header: t('common.language'),
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
      header: t('common.state'),
      cell: (r) =>
        r.kind === 'missing' ? (
          <Chip tone="warn">{t('status.missing')}</Chip>
        ) : r.kind === 'embedded' ? (
          <span className="sub-state">
            {t('subtitles.itemTab.embedded')}{r.subtitle.codec ? <span className="sub-code">{r.subtitle.codec}</span> : null}
          </span>
        ) : (
          <span className="sub-state">{t('subtitles.itemTab.external')}</span>
        ),
    },
    { key: 'provider', header: t('common.provider'), muted: true, cell: (r) => (r.kind !== 'missing' && r.subtitle.provider) || '—' },
    {
      key: 'score',
      header: t('common.score'),
      align: 'right',
      mono: true,
      cell: (r) => (r.kind !== 'missing' && r.subtitle.percent !== null ? `${Math.round(r.subtitle.percent)}%` : '—'),
    },
    {
      key: 'sync',
      header: t('subtitles.sync.syncColumn'),
      align: 'right',
      cell: (r) => (r.kind === 'missing' ? <span className="sub-none">—</span> : <SyncBadge sync={r.subtitle} label={refLabel(r.subtitle, name)} />),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) =>
        r.kind === 'missing' ? (
          <span className="sub-actions">
            <Button
              size="sm"
              variant="secondary"
              aria-label={t('subtitles.itemTab.searchReflabelSubtitleForLabel', { refLabel: refLabel(r.missing, name), label })}
              loading={ctx.searching === file.mediaFileId}
              onClick={() => ctx.onSearch(file)}
            >
              {t('common.search')}
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
          <Button size="sm" variant="secondary" icon={<Icon name="search" />} aria-label={t('subtitles.itemTab.searchSubtitlesLabel', { label })} loading={ctx.searching === file.mediaFileId} onClick={() => ctx.onSearch(file)}>
            {t('common.search')}
          </Button>
          <Button size="sm" variant="secondary" aria-label={t('subtitles.itemTab.manualSearchLabel', { label })} onClick={() => ctx.onManual(file, label)}>
            {t('subtitles.itemTab.manualSearch')}
          </Button>
          <Button size="sm" variant="secondary" icon={<Icon name="upload" />} aria-label={t('subtitles.itemTab.uploadSubtitleLabel', { label })} onClick={() => ctx.onUpload(file, label)}>
            {t('common.upload')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} aria-label={t('subtitles.itemTab.rescanLabel', { label })} onClick={() => ctx.onRescan(file)}>
            {t('subtitles.itemTab.rescan')}
          </Button>
        </div>
      </div>
      <Table
        caption={t('subtitles.itemTab.subtitleLanguagesForLabel', { label })}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        sortable={false}
        empty={<EmptyState title={t('subtitles.itemTab.noSubtitles')}>{t('subtitles.itemTab.thisFileHasNoSubtitles')}</EmptyState>}
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
        <Button size="sm" variant="secondary" aria-label={t('subtitles.itemTab.extractLabelEmbeddedSubtitle', { label })} loading={extract.isPending} onClick={() => extract.mutate(subtitle.id)}>
          {t('subtitles.itemTab.extract')}
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
        aria-label={t('subtitles.itemTab.syncLabelSubtitle', { label })}
        loading={sync.isPending}
        onClick={() =>
          sync.mutate(subtitle.id, {
            onSuccess: (r) => toast.push({ tone: r.ok ? 'ok' : 'warning', title: r.ok ? t('subtitles.itemTab.subtitleSynced') : t('common.syncFailed'), message: r.message }),
          })
        }
      >
        {t('subtitles.itemTab.sync')}
      </Button>
      <CheckSyncButton subtitle={subtitle} label={label} />
      {subtitle.provider ? (
        <Button size="sm" variant="ghost" aria-label={t('subtitles.itemTab.blacklistLabelSubtitle', { label })} onClick={() => setConfirmBlacklist(true)}>
          {t('common.blacklist')}
        </Button>
      ) : null}
      <Button size="sm" variant="danger" aria-label={t('subtitles.itemTab.deleteLabelSubtitle', { label })} onClick={() => setConfirmDelete(true)}>
        {t('common.delete')}
      </Button>
      <ConfirmDialog
        open={confirmDelete}
        title={t('subtitles.itemTab.deleteLabelSubtitle2', { label })}
        confirmLabel={t('subtitles.itemTab.deleteSubtitle')}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await remove.mutateAsync(subtitle.id);
          setConfirmDelete(false);
        }}
      >
        <p>
          {t('subtitles.itemTab.theFile')} <span className="al-num mt-break">{subtitle.path}</span> {t('subtitles.itemTab.isRemovedFromDisk')}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmBlacklist}
        title={t('subtitles.itemTab.blacklistLabelSubtitle2', { label })}
        confirmLabel={t('subtitles.itemTab.blacklistSubtitle')}
        onCancel={() => setConfirmBlacklist(false)}
        onConfirm={async () => {
          await blacklist.mutateAsync(subtitle.id);
          setConfirmBlacklist(false);
        }}
      >
        <p>{t('subtitles.itemTab.theSubtitleIsDeletedNever', { provider: subtitle.provider })}</p>
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
    { key: 'provider', header: t('common.provider'), cell: (r) => r.provider },
    { key: 'language', header: t('common.language'), cell: (r) => name(r.language) },
    {
      key: 'flags',
      header: t('subtitles.itemTab.flags'),
      cell: (r) => (
        <span className="sub-chips">
          {r.forced ? <Chip tone="neutral">{t('common.forced')}</Chip> : null}
          {r.hi ? <Chip tone="neutral">{t('common.hi')}</Chip> : null}
          {r.matches.includes('hash') ? <Chip tone="accent">{t('subtitles.itemTab.hash')}</Chip> : null}
        </span>
      ),
    },
    {
      key: 'score',
      header: t('common.score'),
      align: 'right',
      mono: true,
      sortValue: (r) => r.percent,
      cell: (r) => <span title={`${r.score} / ${r.scoreOutOf}`}>{Math.round(r.percent)}%</span>,
    },
    {
      key: 'release',
      header: t('common.release'),
      cell: (r) => (
        <span className="mt-break al-num" title={r.releaseInfo.join('\n')}>
          {r.releaseInfo[0] ?? '—'}
          {r.releaseInfo.length > 1 ? <span className="sub-none"> +{r.releaseInfo.length - 1}</span> : null}
        </span>
      ),
    },
    { key: 'uploader', header: t('subtitles.itemTab.uploader'), muted: true, cell: (r) => r.uploader ?? '—' },
    {
      key: 'matches',
      header: t('subtitles.itemTab.matches'),
      muted: true,
      cell: (r) => <span title={r.dontMatches.length ? t('subtitles.itemTab.doesNotMatchDontmatches', { dontMatches: r.dontMatches.join(', ') }) : undefined}>{r.matches.join(', ') || '—'}</span>,
    },
    {
      key: 'download',
      header: <span className="al-sr-only">{t('common.download')}</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="download" />}
          aria-label={t('subtitles.itemTab.downloadProviderLanguageProvidersubtitleid', { provider: r.provider, language: r.language, providerSubtitleId: r.providerSubtitleId })}
          loading={download.isPending && download.variables.key === r.key}
          onClick={() =>
            download.mutate(
              { mediaFileId: file.mediaFileId, key: r.key },
              { onSuccess: () => toast.push({ tone: 'ok', title: t('subtitles.itemTab.downloadedNameSubtitleFromProvider', { name: name(r.language), provider: r.provider }) }) },
            )
          }
        >
          {t('common.download')}
        </Button>
      ),
    },
  ];

  return (
    <Modal open onClose={onClose} size={1100} title={t('subtitles.itemTab.manualSearchLabel2', { label })}>
      <div className="sub-toolbar">
        <Field label={t('common.language')}>
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">{t('subtitles.itemTab.allProfileLanguages')}</option>
            {languageOptions.map((code) => (
              <option key={code} value={code}>
                {name(code)}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} loading={results.isFetching} onClick={() => void results.refetch()}>
          {t('subtitles.itemTab.searchAgain')}
        </Button>
      </div>
      {results.isPending ? (
        <Skeleton lines={4} />
      ) : results.isError ? (
        <ErrorBlock title={t('subtitles.itemTab.subtitleSearchFailed')} onRetry={() => void results.refetch()}>
          {errorMessage(results.error)}
        </ErrorBlock>
      ) : (
        <>
          {results.data.allThrottled ? (
            <p className="sub-notice" role="status">
              {t('subtitles.itemTab.everyProviderIsThrottledRight')}
            </p>
          ) : null}
          {results.data.errors.length ? (
            <p className="sub-notice" role="status">
              {results.data.errors.map((e) => `${e.provider}: ${e.message}`).join(' · ')}
            </p>
          ) : null}
          <Table
            caption={t('subtitles.itemTab.subtitleCandidates')}
            columns={columns}
            rows={results.data.results}
            rowKey={(r) => r.key}
            defaultSort={{ key: 'score', direction: 'desc' }}
            empty={<EmptyState title={t('subtitles.itemTab.noSubtitlesFound')}>{t('subtitles.itemTab.noEnabledProviderReturnedA')}</EmptyState>}
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
    if (!picked) return setError(t('subtitles.itemTab.chooseASubtitleFile'));
    if (!language) return setError(t('subtitles.itemTab.chooseALanguage'));
    setError(null);
    upload.mutate(
      { mediaFileId: file.mediaFileId, language, forced, hi, file: picked },
      {
        onSuccess: () => {
          toast.push({ tone: 'ok', title: t('subtitles.itemTab.subtitleUploaded') });
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
      title={t('subtitles.itemTab.uploadSubtitleLabel2', { label })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Icon name="upload" />} loading={upload.isPending} onClick={submit}>
            {t('common.upload')}
          </Button>
        </>
      }
    >
      <div className="sub-fields">
        <Field label={t('subtitles.itemTab.subtitleFile')}>
          <input className="sub-file-input" type="file" accept=".srt,.ass,.ssa,.vtt,.sub,.smi,.txt" onChange={(e) => setPicked(e.currentTarget.files?.[0] ?? null)} />
        </Field>
        <Field label={t('common.language')}>
          <Select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
            <option value="">{t('subtitles.itemTab.selectALanguage')}</option>
            {options.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label={t('common.forced')} checked={forced} onChange={(e) => setForced(e.currentTarget.checked)} />
        <Checkbox label={t('subtitles.itemTab.hearingImpaired')} checked={hi} onChange={(e) => setHi(e.currentTarget.checked)} />
      </div>
      {error ? (
        <p className="al-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
