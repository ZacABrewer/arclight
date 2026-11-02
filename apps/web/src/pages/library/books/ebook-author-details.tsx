import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { Ebook, EbookAuthorDetails, EbookMonitorOption, MonitorNewEbooks } from '@arclight/shared';
import { Banner, Button, EmptyState, FormRow, KeyValue, Meter, Modal, QualityTag, Select, StatusChip, Table, Toggle, type Column } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QueryError } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useRootFolders } from '../../../hooks/library.js';
import {
  isAwaitingCatalogue,
  useBooksCommand,
  useBooksFormatProfiles,
  useDeleteEbookAuthor,
  useEbookAuthor,
  useSetEbooksMonitored,
  useUpdateEbookAuthor,
} from '../../../hooks/books.js';
import { DetailsHero } from '../details-kit.js';
import { BooksCrumb, BooksDeleteDialog, BooksGate, BooksSearchButton, CoverArt, FormatBadge, ebookSeriesLink } from './books-kit.js';
import { groupBySeries, profilesOfKind, rootsOfKind, shelfProgress } from './books-model.js';
import { BooksReleaseModal, type BooksReleaseTarget } from './books-releases.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/books/authors/$id');

export const EBOOK_MONITOR_OPTIONS: readonly EbookMonitorOption[] = ['all', 'future', 'missing', 'existing', 'first', 'latest', 'inSeries', 'none'];
export const MONITOR_NEW_EBOOKS: readonly MonitorNewEbooks[] = ['all', 'inSeries', 'none'];

export function ebookMonitorOptionLabel(o: EbookMonitorOption): string {
  switch (o) {
    case 'all':
      return t('books.monitor.all');
    case 'future':
      return t('books.monitor.future');
    case 'missing':
      return t('books.monitor.missing');
    case 'existing':
      return t('books.monitor.existing');
    case 'first':
      return t('books.monitor.first');
    case 'latest':
      return t('books.monitor.latest');
    case 'inSeries':
      return t('books.monitor.inSeries');
    case 'none':
      return t('books.monitor.none');
  }
}

export function monitorNewEbooksLabel(o: MonitorNewEbooks): string {
  switch (o) {
    case 'all':
      return t('books.monitorNew.all');
    case 'inSeries':
      return t('books.monitorNew.inSeries');
    case 'none':
      return t('books.monitorNew.none');
  }
}

export function EbookAuthorDetailsPage() {
  return (
    <BooksGate>
      <AuthorView />
    </BooksGate>
  );
}

function AuthorView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const author = useEbookAuthor(id);
  const profiles = useBooksFormatProfiles();
  const update = useUpdateEbookAuthor();
  const command = useBooksCommand();
  const del = useDeleteEbookAuthor();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('books.invalidId', { rawId }))} title={t('books.notFound')} />;
  if (author.isPending) return <Loading />;
  if (author.isError) return <QueryError error={author.error} onRetry={() => void author.refetch()} title={t('books.couldNotLoad')} />;
  const a = author.data;
  const p = shelfProgress(a.statistics);
  const profile = profiles.data?.find((x) => x.id === a.formatProfileId);
  const running = command.isPending ? command.variables.name : null;

  return (
    <div className="lib-details bk-details">
      <DetailsHero
        label={t('books.authorOverview')}
        art={<CoverArt src={a.imageUrl} title={a.name} className="mk-hero__poster" loading="eager" />}
        title={a.name}
        crumb={<BooksCrumb />}
        meta={[t('books.bookCount', { count: a.statistics.bookCount }), t('books.seriesCount', { count: a.statistics.seriesCount })].join(' · ')}
        chips={
          <>
            <MonitorSwitch
              monitored={a.monitored}
              onChange={(monitored) => update.mutate({ id: a.id, body: { monitored } })}
              label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })}
            />
            <StatusChip status={a.monitored ? 'monitored' : 'unmonitored'} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.path'), value: a.path },
              { label: t('common.sizeOnDisk'), value: formatBytes(a.statistics.sizeOnDisk) },
              { label: t('common.available'), value: `${p.have} / ${p.total}` },
              { label: t('books.monitorNewBooks'), value: monitorNewEbooksLabel(a.monitorNewBooks) },
            ]}
          />
        }
        overview={a.overview}
        actions={
          <>
            <Button variant="primary" loading={running === 'EbookAuthorSearch'} onClick={() => command.mutate({ name: 'EbookAuthorSearch', authorIds: [a.id] })}>
              {t('library.seriesDetails.searchMonitored')}
            </Button>
            <Button loading={running === 'RefreshEbookAuthor'} onClick={() => command.mutate({ name: 'RefreshEbookAuthor', authorIds: [a.id] })}>
              {t('common.refresh')}
            </Button>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {a.audiobookAuthorId ? (
          <p className="bk-note">
            <Link to="/library/audiobooks/author/$id" params={{ id: String(a.audiobookAuthorId) }}>
              {t('books.alsoInAudiobooks')}
            </Link>
          </p>
        ) : null}
      </DetailsHero>

      <BookGroups author={a} />

      {editing ? <EditAuthorModal author={a} onClose={() => setEditing(false)} /> : null}
      <BooksDeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={a.name}
        path={a.path}
        loading={del.isPending}
        onConfirm={(deleteFiles) =>
          del.mutate(
            { id: a.id, deleteFiles },
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

function BookGroups({ author }: { author: EbookAuthorDetails }) {
  const groups = useMemo(() => groupBySeries(author), [author]);
  const [searching, setSearching] = useState<BooksReleaseTarget | null>(null);
  if (isAwaitingCatalogue(author, author.books.length)) {
    return (
      <Banner tone="info">
        <span data-testid="loading-books">{t('books.loadingBooks')}</span>
      </Banner>
    );
  }
  if (author.books.length === 0) return <EmptyState title={t('books.noBooks')}>{t('books.noBooksBody')}</EmptyState>;
  const onSearch = (b: Ebook) => setSearching({ kind: 'ebook', id: b.id, title: b.title });
  return (
    <div className="music-groups">
      {groups.series.map((g) => (
        <BookGroup key={g.id} label={g.name} seriesId={g.id} books={g.books} onInteractive={onSearch} />
      ))}
      {groups.standalone.length ? <BookGroup label={t('books.standalone')} books={groups.standalone.map((b) => ({ ...b, position: null }))} onInteractive={onSearch} /> : null}
      <BooksReleaseModal target={searching} onClose={() => setSearching(null)} />
    </div>
  );
}

export function bookStatus(b: Pick<Ebook, 'hasFile' | 'monitored'>): 'downloaded' | 'missing' | 'unmonitored' {
  if (b.hasFile) return 'downloaded';
  return b.monitored ? 'missing' : 'unmonitored';
}

/** One series (reading order) or the standalone books, as a table that turns into cards on phones. */
export function BookGroup({
  label,
  seriesId,
  books,
  onInteractive,
  showAuthor,
}: {
  label: string;
  seriesId?: number | undefined;
  books: Array<Ebook & { position: string | null }>;
  onInteractive: (b: Ebook) => void;
  showAuthor?: boolean | undefined;
}) {
  const setMonitored = useSetEbooksMonitored();
  const allMonitored = books.every((b) => b.monitored);
  const have = books.filter((b) => b.hasFile).length;
  const columns: Column<Ebook & { position: string | null }>[] = [
    {
      key: 'monitored',
      header: <span className="al-sr-only">{t('status.monitored')}</span>,
      label: t('status.monitored'),
      width: '56px',
      cell: (b) => (
        <MonitorSwitch monitored={b.monitored} onChange={(monitored) => setMonitored.mutate({ ids: [b.id], monitored })} label={t('common.monitorTitle', { monitored: b.monitored, title: b.title })} />
      ),
    },
    ...(seriesId !== undefined
      ? [{ key: 'position', header: '#', width: '56px', cell: (b: Ebook & { position: string | null }) => <span className="bk-position">{b.position ?? '—'}</span> }]
      : []),
    {
      key: 'title',
      header: t('common.title'),
      cell: (b) => (
        <span className="bk-book-row">
          <CoverArt src={b.coverUrl} title={b.title} className="bk-book-row__cover" />
          <span>
            <span className="mk-link">{b.title}</span>
            {b.subtitle ? <span className="mk-muted"> · {b.subtitle}</span> : null}
            {showAuthor ? <span className="mk-muted"> · {b.authorName}</span> : null}
          </span>
        </span>
      ),
    },
    { key: 'year', header: t('books.year'), cell: (b) => b.year ?? '—', mono: true, width: '72px' },
    { key: 'format', header: t('books.format'), cell: (b) => (b.file ? <FormatBadge format={b.file.format} /> : '—'), width: '88px' },
    { key: 'size', header: t('common.size'), cell: (b) => (b.file ? formatBytes(b.file.sizeBytes) : '—'), mono: true, align: 'right', width: '96px' },
    { key: 'status', header: t('common.status'), cell: (b) => <StatusChip status={bookStatus(b)} />, width: '128px' },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      label: t('common.actions'),
      mobile: 'end',
      align: 'right',
      cell: (b) => (
        <span className="mk-row mk-row--end">
          <BooksSearchButton kind="ebook" id={b.id} variant="ghost" label={t('books.searchFor', { title: b.title })} />
          <Button size="sm" variant="ghost" onClick={() => onInteractive(b)} aria-label={t('library.interactiveSearch.interactiveSearchTitle', { title: b.title })}>
            {t('books.interactive')}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <section aria-label={label}>
      <div className="music-group__head">
        <MonitorSwitch
          monitored={allMonitored}
          label={t('common.monitorTitle', { monitored: allMonitored, title: label })}
          onChange={(monitored) => setMonitored.mutate({ ids: books.map((b) => b.id), monitored })}
        />
        <h2 className="al-title-m mk-section-title">
          {seriesId !== undefined ? (
            <Link {...ebookSeriesLink({ id: seriesId })} className="mk-link">
              {label}
            </Link>
          ) : (
            label
          )}{' '}
          <span className="al-num mk-muted">{books.length}</span>
        </h2>
        <span className="mk-spacer" />
        <div className="lib-collection-meter">
          <Meter value={books.length > 0 ? (have / books.length) * 100 : 0} label={t('library.seriesDetails.labelProgress', { label })} valueText={`${have}/${books.length}`} />
        </div>
      </div>
      <Table columns={columns} rows={books} rowKey={(b) => `${seriesId ?? 's'}-${b.id}`} sortable={false} caption={label} />
    </section>
  );
}

function EditAuthorModal({ author, onClose }: { author: EbookAuthorDetails; onClose: () => void }) {
  const profiles = useBooksFormatProfiles();
  const rootFolders = useRootFolders();
  const update = useUpdateEbookAuthor();
  const [monitored, setMonitored] = useState(author.monitored);
  const [monitorNewBooks, setMonitorNewBooks] = useState<MonitorNewEbooks>(author.monitorNewBooks);
  const [monitorOption, setMonitorOption] = useState<EbookMonitorOption | ''>('');
  const [formatProfileId, setProfile] = useState(author.formatProfileId);
  const [rootFolderPath, setRoot] = useState(author.rootFolderPath);
  const [tags, setTags] = useState<number[]>([...author.tags]);
  const roots = rootsOfKind(rootFolders.data, 'ebook');
  const rootOptions = roots.some((r) => r.path === rootFolderPath) ? roots : [{ path: rootFolderPath }, ...roots];

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.seriesDetails.editTitle', { title: author.name })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-ebook-author" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-ebook-author"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            {
              id: author.id,
              body: {
                monitored,
                monitorNewBooks,
                formatProfileId,
                tags,
                ...(monitorOption ? { monitorOption } : {}),
                ...(rootFolderPath !== author.rootFolderPath ? { rootFolderPath } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="eba-monitored" captionInline caption={t('books.monitoredCaption')}>
          <Toggle id="eba-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label={t('books.monitorNewBooks')} htmlFor="eba-new">
          <Select id="eba-new" value={monitorNewBooks} onChange={(e) => setMonitorNewBooks(e.target.value as MonitorNewEbooks)} options={MONITOR_NEW_EBOOKS.map((v) => ({ value: v, label: monitorNewEbooksLabel(v) }))} />
        </FormRow>
        <FormRow label={t('music.reapplyMonitoring')} htmlFor="eba-reapply" caption={t('books.reapplyCaption')}>
          <Select
            id="eba-reapply"
            value={monitorOption}
            onChange={(e) => setMonitorOption(e.target.value as EbookMonitorOption | '')}
            options={[{ value: '', label: t('music.keepAsIs') }, ...EBOOK_MONITOR_OPTIONS.map((v) => ({ value: v, label: ebookMonitorOptionLabel(v) }))]}
          />
        </FormRow>
        <FormRow label={t('books.formatProfile')} htmlFor="eba-profile">
          <Select
            id="eba-profile"
            value={String(formatProfileId)}
            onChange={(e) => setProfile(Number(e.target.value))}
            options={profilesOfKind(profiles.data, 'ebook').map((p) => ({ value: String(p.id), label: p.name }))}
          />
        </FormRow>
        <FormRow label={t('common.rootFolder')} htmlFor="eba-root" caption={t('books.rootMoveCaption')}>
          <Select id="eba-root" value={rootFolderPath} onChange={(e) => setRoot(e.target.value)} options={rootOptions.map((r) => ({ value: r.path, label: r.path }))} />
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
      </form>
    </Modal>
  );
}
