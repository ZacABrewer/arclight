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

const route = getRouteApi('/search');
const TITLE = 'Search';

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
      header: 'Title',
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
    { key: 'indexer', header: 'Indexer', muted: true, sortValue: (r) => r.indexerName, cell: (r) => r.indexerName },
    {
      key: 'age',
      header: 'Age',
      mono: true,
      align: 'right',
      sortValue: (r) => r.ageMinutes,
      cell: (r) => <span title={formatDateTime(r.publishDate)}>{formatAge(r)}</span>,
    },
    { key: 'size', header: 'Size', mono: true, align: 'right', sortValue: (r) => r.size, cell: (r) => formatBytes(r.size) },
    {
      key: 'peers',
      header: 'Peers',
      mono: true,
      align: 'right',
      sortValue: (r) => (r.protocol === 'torrent' ? (r.seeders ?? -1) : (r.grabs ?? -1)),
      cell: (r) => peersLabel(r),
    },
    {
      key: 'quality',
      header: 'Quality',
      sortValue: (r) => releaseQuality(r.title),
      cell: (r) => {
        const q = releaseQuality(r.title);
        return q ? <QualityTag>{q}</QualityTag> : <span className="mt-release__none">—</span>;
      },
    },
    {
      key: 'scores',
      header: 'Formats',
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
      header: <span className="al-sr-only">Rejections</span>,
      align: 'center',
      cell: (r) =>
        r.rejections.length ? (
          <Tooltip content={<RejectionList reasons={r.rejections} />}>
            <Button
              variant="ghost"
              size="sm"
              className="mt-release__rejected"
              icon={<Icon name="alert" />}
              aria-label={`${r.rejections.length} ${r.rejections.length === 1 ? 'rejection' : 'rejections'} for ${r.title}`}
            />
          </Tooltip>
        ) : null,
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => {
        const link = downloadLink(r);
        const magnet = link?.startsWith('magnet:') ?? false;
        const what = magnet ? 'Open magnet link' : r.protocol === 'torrent' ? 'Download .torrent' : 'Download .nzb';
        return (
          <span className="mt-release__actions">
            {link ? (
              <Tooltip content={what}>
                <LinkButton variant="ghost" size="sm" icon={<Icon name={magnet ? 'link' : 'download'} />} href={link} rel="noreferrer noopener" aria-label={`Download ${r.title}`} />
              </Tooltip>
            ) : null}
            <Button size="sm" variant="secondary" loading={grabbing(r)} onClick={() => onGrab(r)} aria-label={`Grab ${r.title}`}>
              Grab
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
    document.title = `${TITLE} · Arclight`;
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
    onSuccess: (res) => toast.push({ tone: 'ok', title: 'Sent to download client', message: res.title }),
    onError: (err, r) => {
      if (isNoMatch(err)) setForceTarget({ release: r, reason: err instanceof Error ? err.message : 'No library match' });
      else toast.push({ tone: 'error', title: 'Grab failed', message: err instanceof Error ? err.message : String(err) });
    },
  });
  const forceGrab = async (r: ReleaseResource) => {
    const res = await indexersApi.searchGrab({ guid: r.guid, indexerId: r.indexerId, force: true });
    setForceTarget(null);
    toast.push({ tone: 'ok', title: res.matched ? 'Sent to download client' : 'Force-grabbed (not tracked in the library)', message: res.title });
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
      <PageHeader index="08" title={TITLE} subtitle="Search every indexer at once." />
      <Pane className="mt-search">
        <form className="mt-search__form" role="search" aria-label="Indexer search" onSubmit={onSubmit}>
          <div className="mt-search__bar">
            <Input size="lg" aria-label="Search query" placeholder="Title, release name…" value={form.query} onChange={(e) => setForm({ ...form, query: e.currentTarget.value })} />
            <Button type="submit" variant="primary" size="lg" icon={<Icon name="search" />} loading={results.isFetching} disabled={!form.query.trim()}>
              Search
            </Button>
          </div>
          <FilterBar activeCount={activeFilters} onClear={() => setForm({ ...form, kind: 'all', categories: [], indexerIds: [] })}>
            <Select
              aria-label="Type"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as SearchKind, categories: [] })}
              options={[
                { value: 'all', label: 'All types' },
                { value: 'series', label: 'TV' },
                { value: 'movie', label: 'Movies' },
              ]}
            />
            <MultiSelect label="Categories" options={catOptions} value={form.categories} onChange={(c) => setForm({ ...form, categories: c })} emptyLabel="All categories" />
            <MultiSelect label="Indexers" options={indexerOptions} value={form.indexerIds} onChange={(ids) => setForm({ ...form, indexerIds: ids })} emptyLabel="All indexers" />
          </FilterBar>
        </form>
      </Pane>

      {request ? (
        <Pane
          flush
          className="mt-search__results"
          title={results.data ? `${rows?.length ?? 0} of ${results.data.length} results` : 'Results'}
          actions={
            <FilterBar
              activeCount={activeRefine}
              onClear={() => {
                setProtocol('all');
                setRefine('');
              }}
            >
              <Input aria-label="Filter results" placeholder="Filter titles" value={refine} onChange={(e) => setRefine(e.currentTarget.value)} />
              <Select
                aria-label="Protocol"
                value={protocol}
                onChange={(e) => setProtocol(e.currentTarget.value as ProtocolFilter)}
                options={[
                  { value: 'all', label: 'Any protocol' },
                  { value: 'torrent', label: 'Torrent' },
                  { value: 'usenet', label: 'Usenet' },
                ]}
              />
            </FilterBar>
          }
        >
          {results.isError ? (
            <ErrorBlock title="Search failed" onRetry={() => void results.refetch()}>
              {errorMessage(results.error)}
            </ErrorBlock>
          ) : (
            <Table
              caption="Search results"
              columns={columns}
              rows={rows}
              rowKey={(r) => `${r.indexerId}:${r.guid}`}
              loading={results.isFetching && !results.data}
              defaultSort={{ key: 'age', direction: 'asc' }}
              empty={<EmptyState title="No results">Try fewer words, another type or more categories.</EmptyState>}
            />
          )}
        </Pane>
      ) : (
        <EmptyState title="Search your indexers" className="mt-search__empty">
          Type a title and press Search. Library matches show in the top bar as you type.
        </EmptyState>
      )}
      {forceTarget ? (
        <ConfirmDialog
          open
          title="Force grab?"
          confirmLabel="Force grab"
          danger={false}
          onCancel={() => setForceTarget(null)}
          onConfirm={() => forceGrab(forceTarget.release)}
        >
          <p>
            <strong className="mt-release__name">{forceTarget.release.title}</strong> does not match anything in your library ({forceTarget.reason}).
          </p>
          <p>Force grabbing sends it to the default {forceTarget.release.protocol} client. It will show as unknown in the queue and will not be imported.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
