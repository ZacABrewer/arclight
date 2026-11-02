import { useMemo, useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import type { ComicIssue, ComicMonitorOption, ComicSeries, ComicSeriesDetails } from '@arclight/shared';
import { Banner, Button, EmptyState, FormRow, KeyValue, Modal, QualityTag, Select, StatusChip, Table, Toggle, type Column } from '../../../arclight/index.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QueryError } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useRootFolders } from '../../../hooks/library.js';
import {
  isAwaitingCatalogue,
  useBooksCommand,
  useBooksFormatProfiles,
  useComicSeries,
  useDeleteComicSeries,
  useSetIssuesMonitored,
  useUpdateComicSeries,
} from '../../../hooks/books.js';
import { DetailsHero } from '../details-kit.js';
import { BooksCrumb, BooksDeleteDialog, BooksGate, BooksSearchButton, CoverArt, FormatBadge, seriesTypeLabel } from './books-kit.js';
import { issueDate, profilesOfKind, rootsOfKind, shelfProgress, sortIssues } from './books-model.js';
import { BooksReleaseModal, type BooksReleaseTarget } from './books-releases.js';
import { bookStatus } from './ebook-author-details.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/books/comics/$id');

export const COMIC_MONITOR_OPTIONS: readonly ComicMonitorOption[] = ['all', 'future', 'missing', 'existing', 'first', 'latest', 'none'];
const SERIES_TYPES: ReadonlyArray<ComicSeries['seriesType']> = ['comic', 'manga', 'graphicNovel'];

export function comicMonitorOptionLabel(o: ComicMonitorOption): string {
  switch (o) {
    case 'all':
      return t('books.monitor.allIssues');
    case 'future':
      return t('books.monitor.futureIssues');
    case 'missing':
      return t('books.monitor.missing');
    case 'existing':
      return t('books.monitor.existing');
    case 'first':
      return t('books.monitor.firstIssue');
    case 'latest':
      return t('books.monitor.latestIssue');
    case 'none':
      return t('books.monitor.none');
  }
}

export function comicStatusLabel(status: ComicSeries['status']): string {
  switch (status) {
    case 'continuing':
      return t('books.comicStatus.continuing');
    case 'ended':
      return t('books.comicStatus.ended');
    case 'unknown':
      return t('books.comicStatus.unknown');
  }
}

export function ComicSeriesDetailsPage() {
  return (
    <BooksGate>
      <ComicView />
    </BooksGate>
  );
}

function ComicView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const series = useComicSeries(id);
  const profiles = useBooksFormatProfiles();
  const update = useUpdateComicSeries();
  const command = useBooksCommand();
  const del = useDeleteComicSeries();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('books.invalidId', { rawId }))} title={t('books.notFound')} />;
  if (series.isPending) return <Loading />;
  if (series.isError) return <QueryError error={series.error} onRetry={() => void series.refetch()} title={t('books.couldNotLoad')} />;
  const s = series.data;
  const p = shelfProgress(s.statistics);
  const profile = profiles.data?.find((x) => x.id === s.formatProfileId);
  const running = command.isPending ? command.variables.name : null;
  const metaParts = [s.publisher, s.startYear ? String(s.startYear) : null, seriesTypeLabel(s.seriesType), comicStatusLabel(s.status)].filter(Boolean);

  return (
    <div className="lib-details bk-details">
      <DetailsHero
        label={t('books.comicOverview')}
        art={<CoverArt src={s.coverUrl} title={s.title} className="mk-hero__poster" loading="eager" />}
        title={s.title}
        year={s.startYear ?? undefined}
        crumb={<BooksCrumb />}
        meta={metaParts.join(' · ')}
        chips={
          <>
            <MonitorSwitch
              monitored={s.monitored}
              onChange={(monitored) => update.mutate({ id: s.id, body: { monitored } })}
              label={t('common.monitorTitle', { monitored: s.monitored, title: s.title })}
            />
            <StatusChip status={s.monitored ? 'monitored' : 'unmonitored'} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('books.publisher'), value: s.publisher ?? '—' },
              { label: t('common.path'), value: s.path },
              { label: t('common.sizeOnDisk'), value: formatBytes(s.statistics.sizeOnDisk) },
              { label: t('common.available'), value: `${p.have} / ${p.total}` },
            ]}
          />
        }
        overview={s.overview}
        actions={
          <>
            <Button variant="primary" loading={running === 'ComicSeriesSearch'} onClick={() => command.mutate({ name: 'ComicSeriesSearch', seriesIds: [s.id] })}>
              {t('library.seriesDetails.searchMonitored')}
            </Button>
            <Button loading={running === 'RefreshComicSeries'} onClick={() => command.mutate({ name: 'RefreshComicSeries', seriesIds: [s.id] })}>
              {t('common.refresh')}
            </Button>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      />

      <IssueTable series={s} />

      {editing ? <EditComicModal series={s} onClose={() => setEditing(false)} /> : null}
      <BooksDeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={s.title}
        path={s.path}
        loading={del.isPending}
        onConfirm={(deleteFiles) =>
          del.mutate(
            { id: s.id, deleteFiles },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate({ to: '/library/books' });
              },
            },
          )
        }
      />
    </div>
  );
}

function IssueTable({ series }: { series: ComicSeriesDetails }) {
  const setMonitored = useSetIssuesMonitored();
  const [searching, setSearching] = useState<BooksReleaseTarget | null>(null);
  const issues = useMemo(() => sortIssues(series.issues, 'desc'), [series.issues]);
  if (isAwaitingCatalogue(series, series.issues.length)) {
    return (
      <Banner tone="info">
        <span data-testid="loading-issues">{t('books.loadingIssues')}</span>
      </Banner>
    );
  }
  const allMonitored = issues.length > 0 && issues.every((i) => i.monitored);
  const columns: Column<ComicIssue>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      label: t('status.monitored'),
      width: '56px',
      cell: (i) => (
        <MonitorSwitch
          monitored={i.monitored}
          onChange={(monitored) => setMonitored.mutate({ ids: [i.id], monitored })}
          label={t('common.monitorTitle', { monitored: i.monitored, title: `#${i.issueNumber}` })}
        />
      ),
    },
    { key: 'number', header: '#', sortValue: (i) => i.issueSort ?? Number.POSITIVE_INFINITY, cell: (i) => <span className="bk-position">#{i.issueNumber}</span>, width: '88px' },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (i) => i.title ?? '',
      mobile: 'primary',
      cell: (i) => (
        <span className="bk-book-row">
          <CoverArt src={i.coverUrl} title={i.title ?? `#${i.issueNumber}`} className="bk-book-row__cover" />
          <span>{i.title ?? <span className="mk-muted">{t('books.untitledIssue')}</span>}</span>
        </span>
      ),
    },
    {
      key: 'date',
      header: t('books.issueDate'),
      sortValue: (i) => issueDate(i) ?? '',
      cell: (i) => {
        const d = issueDate(i);
        return d ? <span title={i.storeDate ? t('books.storeDate') : t('books.coverDate')}>{formatDate(d)}</span> : '—';
      },
      mono: true,
      width: '120px',
    },
    { key: 'format', header: t('books.format'), cell: (i) => (i.file ? <FormatBadge format={i.file.format} /> : '—'), width: '88px' },
    { key: 'size', header: t('common.size'), sortValue: (i) => i.file?.sizeBytes ?? 0, cell: (i) => (i.file ? formatBytes(i.file.sizeBytes) : '—'), mono: true, align: 'right', width: '96px' },
    { key: 'status', header: t('common.status'), cell: (i) => <StatusChip status={bookStatus(i)} />, width: '128px' },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      mobile: 'end',
      align: 'right',
      cell: (i) => (
        <span className="mk-row mk-row--end">
          <BooksSearchButton kind="comic" id={i.id} variant="ghost" label={t('books.searchFor', { title: `${series.title} #${i.issueNumber}` })} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSearching({ kind: 'comic', id: i.id, title: `${series.title} #${i.issueNumber}` })}
            aria-label={t('library.interactiveSearch.interactiveSearchTitle', { title: `${series.title} #${i.issueNumber}` })}
          >
            {t('books.interactive')}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <section aria-label={t('books.issues')}>
      <div className="music-group__head">
        {issues.length > 0 ? (
          <MonitorSwitch
            monitored={allMonitored}
            label={t('common.monitorTitle', { monitored: allMonitored, title: series.title })}
            onChange={(monitored) => setMonitored.mutate({ ids: issues.map((i) => i.id), monitored })}
          />
        ) : null}
        <h2 className="al-title-m mk-section-title">
          {t('books.issues')} <span className="al-num mk-muted">{issues.length}</span>
        </h2>
      </div>
      <Table
        columns={columns}
        rows={issues}
        rowKey={(i) => i.id}
        defaultSort={{ key: 'number', direction: 'desc' }}
        caption={t('books.issues')}
        empty={<EmptyState title={t('books.noIssues')}>{t('books.noIssuesBody')}</EmptyState>}
      />
      <BooksReleaseModal target={searching} onClose={() => setSearching(null)} />
    </section>
  );
}

function EditComicModal({ series, onClose }: { series: ComicSeriesDetails; onClose: () => void }) {
  const profiles = useBooksFormatProfiles();
  const rootFolders = useRootFolders();
  const update = useUpdateComicSeries();
  const [monitored, setMonitored] = useState(series.monitored);
  const [monitorNewIssues, setMonitorNewIssues] = useState(series.monitorNewIssues);
  const [seriesType, setSeriesType] = useState(series.seriesType);
  const [monitorOption, setMonitorOption] = useState<ComicMonitorOption | ''>('');
  const [formatProfileId, setProfile] = useState(series.formatProfileId);
  const [rootFolderPath, setRoot] = useState(series.rootFolderPath);
  const [tags, setTags] = useState<number[]>([...series.tags]);
  const roots = rootsOfKind(rootFolders.data, 'comic');
  const rootOptions = roots.some((r) => r.path === rootFolderPath) ? roots : [{ path: rootFolderPath }, ...roots];

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.seriesDetails.editTitle', { title: series.title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-comic-series" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-comic-series"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            {
              id: series.id,
              body: {
                monitored,
                monitorNewIssues,
                seriesType,
                formatProfileId,
                tags,
                ...(monitorOption ? { monitorOption } : {}),
                ...(rootFolderPath !== series.rootFolderPath ? { rootFolderPath } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="cs-monitored" captionInline caption={t('books.monitoredCaption')}>
          <Toggle id="cs-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label={t('books.monitorNewIssues')} htmlFor="cs-new" captionInline caption={t('books.monitorNewIssuesCaption')}>
          <Toggle id="cs-new" checked={monitorNewIssues} onChange={(e) => setMonitorNewIssues(e.target.checked)} />
        </FormRow>
        <FormRow label={t('books.seriesTypeLabel')} htmlFor="cs-type" caption={t('books.seriesTypeCaption')}>
          <Select
            id="cs-type"
            value={seriesType}
            onChange={(e) => setSeriesType(e.target.value as ComicSeries['seriesType'])}
            options={SERIES_TYPES.map((v) => ({ value: v, label: seriesTypeLabel(v) }))}
          />
        </FormRow>
        <FormRow label={t('music.reapplyMonitoring')} htmlFor="cs-reapply" caption={t('books.reapplyCaption')}>
          <Select
            id="cs-reapply"
            value={monitorOption}
            onChange={(e) => setMonitorOption(e.target.value as ComicMonitorOption | '')}
            options={[{ value: '', label: t('music.keepAsIs') }, ...COMIC_MONITOR_OPTIONS.map((v) => ({ value: v, label: comicMonitorOptionLabel(v) }))]}
          />
        </FormRow>
        <FormRow label={t('books.formatProfile')} htmlFor="cs-profile">
          <Select
            id="cs-profile"
            value={String(formatProfileId)}
            onChange={(e) => setProfile(Number(e.target.value))}
            options={profilesOfKind(profiles.data, 'comic').map((p) => ({ value: String(p.id), label: p.name }))}
          />
        </FormRow>
        <FormRow label={t('common.rootFolder')} htmlFor="cs-root" caption={t('books.rootMoveCaption')}>
          <Select id="cs-root" value={rootFolderPath} onChange={(e) => setRoot(e.target.value)} options={rootOptions.map((r) => ({ value: r.path, label: r.path }))} />
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
      </form>
    </Modal>
  );
}
