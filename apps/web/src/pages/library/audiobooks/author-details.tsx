import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { AudiobookMonitorOption, AuthorDetails, Book, MonitorNewBooks } from '@arclight/shared';
import { Banner, Button, EmptyState, FormRow, Input, KeyValue, Meter, Modal, QualityTag, Select, StatusChip, Toggle } from '../../../arclight/index.js';
import { DeleteMediaDialog } from '../../../components/media/delete-media-dialog.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QueryError, TagChips } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useRootFolders, useTags } from '../../../hooks/library.js';
import {
  isLoadingBooks,
  useAudiobookCommand,
  useAudiobookQualityProfiles,
  useAuthor,
  useDeleteAuthor,
  useSetAuthorMonitored,
  useSetBooksMonitored,
  useUpdateAuthor,
} from '../../../hooks/audiobooks.js';
import { useAudiobookSearch } from '../../../hooks/audiobook-acquisition.js';
import { DetailsHero } from '../details-kit.js';
import { AudiobookCrumb, AudiobookGate, AuthorArt, seriesLink } from './audiobook-kit.js';
import { AudiobookInteractiveSearchModal } from './audiobook-release-table.js';
import { BookCard } from './book-card.js';
import { MONITOR_OPTIONS, NEW_BOOK_OPTIONS, audibleUrl, authorBackdrop, authorProgress, groupBooks, monitorNewBooksLabel, monitorOptionLabel } from './audiobook-model.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/audiobooks/author/$id');

export function AuthorDetailsPage() {
  return (
    <AudiobookGate>
      <AuthorDetailsView />
    </AudiobookGate>
  );
}

function AuthorDetailsView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const author = useAuthor(id);
  const profiles = useAudiobookQualityProfiles();
  const tags = useTags();
  const setMonitored = useSetAuthorMonitored();
  const command = useAudiobookCommand();
  const del = useDeleteAuthor();
  const search = useAudiobookSearch();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [interactive, setInteractive] = useState(false);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('audiobooks.invalidAuthorId', { rawId }))} title={t('audiobooks.authorNotFound')} />;
  if (author.isPending) return <Loading />;
  if (author.isError) return <QueryError error={author.error} onRetry={() => void author.refetch()} title={t('audiobooks.couldNotLoadThisAuthor')} />;
  const a = author.data;
  const stats = a.statistics;
  const p = authorProgress(stats);
  const profile = profiles.data?.find((x) => x.id === a.qualityProfileId);
  const running = command.isPending ? command.variables.name : null;

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('audiobooks.authorOverview')}
        backdrop={authorBackdrop(a)}
        art={<AuthorArt author={a} className="mk-hero__poster" loading="eager" />}
        title={a.name}
        crumb={<AudiobookCrumb />}
        meta={[a.genres.slice(0, 3).join(', ') || null, t('audiobooks.bookCount', { count: stats?.bookCount ?? a.books.length }), t('audiobooks.seriesCount', { count: stats?.seriesCount ?? a.series.length })]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch monitored={a.monitored} onChange={(m) => setMonitored.mutate({ id: a.id, monitored: m })} label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })} />
            <StatusChip status={a.monitored ? 'monitored' : 'unmonitored'} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            <TagChips ids={a.tags} tags={tags.data} />
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.path'), value: a.path },
              { label: t('common.sizeOnDisk'), value: formatBytes(stats?.sizeOnDisk) },
              { label: t('audiobooks.available'), value: `${p.have} / ${p.total}` },
              { label: t('audiobooks.missing'), value: String(stats?.missingBookCount ?? 0) },
            ]}
          />
        }
        overview={a.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ name: 'AuthorSearch', authorIds: [a.id] })}>
              {t('library.seriesDetails.searchMonitored')}
            </Button>
            <Button onClick={() => setInteractive(true)}>{t('library.seriesDetails.interactiveSearch')}</Button>
            <Button loading={running === 'RefreshAuthor'} disabled={running === 'RescanAuthor'} onClick={() => command.mutate({ name: 'RefreshAuthor', authorId: a.id })}>
              {t('common.refresh')}
            </Button>
            <Button loading={running === 'RescanAuthor'} disabled={running === 'RefreshAuthor'} onClick={() => command.mutate({ name: 'RescanAuthor', authorId: a.id })}>
              {t('music.rescanFolder')}
            </Button>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {a.asin ? (
          <ul className="music-links" aria-label={t('music.links')}>
            <li>
              <a href={audibleUrl('author', a.asin)} target="_blank" rel="noopener noreferrer">
                {t('audiobooks.audible')}
              </a>
            </li>
          </ul>
        ) : null}
      </DetailsHero>

      <BookGroups author={a} />

      {editing ? <EditAuthorModal author={a} onClose={() => setEditing(false)} /> : null}
      <AudiobookInteractiveSearchModal
        target={interactive ? { authorId: a.id } : null}
        title={a.name}
        bookTitles={new Map(a.books.map((x) => [x.id, x.title]))}
        onClose={() => setInteractive(false)}
      />
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={a.name}
        noun={t('audiobooks.authorNoun', { count: 1 })}
        path={a.path}
        loading={del.isPending}
        onConfirm={(opts) =>
          del.mutate(
            { id: a.id, ...opts },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate({ to: '/library/audiobooks' });
              },
            },
          )
        }
      />
    </div>
  );
}

function BookGroups({ author }: { author: AuthorDetails }) {
  const groups = useMemo(() => groupBooks(author.books, author.series), [author.books, author.series]);
  if (isLoadingBooks(author)) {
    return (
      <Banner tone="info">
        <span data-testid="loading-books">{t('audiobooks.loadingBooks')}</span>
      </Banner>
    );
  }
  if (author.books.length === 0) return <EmptyState title={t('audiobooks.noBooks')}>{t('audiobooks.noBooksBody')}</EmptyState>;
  return (
    <div className="music-groups">
      {groups.series.map((g) => (
        <BookGroupSection
          key={g.seriesId}
          authorId={author.id}
          label={g.name}
          testId={`series-group-${g.seriesId}`}
          seriesId={g.seriesId}
          entries={g.entries.map((e) => ({ book: e.book, position: e.position }))}
        />
      ))}
      {groups.standalone.length ? (
        <BookGroupSection authorId={author.id} label={t('audiobooks.standalone')} testId="series-group-standalone" entries={groups.standalone.map((book) => ({ book, position: null }))} />
      ) : null}
    </div>
  );
}

function BookGroupSection({
  authorId,
  label,
  testId,
  seriesId,
  entries,
}: {
  authorId: number;
  label: string;
  testId: string;
  seriesId?: number | undefined;
  entries: Array<{ book: Book; position: string | null }>;
}) {
  const setBooks = useSetBooksMonitored();
  const allMonitored = entries.every((e) => e.book.monitored);
  const have = entries.filter((e) => e.book.hasFile).length;
  return (
    <section aria-label={label} data-testid={testId}>
      <div className="music-group__head">
        <MonitorSwitch
          monitored={allMonitored}
          label={t('common.monitorTitle', { monitored: allMonitored, title: label })}
          onChange={(m) => setBooks.mutate({ authorId, bookIds: entries.map((e) => e.book.id), monitored: m })}
        />
        <h2 className="al-title-m mk-section-title">
          {seriesId ? (
            <Link {...seriesLink({ id: seriesId })} className="mk-link">
              {label}
            </Link>
          ) : (
            label
          )}{' '}
          <span className="al-num mk-muted">{entries.length}</span>
        </h2>
        <span className="mk-spacer" />
        <div className="lib-collection-meter">
          <Meter value={entries.length > 0 ? (have / entries.length) * 100 : 0} label={t('library.seriesDetails.labelProgress', { label })} valueText={`${have}/${entries.length}`} />
        </div>
      </div>
      <div className="music-album-grid">
        {entries.map((e) => (
          <BookCard key={e.book.id} book={e.book} position={e.position} onMonitor={(m) => setBooks.mutate({ authorId, bookIds: [e.book.id], monitored: m })} />
        ))}
      </div>
    </section>
  );
}

function EditAuthorModal({ author, onClose }: { author: AuthorDetails; onClose: () => void }) {
  const profiles = useAudiobookQualityProfiles();
  const rootFolders = useRootFolders();
  const update = useUpdateAuthor();
  const [monitored, setMonitored] = useState(author.monitored);
  const [monitorNewBooks, setMonitorNewBooks] = useState<MonitorNewBooks>(author.monitorNewBooks);
  const [monitorOption, setMonitorOption] = useState<AudiobookMonitorOption | ''>('');
  const [qualityProfileId, setProfile] = useState(author.qualityProfileId);
  const [path, setPath] = useState(author.path);
  const [tags, setTags] = useState<number[]>([...author.tags]);
  const roots = (rootFolders.data ?? []).filter((r) => r.mediaType === 'audiobook');

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
          <Button type="submit" form="edit-author-form" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-author-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            {
              id: author.id,
              body: {
                monitored,
                monitorNewBooks,
                qualityProfileId,
                tags,
                ...(monitorOption ? { monitorOption } : {}),
                ...(path.trim() && path !== author.path ? { path: path.trim() } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="edit-author-monitored" captionInline caption={t('audiobooks.monitoredCaption')}>
          <Toggle id="edit-author-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label={t('audiobooks.monitorNewBooksLabel')} htmlFor="edit-author-new">
          <Select id="edit-author-new" value={monitorNewBooks} onChange={(e) => setMonitorNewBooks(e.target.value as MonitorNewBooks)}>
            {NEW_BOOK_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {monitorNewBooksLabel(v)}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('music.reapplyMonitoring')} htmlFor="edit-author-reapply" caption={t('audiobooks.reapplyMonitoringCaption')}>
          <Select id="edit-author-reapply" value={monitorOption} onChange={(e) => setMonitorOption(e.target.value as AudiobookMonitorOption | '')}>
            <option value="">{t('music.keepAsIs')}</option>
            {MONITOR_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {monitorOptionLabel(v)}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.qualityProfile')} htmlFor="edit-author-profile">
          <Select id="edit-author-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.path')} htmlFor="edit-author-path" caption={roots.length ? t('library.seriesDetails.rootFoldersMap', { map: roots.map((r) => r.path).join(', ') }) : undefined} captionMono>
          <Input id="edit-author-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
      </form>
    </Modal>
  );
}
