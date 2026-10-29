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
import { BulkConfirmDialog } from '../../components/bulk-actions.js';
import { BulkBar } from '../../components/media/bulk-bar.js';
import { useAddBlocklist, useBlocklist, useClearBlocklist, useRemoveBlocklist } from '../../hooks/activity.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { ActivityHeader, Pager } from './activity-shared.js';
import { AudioMediaLabel, isAudioRecord } from './audiobook-media.js';
import { t } from '../../i18n/index.js';

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
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pageIds = (list.data?.records ?? []).map((r) => r.id);
  const selectedIds = pageIds.filter((id) => selected.has(id));
  const pending = list.error instanceof ApiError && list.error.status === 404;
  const total = list.data?.totalRecords ?? 0;

  const columns: Column<BlocklistItem>[] = [
    {
      key: 'sourceTitle',
      header: t('common.sourceTitle'),
      cell: (r) =>
        isAudioRecord(r) ? (
          <div className="al-activity-title">
            <span className="al-activity-break">{r.sourceTitle}</span>
            <span className="al-activity-title__sub">
              <AudioMediaLabel record={r} />
            </span>
          </div>
        ) : (
          <span className="al-activity-break">{r.sourceTitle}</span>
        ),
    },
    { key: 'quality', header: t('common.quality'), mono: true, cell: (r) => r.quality?.quality?.name ?? '—' },
    {
      key: 'protocol',
      header: t('common.prot'),
      width: '64px',
      cell: (r) => (r.protocol === 'torrent' || r.protocol === 'usenet' ? <ProtocolBadge protocol={r.protocol} /> : (r.protocol ?? '—')),
    },
    { key: 'indexer', header: t('common.indexer'), muted: true, cell: (r) => r.indexer ?? '—' },
    { key: 'message', header: t('activity.blocklist.reason'), muted: true, cell: (r) => r.message ?? '' },
    {
      key: 'date',
      header: t('common.date'),
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
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-label={t('activity.blocklist.removeSourcetitleFromBlocklist', { sourceTitle: r.sourceTitle })} onClick={() => remove.mutate([r.id])}>
          {t('common.remove')}
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
              {t('activity.blocklist.clearAll')}
            </Button>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('common.add')}
            </Button>
          </>
        }
      />
      <Pane flush bare className="al-activity-pane">
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what={t('activity.blocklist.blocklist')} />
          </div>
        ) : list.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.blocklist.couldntLoadTheBlocklist')} onRetry={() => void list.refetch()}>
              {errorMessage(list.error)}
            </ErrorBlock>
          </div>
        ) : (
          <>
            <Table
              caption={t('common.blocklist')}
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              rowLabel={(r) => t('activity.blocklist.selectSourcetitle', { sourceTitle: r.sourceTitle })}
              loading={list.isPending}
              sortable={false}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              empty={<EmptyState title={t('activity.blocklist.blocklistIsEmpty')}>{t('activity.blocklist.releasesThatFailedOrWere')}</EmptyState>}
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
      <BulkBar
        count={selectedIds.length}
        total={pageIds.length}
        onSelectAll={() => setSelected(new Set(pageIds))}
        onClear={() => setSelected(new Set())}
        actions={[
          {
            id: 'remove',
            label: selectedIds.length === 1 ? t('activity.blocklist.remove1Release') : t('activity.blocklist.removeKeyscountReleases', { keysCount: selectedIds.length }),
            danger: true,
            loading: remove.isPending,
            onSelect: () => setConfirmRemove(true),
          },
        ]}
      >
        {confirmRemove ? (
          <BulkConfirmDialog
            open
            count={selectedIds.length}
            title={t('activity.blocklist.removeKeyscountReleases', { keysCount: selectedIds.length })}
            confirmLabel={t('common.remove')}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={async () => {
              await remove.mutateAsync(selectedIds);
              toast.push({ tone: 'ok', title: t('activity.blocklist.removedReleases', { deleted: selectedIds.length }), durationMs: 4_000 });
              setSelected(new Set());
              setConfirmRemove(false);
            }}
          />
        ) : null}
      </BulkBar>
      {adding ? <AddBlocklistModal onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={clearing}
        title={t('activity.blocklist.clearTheBlocklist')}
        confirmLabel={t('activity.blocklist.clearAll')}
        onCancel={() => setClearing(false)}
        onConfirm={async () => {
          const r = await clear.mutateAsync();
          toast.push({ tone: 'ok', title: t('activity.blocklist.blocklistCleared'), message: t('activity.blocklist.removedReleases', { deleted: r.deleted }) });
          setClearing(false);
          setSelected(new Set());
          setPage(1);
        }}
      >
        <p>
          {t('common.all')} <span className="al-num">{total}</span> {t('activity.blocklist.blockedReleasesAreRemovedThe')}
        </p>
      </ConfirmDialog>
    </div>
  );
}

type MediaKind = 'series' | 'movie';

const KIND_OPTIONS = [
  { value: 'series' as const, get label() { return t('common.series'); } },
  { value: 'movie' as const, get label() { return t('common.movie'); } },
];

const PROTOCOL_OPTIONS = [
  { value: 'torrent', get label() { return t('common.torrent'); } },
  { value: 'usenet', get label() { return t('common.usenet'); } },
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
  if (d.mediaId === null) return d.kind === 'series' ? t('activity.blocklist.chooseASeries') : t('activity.blocklist.chooseAMovie');
  if (!d.sourceTitle.trim()) return t('activity.blocklist.enterTheSourceTitle');
  const quality = ALL_QUALITIES.find((q) => q.id === d.qualityId) ?? QUALITIES.Unknown;
  return {
    mediaType: d.kind,
    ...(d.kind === 'series' ? { seriesId: d.mediaId } : { movieId: d.mediaId }),
    sourceTitle: d.sourceTitle.trim(),
    quality: { quality: { ...quality, mediaTypes: [...quality.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
    protocol: d.protocol,
    indexer: d.indexer.trim() || null,
    message: d.message.trim() || t('activity.blocklist.addedManually'),
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
  const noun = draft.kind === 'series' ? t('common.series') : t('common.movie');

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
        toast.push({ tone: 'ok', title: t('activity.blocklist.addedToBlocklist'), message: r.sourceTitle });
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('activity.blocklist.addToBlocklist')}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="add-blocklist-form" variant="primary" loading={add.isPending}>
            {t('activity.blocklist.addToBlocklist')}
          </Button>
        </>
      }
    >
      <form id="add-blocklist-form" className="mk-stack-sm" onSubmit={submit} noValidate>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <FormRow label={t('common.type')}>
          <Segmented aria-label={t('common.mediaType')} options={KIND_OPTIONS} value={draft.kind} onChange={(kind) => set({ kind, mediaId: null })} />
        </FormRow>
        <FormRow label={noun}>
          <EntityPicker
            aria-label={t('activity.blocklist.nounToBlock', { noun })}
            placeholder={draft.kind === 'series' ? t('activity.blocklist.chooseASeries2') : t('activity.blocklist.chooseAMovie2')}
            options={options}
            value={draft.mediaId}
            onChange={(mediaId) => set({ mediaId })}
          />
        </FormRow>
        <FormRow label={t('common.sourceTitle')} htmlFor="blocklist-title" caption={t('activity.blocklist.theReleaseNameExactlyAs')}>
          <Input id="blocklist-title" mono value={draft.sourceTitle} onChange={(e) => set({ sourceTitle: e.target.value })} />
        </FormRow>
        <FormRow label={t('common.indexer')} htmlFor="blocklist-indexer">
          <Input id="blocklist-indexer" value={draft.indexer} onChange={(e) => set({ indexer: e.target.value })} />
        </FormRow>
        <FormRow label={t('common.protocol')} htmlFor="blocklist-protocol">
          <Select
            id="blocklist-protocol"
            options={PROTOCOL_OPTIONS}
            value={draft.protocol}
            onChange={(e) => set({ protocol: e.target.value as ReleaseProtocol })}
          />
        </FormRow>
        <FormRow label={t('common.quality')} htmlFor="blocklist-quality">
          <Select
            id="blocklist-quality"
            options={qualities.map((q) => ({ value: String(q.id), label: q.name }))}
            value={String(draft.qualityId)}
            onChange={(e) => set({ qualityId: Number(e.target.value) })}
          />
        </FormRow>
        <FormRow label={t('activity.blocklist.reason')} htmlFor="blocklist-reason">
          <Input id="blocklist-reason" placeholder={t('activity.blocklist.addedManually')} value={draft.message} onChange={(e) => set({ message: e.target.value })} />
        </FormRow>
      </form>
    </Modal>
  );
}
