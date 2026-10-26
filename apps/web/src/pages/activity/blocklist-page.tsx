import { useMemo, useState, type FormEvent } from 'react';
import { ALL_QUALITIES, QUALITIES, type BlocklistAddRequestInput, type ReleaseProtocol } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import type { BlocklistItem } from '../../api/blocklist.js';
import {
  Banner,
  Button,
  EmptyState,
  ErrorBlock,
  FormRow,
  Input,
  Modal,
  Pane,
  ProtocolBadge,
  Segmented,
  Select,
  Table,
  type Column,
  type RowKey,
} from '../../arclight/index.js';
import { EntityPicker, type EntityOption } from '../../components/entity-picker.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useToast } from '../../components/toast.js';
import { useAddBlocklist, useBlocklist, useClearBlocklist, useRemoveBlocklist } from '../../hooks/activity.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { ActivityHeader, Pager } from './activity-shared.js';

export function BlocklistPage() {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useBlocklist(page, pageSize);
  const remove = useRemoveBlocklist();
  const clear = useClearBlocklist();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const pending = list.error instanceof ApiError && list.error.status === 404;
  const total = list.data?.totalRecords ?? 0;

  const columns: Column<BlocklistItem>[] = [
    { key: 'sourceTitle', header: 'Source title', cell: (r) => <span className="al-activity-break">{r.sourceTitle}</span> },
    { key: 'quality', header: 'Quality', mono: true, cell: (r) => r.quality?.quality?.name ?? '—' },
    {
      key: 'protocol',
      header: 'Prot',
      width: '64px',
      cell: (r) => (r.protocol === 'torrent' || r.protocol === 'usenet' ? <ProtocolBadge protocol={r.protocol} /> : (r.protocol ?? '—')),
    },
    { key: 'indexer', header: 'Indexer', muted: true, cell: (r) => r.indexer ?? '—' },
    { key: 'message', header: 'Reason', muted: true, cell: (r) => r.message ?? '' },
    {
      key: 'date',
      header: 'Date',
      mono: true,
      align: 'right',
      cell: (r) => (
        <time dateTime={r.date} title={formatDateTime(r.date)}>
          {relativeTime(r.date)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-label={`Remove ${r.sourceTitle} from blocklist`} onClick={() => remove.mutate([r.id])}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <div className="al-activity">
      <ActivityHeader
        active="blocklist"
        actions={
          <>
            <Button variant="danger" disabled={total === 0} onClick={() => setClearing(true)}>
              Clear all
            </Button>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add
            </Button>
          </>
        }
      />
      <Pane flush bare className="al-activity-pane">
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what="blocklist" />
          </div>
        ) : list.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title="Couldn't load the blocklist" onRetry={() => void list.refetch()}>
              {errorMessage(list.error)}
            </ErrorBlock>
          </div>
        ) : (
          <>
            <Table
              caption="Blocklist"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              rowLabel={(r) => `Select ${r.sourceTitle}`}
              loading={list.isPending}
              sortable={false}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              bulkActions={(keys, clearSelection) => (
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => remove.mutate([...keys].map(Number), { onSuccess: clearSelection })}
                >
                  {keys.size === 1 ? 'Remove 1 release' : `Remove ${keys.size} releases`}
                </Button>
              )}
              empty={<EmptyState title="Blocklist is empty">Releases that failed or were rejected manually are listed here.</EmptyState>}
            />
            {list.data && list.data.totalRecords > pageSize ? (
              <footer className="al-activity-foot">
                <span className="al-activity-spacer" />
                <Pager page={page} pageSize={pageSize} total={list.data.totalRecords} onPage={setPage} />
              </footer>
            ) : null}
          </>
        )}
      </Pane>
      {adding ? <AddBlocklistModal onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={clearing}
        title="Clear the blocklist?"
        confirmLabel="Clear all"
        onCancel={() => setClearing(false)}
        onConfirm={async () => {
          const r = await clear.mutateAsync();
          toast.push({ tone: 'ok', title: 'Blocklist cleared', message: `Removed ${r.deleted} ${r.deleted === 1 ? 'release' : 'releases'}.` });
          setClearing(false);
          setSelected(new Set());
          setPage(1);
        }}
      >
        <p>
          All <span className="al-num">{total}</span> blocked releases are removed. The next search can grab them again.
        </p>
      </ConfirmDialog>
    </div>
  );
}

type MediaKind = 'series' | 'movie';

const KIND_OPTIONS = [
  { value: 'series' as const, label: 'Series' },
  { value: 'movie' as const, label: 'Movie' },
];

const PROTOCOL_OPTIONS = [
  { value: 'torrent', label: 'Torrent' },
  { value: 'usenet', label: 'Usenet' },
];

export interface BlocklistDraft {
  kind: MediaKind;
  mediaId: number | null;
  sourceTitle: string;
  indexer: string;
  protocol: ReleaseProtocol;
  qualityId: number;
  message: string;
}

/** The POST /blocklist body for a draft, or a sentence saying what is missing. */
export function blocklistBody(d: BlocklistDraft): BlocklistAddRequestInput | string {
  if (d.mediaId === null) return d.kind === 'series' ? 'Choose a series.' : 'Choose a movie.';
  if (!d.sourceTitle.trim()) return 'Enter the source title.';
  const quality = ALL_QUALITIES.find((q) => q.id === d.qualityId) ?? QUALITIES.Unknown;
  return {
    mediaType: d.kind,
    ...(d.kind === 'series' ? { seriesId: d.mediaId } : { movieId: d.mediaId }),
    sourceTitle: d.sourceTitle.trim(),
    quality: { quality: { ...quality, mediaTypes: [...quality.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
    protocol: d.protocol,
    indexer: d.indexer.trim() || null,
    message: d.message.trim() || 'Added manually',
  };
}

/** 560px "Add to blocklist": series or movie, source title, indexer, protocol, quality, reason. */
export function AddBlocklistModal({ onClose }: { onClose: () => void }) {
  const add = useAddBlocklist();
  const toast = useToast();
  const series = useSeriesList();
  const movies = useMovieList();
  const [draft, setDraft] = useState<BlocklistDraft>({
    kind: 'series',
    mediaId: null,
    sourceTitle: '',
    indexer: '',
    protocol: 'torrent',
    qualityId: QUALITIES.Unknown.id,
    message: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<BlocklistDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const options = useMemo<EntityOption[]>(() => {
    const items = draft.kind === 'series' ? (series.data ?? []) : (movies.data ?? []);
    return items.map((m) => ({ id: m.id, label: m.title, detail: m.year ? String(m.year) : undefined }));
  }, [draft.kind, series.data, movies.data]);
  const qualities = ALL_QUALITIES.filter((q) => q.id === QUALITIES.Unknown.id || q.mediaTypes.includes(draft.kind));
  const noun = draft.kind === 'series' ? 'Series' : 'Movie';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = blocklistBody(draft);
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setError(null);
    add.mutate(body, {
      onSuccess: (r) => {
        toast.push({ tone: 'ok', title: 'Added to blocklist', message: r.sourceTitle });
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add to blocklist"
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-blocklist-form" variant="primary" loading={add.isPending}>
            Add to blocklist
          </Button>
        </>
      }
    >
      <form id="add-blocklist-form" className="mk-stack-sm" onSubmit={submit} noValidate>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <FormRow label="Type">
          <Segmented aria-label="Media type" options={KIND_OPTIONS} value={draft.kind} onChange={(kind) => set({ kind, mediaId: null })} />
        </FormRow>
        <FormRow label={noun}>
          <EntityPicker
            aria-label={`${noun} to block`}
            placeholder={draft.kind === 'series' ? 'Choose a series…' : 'Choose a movie…'}
            options={options}
            value={draft.mediaId}
            onChange={(mediaId) => set({ mediaId })}
          />
        </FormRow>
        <FormRow label="Source title" htmlFor="blocklist-title" caption="The release name exactly as the indexer lists it.">
          <Input id="blocklist-title" mono value={draft.sourceTitle} onChange={(e) => set({ sourceTitle: e.target.value })} />
        </FormRow>
        <FormRow label="Indexer" htmlFor="blocklist-indexer">
          <Input id="blocklist-indexer" value={draft.indexer} onChange={(e) => set({ indexer: e.target.value })} />
        </FormRow>
        <FormRow label="Protocol" htmlFor="blocklist-protocol">
          <Select
            id="blocklist-protocol"
            options={PROTOCOL_OPTIONS}
            value={draft.protocol}
            onChange={(e) => set({ protocol: e.target.value as ReleaseProtocol })}
          />
        </FormRow>
        <FormRow label="Quality" htmlFor="blocklist-quality">
          <Select
            id="blocklist-quality"
            options={qualities.map((q) => ({ value: String(q.id), label: q.name }))}
            value={String(draft.qualityId)}
            onChange={(e) => set({ qualityId: Number(e.target.value) })}
          />
        </FormRow>
        <FormRow label="Reason" htmlFor="blocklist-reason">
          <Input id="blocklist-reason" placeholder="Added manually" value={draft.message} onChange={(e) => set({ message: e.target.value })} />
        </FormRow>
      </form>
    </Modal>
  );
}
