import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReleaseResource } from '@media-tron/shared';
import { indexersApi } from '../api/indexers.js';
import { ConfirmDialog } from '../components/forms/confirm-dialog.js';
import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import { Card } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { ErrorView } from '../components/error-boundary.js';
import { Input, Select } from '../components/form.js';
import { MultiSelect } from '../components/multi-select.js';
import { Page } from '../components/page.js';
import { Table, type Column } from '../components/table.js';
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
  toSearchRequest,
  type ProtocolFilter,
  type SearchForm,
  type SearchKind,
} from './search-model.js';

const route = getRouteApi('/search');

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

  const columns: Column<ReleaseResource>[] = [
    { key: 'age', header: 'Age', sortValue: (r) => r.ageMinutes, cell: (r) => <span title={formatDateTime(r.publishDate)}>{formatAge(r)}</span> },
    {
      key: 'title',
      header: 'Title',
      sortValue: (r) => r.title,
      cell: (r) =>
        r.infoUrl ? (
          <a href={r.infoUrl} target="_blank" rel="noreferrer noopener" className="break">
            {r.title}
          </a>
        ) : (
          <span className="break">{r.title}</span>
        ),
    },
    { key: 'indexer', header: 'Indexer', sortValue: (r) => r.indexerName, cell: (r) => r.indexerName },
    { key: 'size', header: 'Size', align: 'right', sortValue: (r) => r.size, cell: (r) => formatBytes(r.size) },
    {
      key: 'peers',
      header: 'Peers',
      align: 'right',
      sortValue: (r) => (r.protocol === 'torrent' ? (r.seeders ?? -1) : (r.grabs ?? -1)),
      cell: (r) => peersLabel(r),
    },
    { key: 'protocol', header: 'Protocol', sortValue: (r) => r.protocol, cell: (r) => <Badge tone={r.protocol === 'torrent' ? 'info' : 'neutral'}>{r.protocol}</Badge> },
    {
      key: 'categories',
      header: 'Categories',
      cell: (r) => <span className="muted">{r.categories.map((c) => names.get(c) ?? String(c)).join(', ') || '—'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => {
        const link = downloadLink(r);
        return (
          <span className="nowrap">
            {link ? (
              <a className="btn btn-ghost btn-sm" href={link} rel="noreferrer noopener" aria-label={`Download ${r.title}`}>
                {link.startsWith('magnet:') ? 'magnet' : r.protocol === 'torrent' ? '.torrent' : '.nzb'}
              </a>
            ) : null}
            <Button size="sm" variant="ghost" loading={grab.isPending && grab.variables?.guid === r.guid} onClick={() => grab.mutate(r)} aria-label={`Grab ${r.title}`}>
              Grab
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <Page title="Search" subtitle="Search every indexer at once">
      <Card>
        <form className="search-form" role="search" aria-label="Indexer search" onSubmit={onSubmit}>
          <Input aria-label="Search query" placeholder="Title, release name…" value={form.query} onChange={(e) => setForm({ ...form, query: e.currentTarget.value })} />
          <Select
            aria-label="Type"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as SearchKind, categories: [] })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'series', label: 'TV' },
              { value: 'movie', label: 'Movies' },
            ]}
          />
          <MultiSelect label="Categories" options={catOptions} value={form.categories} onChange={(categories) => setForm({ ...form, categories })} emptyLabel="All categories" />
          <MultiSelect label="Indexers" options={indexerOptions} value={form.indexerIds} onChange={(indexerIds) => setForm({ ...form, indexerIds })} emptyLabel="All indexers" />
          <Button type="submit" variant="primary" loading={results.isFetching} disabled={!form.query.trim()}>
            Search
          </Button>
        </form>
      </Card>

      {request ? (
        <Card
          flush
          title={results.data ? `${rows?.length ?? 0} of ${results.data.length} results` : 'Results'}
          actions={
            <span className="row">
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
            </span>
          }
        >
          {results.isError ? (
            <ErrorView error={results.error} onRetry={() => void results.refetch()} />
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
        </Card>
      ) : (
        <EmptyState title="Search your indexers">Type a title and press Search. Library matches show in the top bar as you type.</EmptyState>
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
            <strong className="break">{forceTarget.release.title}</strong> does not match anything in your library ({forceTarget.reason}).
          </p>
          <p className="muted">Force grabbing sends it to the default {forceTarget.release.protocol} client. It will show as unknown in the queue and will not be imported.</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
