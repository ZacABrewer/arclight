import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type {
  BooksKind,
  BooksSourceStatus,
  ComicMonitorOption,
  ComicSeries,
  ComicSeriesCandidate,
  EbookAuthorCandidate,
  EbookCandidate,
  EbookMonitorOption,
  MonitorNewEbooks,
} from '@arclight/shared';
import { Banner, Button, Checkbox, EmptyState, FormRow, Input, Modal, PageHeader, Select, Tabs, Toggle, buttonClass } from '../../../arclight/index.js';
import { Loading, QueryError } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useAddComicSeries, useAddEbook, useAddEbookAuthor, useBooksFormatProfiles, useComicLookup, useEbookAuthorLookup, useEbookLookup } from '../../../hooks/books.js';
import { BooksCrumb, BooksGate, CoverArt, SourceStatusChips, comicSeriesLink, ebookAuthorLink, seriesTypeLabel, sourceLabel, useDebounced, usePersistent } from './books-kit.js';
import { profilesOfKind, rootsOfKind } from './books-model.js';
import { COMIC_MONITOR_OPTIONS, comicMonitorOptionLabel } from './comic-details.js';
import { EBOOK_MONITOR_OPTIONS, MONITOR_NEW_EBOOKS, ebookMonitorOptionLabel, monitorNewEbooksLabel } from './ebook-author-details.js';
import '../library.css';
import { t } from '../../../i18n/index.js';

type AddTab = 'author' | 'book' | 'comic';
type Picked = { tab: 'author'; item: EbookAuthorCandidate } | { tab: 'book'; item: EbookCandidate } | { tab: 'comic'; item: ComicSeriesCandidate };

export function BooksAddPage() {
  return (
    <BooksGate>
      <AddView />
    </BooksGate>
  );
}

function AddView() {
  // Opens on the tab matching the shelf the user came from.
  const [shelfKind] = usePersistent<BooksKind>('library.books.kind', 'ebook');
  const [tab, setTab] = useState<AddTab>(shelfKind === 'comic' ? 'comic' : 'author');
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);
  const [picked, setPicked] = useState<Picked | null>(null);

  const search = (
    <Input
      type="search"
      className="mk-search"
      autoFocus
      aria-label={t('books.add.searchLabel')}
      placeholder={tab === 'author' ? t('books.add.placeholderAuthor') : tab === 'book' ? t('books.add.placeholderBook') : t('books.add.placeholderComic')}
      value={term}
      onChange={(e) => setTerm(e.target.value)}
    />
  );

  return (
    <div className="lib-page">
      <PageHeader title={t('books.add.title')} subtitle={<BooksCrumb />} />
      <Tabs
        aria-label={t('books.add.title')}
        value={tab}
        onChange={(v) => setTab(v as AddTab)}
        tabs={[
          { id: 'author', label: t('books.add.tabAuthor'), content: tab === 'author' ? <AuthorResults term={debounced} search={search} onPick={(item) => setPicked({ tab: 'author', item })} /> : null },
          { id: 'book', label: t('books.add.tabBook'), content: tab === 'book' ? <BookResults term={debounced} search={search} onPick={(item) => setPicked({ tab: 'book', item })} /> : null },
          { id: 'comic', label: t('books.add.tabComic'), content: tab === 'comic' ? <ComicResults term={debounced} search={search} onPick={(item) => setPicked({ tab: 'comic', item })} /> : null },
        ]}
      />
      {picked ? <AddModal picked={picked} onClose={() => setPicked(null)} /> : null}
    </div>
  );
}

/** Shared frame of a lookup tab: the box, the catalogue chips, then the state or the results. */
function LookupFrame({
  term,
  search,
  query,
  count,
  children,
}: {
  term: string;
  search: ReactNode;
  query: { isFetching: boolean; isError: boolean; error: Error | null; refetch: () => unknown; data?: { sources: BooksSourceStatus[] } | undefined };
  count: number;
  children: ReactNode;
}) {
  const short = term.trim().length < 2;
  return (
    <div className="mk-stack-sm">
      {search}
      <SourceStatusChips sources={query.data?.sources} />
      {short ? (
        <p className="mk-muted">{t('books.add.typeToSearch')}</p>
      ) : query.isFetching && count === 0 ? (
        <Loading label={t('books.add.searching')} />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} title={t('common.searchFailed')} />
      ) : count === 0 ? (
        <EmptyState title={t('books.add.noResults')}>{t('books.add.noResultsBody', { term: term.trim() })}</EmptyState>
      ) : (
        <ul className="bk-results">{children}</ul>
      )}
    </div>
  );
}

function ResultRow({
  cover,
  title,
  meta,
  overview,
  sources,
  action,
}: {
  cover: ReactNode;
  title: string;
  meta: string;
  overview: string;
  sources: readonly Parameters<typeof sourceLabel>[0][];
  action: ReactNode;
}) {
  return (
    <li className="bk-result">
      {cover}
      <div style={{ minWidth: 0 }}>
        <div className="bk-result__title">{title}</div>
        <div className="bk-result__meta">{[meta, sources.map(sourceLabel).join(', ')].filter(Boolean).join(' · ')}</div>
        {overview ? <p className="bk-result__overview">{overview}</p> : null}
      </div>
      <div>{action}</div>
    </li>
  );
}

function AuthorResults({ term, search, onPick }: { term: string; search: ReactNode; onPick: (c: EbookAuthorCandidate) => void }) {
  const lookup = useEbookAuthorLookup(term);
  const rows = lookup.data?.results ?? [];
  return (
    <LookupFrame term={term} search={search} query={lookup} count={rows.length}>
      {rows.map((c) => (
        <ResultRow
          key={c.foreignId}
          cover={<CoverArt src={c.imageUrl} title={c.name} className="bk-result__cover" />}
          title={c.name}
          meta={[c.topWork, c.workCount !== null ? t('books.add.works', { count: c.workCount }) : null].filter(Boolean).join(' · ')}
          overview={c.overview}
          sources={c.sources}
          action={
            c.libraryId !== null ? (
              <Link {...ebookAuthorLink({ id: c.libraryId })} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                {t('books.add.inLibrary')}
              </Link>
            ) : (
              <Button size="sm" variant="primary" onClick={() => onPick(c)}>
                {t('common.add')}
              </Button>
            )
          }
        />
      ))}
    </LookupFrame>
  );
}

function BookResults({ term, search, onPick }: { term: string; search: ReactNode; onPick: (c: EbookCandidate) => void }) {
  const lookup = useEbookLookup(term);
  const rows = lookup.data?.results ?? [];
  return (
    <LookupFrame term={term} search={search} query={lookup} count={rows.length}>
      {rows.map((c) => (
        <ResultRow
          key={c.foreignId}
          cover={<CoverArt src={c.coverUrl} title={c.title} className="bk-result__cover" />}
          title={c.subtitle ? `${c.title}: ${c.subtitle}` : c.title}
          meta={[c.authorName, c.year ? String(c.year) : null, c.series[0] ? `${c.series[0].name}${c.series[0].position ? ` #${c.series[0].position}` : ''}` : null].filter(Boolean).join(' · ')}
          overview={c.overview}
          sources={c.sources}
          action={
            c.libraryId !== null ? (
              <span className="mk-muted">{t('books.add.inLibrary')}</span>
            ) : (
              <Button size="sm" variant="primary" onClick={() => onPick(c)}>
                {t('common.add')}
              </Button>
            )
          }
        />
      ))}
    </LookupFrame>
  );
}

function ComicResults({ term, search, onPick }: { term: string; search: ReactNode; onPick: (c: ComicSeriesCandidate) => void }) {
  const lookup = useComicLookup(term);
  const rows = lookup.data?.results ?? [];
  return (
    <LookupFrame term={term} search={search} query={lookup} count={rows.length}>
      {rows.map((c) => (
        <ResultRow
          key={c.foreignId}
          cover={<CoverArt src={c.coverUrl} title={c.title} className="bk-result__cover" />}
          title={c.startYear ? `${c.title} (${c.startYear})` : c.title}
          meta={[c.publisher, c.issueCount !== null ? t('books.issueCount', { count: c.issueCount }) : null].filter(Boolean).join(' · ')}
          overview={c.overview}
          sources={c.sources}
          action={
            c.libraryId !== null ? (
              <Link {...comicSeriesLink({ id: c.libraryId })} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                {t('books.add.inLibrary')}
              </Link>
            ) : (
              <Button size="sm" variant="primary" onClick={() => onPick(c)}>
                {t('common.add')}
              </Button>
            )
          }
        />
      ))}
    </LookupFrame>
  );
}

const SERIES_TYPES: ReadonlyArray<ComicSeries['seriesType']> = ['comic', 'manga', 'graphicNovel'];

/** The add form: root folder (of the kind), format profile, monitoring, tags, search on add. */
function AddModal({ picked, onClose }: { picked: Picked; onClose: () => void }) {
  const kind: BooksKind = picked.tab === 'comic' ? 'comic' : 'ebook';
  const rootFolders = useRootFolders();
  const profiles = useBooksFormatProfiles();
  const roots = rootsOfKind(rootFolders.data, kind);
  const kindProfiles = profilesOfKind(profiles.data, kind);
  const addAuthor = useAddEbookAuthor();
  const addBook = useAddEbook();
  const addComic = useAddComicSeries();
  const navigate = useNavigate();
  const [root, setRoot] = useState('');
  const [profileId, setProfileId] = useState(0);
  const [monitorOption, setMonitorOption] = useState<EbookMonitorOption>('all');
  const [comicMonitor, setComicMonitor] = useState<ComicMonitorOption>('all');
  const [monitorNewBooks, setMonitorNewBooks] = useState<MonitorNewEbooks>('all');
  const [monitorNewIssues, setMonitorNewIssues] = useState(true);
  const [seriesType, setSeriesType] = useState<ComicSeries['seriesType']>('comic');
  const [searchOnAdd, setSearchOnAdd] = useState(false);
  const [tags, setTags] = useState<number[]>([]);
  const rootPath = root || roots[0]?.path || '';
  const formatProfileId = profileId || kindProfiles[0]?.id || 0;
  const pending = addAuthor.isPending || addBook.isPending || addComic.isPending;
  const title = picked.tab === 'author' ? picked.item.name : picked.item.title;
  const ready = rootPath !== '' && formatProfileId > 0;

  const submit = () => {
    if (!ready) return;
    if (picked.tab === 'author') {
      addAuthor.mutate(
        { foreignId: picked.item.foreignId, name: picked.item.name, rootFolderPath: rootPath, formatProfileId, monitorOption, monitorNewBooks, tags, searchOnAdd },
        { onSuccess: (a) => void navigate(ebookAuthorLink(a)) },
      );
    } else if (picked.tab === 'book') {
      addBook.mutate(
        { foreignId: picked.item.foreignId, rootFolderPath: rootPath, formatProfileId, tags, searchOnAdd },
        { onSuccess: (b) => void navigate(ebookAuthorLink({ id: b.authorId })) },
      );
    } else {
      addComic.mutate(
        { foreignId: picked.item.foreignId, rootFolderPath: rootPath, formatProfileId, seriesType, monitorOption: comicMonitor, monitorNewIssues, tags, searchOnAdd },
        { onSuccess: (c) => void navigate(comicSeriesLink(c)) },
      );
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('books.add.addTitle', { title })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="books-add-form" variant="primary" loading={pending} disabled={!ready}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <form
        id="books-add-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {picked.tab === 'book' ? <p className="bk-note">{t('books.add.bookNote')}</p> : null}
        {roots.length === 0 ? (
          <Banner tone="warn">
            {t('books.add.noRoot')}{' '}
            <Link to="/settings/media-management" className="mk-link">
              {t('books.add.addRoot')}
            </Link>
          </Banner>
        ) : (
          <FormRow label={t('common.rootFolder')} htmlFor="bka-root">
            <Select id="bka-root" value={rootPath} onChange={(e) => setRoot(e.target.value)} options={roots.map((r) => ({ value: r.path, label: r.path }))} />
          </FormRow>
        )}
        {kindProfiles.length === 0 ? (
          <Banner tone="warn">
            {t('books.add.noProfile')}{' '}
            <Link to="/settings/books" className="mk-link">
              {t('common.settings')}
            </Link>
          </Banner>
        ) : (
          <FormRow label={t('books.formatProfile')} htmlFor="bka-profile">
            <Select id="bka-profile" value={String(formatProfileId)} onChange={(e) => setProfileId(Number(e.target.value))} options={kindProfiles.map((p) => ({ value: String(p.id), label: p.name }))} />
          </FormRow>
        )}
        {picked.tab === 'author' ? (
          <>
            <FormRow label={t('books.add.monitor')} htmlFor="bka-monitor">
              <Select
                id="bka-monitor"
                value={monitorOption}
                onChange={(e) => setMonitorOption(e.target.value as EbookMonitorOption)}
                options={EBOOK_MONITOR_OPTIONS.map((v) => ({ value: v, label: ebookMonitorOptionLabel(v) }))}
              />
            </FormRow>
            <FormRow label={t('books.monitorNewBooks')} htmlFor="bka-new">
              <Select
                id="bka-new"
                value={monitorNewBooks}
                onChange={(e) => setMonitorNewBooks(e.target.value as MonitorNewEbooks)}
                options={MONITOR_NEW_EBOOKS.map((v) => ({ value: v, label: monitorNewEbooksLabel(v) }))}
              />
            </FormRow>
          </>
        ) : null}
        {picked.tab === 'comic' ? (
          <>
            <FormRow label={t('books.add.monitor')} htmlFor="bka-cmonitor">
              <Select
                id="bka-cmonitor"
                value={comicMonitor}
                onChange={(e) => setComicMonitor(e.target.value as ComicMonitorOption)}
                options={COMIC_MONITOR_OPTIONS.map((v) => ({ value: v, label: comicMonitorOptionLabel(v) }))}
              />
            </FormRow>
            <FormRow label={t('books.seriesTypeLabel')} htmlFor="bka-type" caption={t('books.seriesTypeCaption')}>
              <Select id="bka-type" value={seriesType} onChange={(e) => setSeriesType(e.target.value as ComicSeries['seriesType'])} options={SERIES_TYPES.map((v) => ({ value: v, label: seriesTypeLabel(v) }))} />
            </FormRow>
            <FormRow label={t('books.monitorNewIssues')} htmlFor="bka-newissues" captionInline caption={t('books.monitorNewIssuesCaption')}>
              <Toggle id="bka-newissues" checked={monitorNewIssues} onChange={(e) => setMonitorNewIssues(e.target.checked)} />
            </FormRow>
          </>
        ) : null}
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
        <Checkbox label={t('books.add.searchOnAdd')} checked={searchOnAdd} onChange={(e) => setSearchOnAdd(e.target.checked)} />
      </form>
    </Modal>
  );
}
