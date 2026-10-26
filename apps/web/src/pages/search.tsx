import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReleaseResource } from '@arclight/shared';
import { errorMessage } from '../api/client.js';
import { indexersApi } from '../api/indexers.js';
import {
  Button,
  EmptyState,
  ErrorBlock,
  FilterBar,
  Icon,
  Input,
  LinkButton,
  PageHeader,
  Pane,
  ProtocolBadge,
  QualityTag,
  RejectionList,
  ScoreTag,
  Select,
  Table,
  Tooltip,
  type Column,
} from '../arclight/index.js';
import { ConfirmDialog } from '../components/forms/confirm-dialog.js';
import { MultiSelect } from '../components/multi-select.js';
import { useToast } from '../components/toast.js';
import { useIndexerCategories, useIndexerList } from '../hooks/indexers.js';
import { formatDateTime } from '../lib/format.js';
import { formatBytes } from './activity/activity-shared.js';
import {
  categoryNameMap,
  categoryOptions,
  downloadLink,
  EMPTY_SEARCH,
  filterResults,
  formatAge,
  isNoMatch,
  peersLabel,
  releaseQuality,
  releaseScores,
  toSearchRequest,
  type ProtocolFilter,
  type SearchForm,
  type SearchKind,
} from './search-model.js';
import './search.css';
import { t } from '../i18n/index.js';

const route = getRouteApi('/search');

export interface ReleaseColumnOptions {
  categoryName: (id: number) => string;
  onGrab: (r: ReleaseResource) => void;
  grabbing: (r: ReleaseResource) => boolean;
}

/**
 * Release table columns, the same layout as the interactive search modal: title, indexer,
 * age / size / peers (mono), quality, format scores, rejections (tooltip), download + Grab.
 */
export function releaseColumns({ categoryName, onGrab, grabbing }: ReleaseColumnOptions): Column<ReleaseResource>[] {
  return [
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.title,
      cell: (r) => (
        <span className="mt-release__title">
          <ProtocolBadge protocol={r.protocol} />
          {r.infoUrl ? (
            <a href={r.infoUrl} target="_blank" rel="noreferrer noopener" className="mt-release__name">
              {r.title}
            </a>
          ) : (
            <span className="mt-release__name">{r.title}</span>
          )}
          {r.categories.length ? <span className="mt-release__cats">{r.categories.map(categoryName).join(', ')}</span> : null}
        </span>
      ),
    },
    { key: 'indexer', header: t('common.indexer'), muted: true, sortValue: (r) => r.indexerName, cell: (r) => r.indexerName },
    {
      key: 'age',
      header: t('search.age'),
      mono: true,
      align: 'right',
      sortValue: (r) => r.ageMinutes,
      cell: (r) => <span title={formatDateTime(r.publishDate)}>{formatAge(r)}</span>,
    },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', sortValue: (r) => r.size, cell: (r) => formatBytes(r.size) },
    {
      key: 'peers',
      header: t('common.peers'),
      mono: true,
      align: 'right',
      sortValue: (r) => (r.protocol === 'torrent' ? (r.seeders ?? -1) : (r.grabs ?? -1)),
      cell: (r) => peersLabel(r),
    },
    {
      key: 'quality',
      header: t('common.quality'),
      sortValue: (r) => releaseQuality(r.title),
      cell: (r) => {
        const q = releaseQuality(r.title);
        return q ? <QualityTag>{q}</QualityTag> : <span className="mt-release__none">—</span>;
      },
    },
    {
      key: 'scores',
      header: t('common.formats'),
      cell: (r) => {
        const scores = releaseScores(r);
        return scores.length ? (
          <span className="mt-release__scores">
            {scores.map((s) => (
              <ScoreTag key={s.name} name={s.name} score={s.score} />
            ))}
          </span>
        ) : (
          <span className="mt-release__none">—</span>
        );
      },
    },
    {
      key: 'rejections',
      header: <span className="al-sr-only">{t('search.rejections')}</span>,
      align: 'center',
      cell: (r) =>
        r.rejections.length ? (
          <Tooltip content={<RejectionList reasons={r.rejections} />}>
            <Button
              variant="ghost"
              size="sm"
              className="mt-release__rejected"
              icon={<Icon name="alert" />}
              aria-label={t('search.rejectionsForTitle', { rejectionsCount: r.rejections.length, title: r.title })}
            />
          </Tooltip>
        ) : null,
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => {
        const link = downloadLink(r);
        const magnet = link?.startsWith('magnet:') ?? false;
        const what = magnet ? t('search.openMagnetLink') : r.protocol === 'torrent' ? t('search.downloadTorrent') : t('search.downloadNzb');
        return (
          <span className="mt-release__actions">
            {link ? (
              <Tooltip content={what}>
                <LinkButton variant="ghost" size="sm" icon={<Icon name={magnet ? 'link' : 'download'} />} href={link} rel="noreferrer noopener" aria-label={t('search.downloadTitle', { title: r.title })} />
              </Tooltip>
            ) : null}
            <Button size="sm" variant="secondary" loading={grabbing(r)} onClick={() => onGrab(r)} aria-label={t('search.grabTitle', { title: r.title })}>
              {t('search.grab')}
            </Button>
          </span>
        );
      },
    },
  ];
}

/** Cross-indexer manual search: query + type + categories + indexers, results with download/grab. */
export function SearchPage() {
  const { q } = route.useSearch();
  const navigate = route.useNavigate();
  const toast = useToast();
  const [form, setForm] = useState<SearchForm>({ ...EMPTY_SEARCH, query: q });
  const [submitted, setSubmitted] = useState<SearchForm | null>(q ? { ...EMPTY_SEARCH, query: q } : null);
  const [protocol, setProtocol] = useState<ProtocolFilter>('all');
  const [refine, setRefine] = useState('');
  const categories = useIndexerCategories();
  const indexers = useIndexerList();

  useEffect(() => {
    document.title = t('search.titleArclight', { title: t('search.title') });
  }, []);

  // The top bar (or a link) changed ?q=: search for it.
  useEffect(() => {
    if (q && q !== submitted?.query) {
      setForm((f) => ({ ...f, query: q }));
      setSubmitted((s) => ({ ...(s ?? EMPTY_SEARCH), query: q }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the URL
  }, [q]);

  const request = submitted ? toSearchRequest(submitted) : null;
  const results = useQuery({
    // Not under ['indexers']: an indexer event must not re-run a slow search.
    queryKey: ['release-search', request],
    queryFn: ({ signal }) => indexersApi.search(request!, signal),
    enabled: request !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Grab through POST /search/grab; a result with no library match asks before force-grabbing.
  const [forceTarget, setForceTarget] = useState<{ release: ReleaseResource; reason: string } | null>(null);
  const grab = useMutation({
    mutationFn: (r: ReleaseResource) => indexersApi.searchGrab({ guid: r.guid, indexerId: r.indexerId }),
    meta: { silent: true },
    onSuccess: (res) => toast.push({ tone: 'ok', title: t('search.sentToDownloadClient'), message: res.title }),
    onError: (err, r) => {
      if (isNoMatch(err)) setForceTarget({ release: r, reason: err instanceof Error ? err.message : t('search.noLibraryMatch') });
      else toast.push({ tone: 'error', title: t('search.grabFailed'), message: err instanceof Error ? err.message : String(err) });
    },
  });
  const forceGrab = async (r: ReleaseResource) => {
    const res = await indexersApi.searchGrab({ guid: r.guid, indexerId: r.indexerId, force: true });
    setForceTarget(null);
    toast.push({ tone: 'ok', title: res.matched ? t('search.sentToDownloadClient') : t('search.forceGrabbedNotTrackedIn'), message: res.title });
  };

  const names = useMemo(() => categoryNameMap(categories.data ?? []), [categories.data]);
  const catOptions = useMemo(() => categoryOptions(categories.data ?? [], form.kind), [categories.data, form.kind]);
  const indexerOptions = (indexers.data ?? []).filter((i) => i.enableInteractiveSearch).map((i) => ({ value: i.id, label: i.name }));
  const rows = results.data ? filterResults(results.data, { protocol, text: refine }) : undefined;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.query.trim()) return;
    setSubmitted({ ...form, query: form.query.trim() });
    if (form.query.trim() !== q) void navigate({ search: { q: form.query.trim() } });
  };

  const activeFilters = (form.kind !== 'all' ? 1 : 0) + (form.categories.length ? 1 : 0) + (form.indexerIds.length ? 1 : 0);
  const activeRefine = (protocol !== 'all' ? 1 : 0) + (refine.trim() ? 1 : 0);

  const columns = releaseColumns({
    categoryName: (c) => names.get(c) ?? String(c),
    onGrab: (r) => grab.mutate(r),
    grabbing: (r) => grab.isPending && grab.variables?.guid === r.guid,
  });

  return (
    <>
      <PageHeader index="08" title={t('search.title')} subtitle={t('search.searchEveryIndexerAtOnce')} />
      <Pane className="mt-search">
        <form className="mt-search__form" role="search" aria-label={t('search.indexerSearch')} onSubmit={onSubmit}>
          <div className="mt-search__bar">
            <Input size="lg" aria-label={t('search.searchQuery')} placeholder={t('search.titleReleaseName')} value={form.query} onChange={(e) => setForm({ ...form, query: e.currentTarget.value })} />
            <Button type="submit" variant="primary" size="lg" icon={<Icon name="search" />} loading={results.isFetching} disabled={!form.query.trim()}>
              {t('common.search')}
            </Button>
          </div>
          <FilterBar activeCount={activeFilters} onClear={() => setForm({ ...form, kind: 'all', categories: [], indexerIds: [] })}>
            <Select
              aria-label={t('common.type')}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as SearchKind, categories: [] })}
              options={[
                { value: 'all', label: t('search.allTypes') },
                { value: 'series', label: t('common.tv') },
                { value: 'movie', label: t('common.movies') },
              ]}
            />
            <MultiSelect label={t('common.categories')} options={catOptions} value={form.categories} onChange={(c) => setForm({ ...form, categories: c })} emptyLabel={t('search.allCategories')} />
            <MultiSelect label={t('common.indexers')} options={indexerOptions} value={form.indexerIds} onChange={(ids) => setForm({ ...form, indexerIds: ids })} emptyLabel={t('search.allIndexers')} />
          </FilterBar>
        </form>
      </Pane>

      {request ? (
        <Pane
          flush
          className="mt-search__results"
          title={results.data ? t('search.valueOfDatacountResults', { value: rows?.length ?? 0, dataCount: results.data.length }) : t('common.results')}
          actions={
            <FilterBar
              activeCount={activeRefine}
              onClear={() => {
                setProtocol('all');
                setRefine('');
              }}
            >
              <Input aria-label={t('search.filterResults')} placeholder={t('search.filterTitles')} value={refine} onChange={(e) => setRefine(e.currentTarget.value)} />
              <Select
                aria-label={t('common.protocol')}
                value={protocol}
                onChange={(e) => setProtocol(e.currentTarget.value as ProtocolFilter)}
                options={[
                  { value: 'all', label: t('search.anyProtocol') },
                  { value: 'torrent', label: t('common.torrent') },
                  { value: 'usenet', label: t('common.usenet') },
                ]}
              />
            </FilterBar>
          }
        >
          {results.isError ? (
            <ErrorBlock title={t('common.searchFailed')} onRetry={() => void results.refetch()}>
              {errorMessage(results.error)}
            </ErrorBlock>
          ) : (
            <Table
              caption={t('common.searchResults')}
              columns={columns}
              rows={rows}
              rowKey={(r) => `${r.indexerId}:${r.guid}`}
              loading={results.isFetching && !results.data}
              defaultSort={{ key: 'age', direction: 'asc' }}
              empty={<EmptyState title={t('search.noResults')}>{t('search.tryFewerWordsAnotherType')}</EmptyState>}
            />
          )}
        </Pane>
      ) : (
        <EmptyState title={t('search.searchYourIndexers')} className="mt-search__empty">
          {t('search.typeATitleAndPress')}
        </EmptyState>
      )}
      {forceTarget ? (
        <ConfirmDialog
          open
          title={t('search.forceGrab')}
          confirmLabel={t('search.forceGrab2')}
          danger={false}
          onCancel={() => setForceTarget(null)}
          onConfirm={() => forceGrab(forceTarget.release)}
        >
          <p>
            <strong className="mt-release__name">{forceTarget.release.title}</strong> {t('search.doesNotMatchAnythingIn', { reason: forceTarget.reason })}
          </p>
          <p>{t('search.forceGrabbingSendsItTo', { protocol: forceTarget.release.protocol })}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
