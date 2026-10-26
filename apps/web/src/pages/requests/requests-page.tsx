import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission, type MediaRequest, type RequestFilter, type RequestListQuery } from '@arclight/shared';
import { kindOf } from '../../api/requests.js';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FloatBar,
  FloatBarDivider,
  FormRow,
  Modal,
  PageHeader,
  Pane,
  Paginator,
  Poster,
  Select,
  Table,
  Tabs,
  Textarea,
  type Column,
} from '../../arclight/index.js';
import { Loading, QueryError, SwipeRow, useIsMobile } from '../../components/media/media-kit.js';
import { TagPicker } from '../../components/media/tag-picker.js';
import { useToast } from '../../components/toast.js';
import { titleLink } from '../../features/requests/title-link.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { formatDateTime } from '../../lib/ui-preferences.js';
import { useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import {
  useBulkRequestAction,
  useDeclineRequest,
  useDeleteRequest,
  useRequests,
  useRetryRequest,
  useTitle,
  useUpdateRequest,
} from '../../hooks/requests.js';
import { StatusLabelChip } from '../discover/discover-kit.js';
import { ApproveDialog } from './approve-dialog.js';
import '../../components/media/media-kit.css';

export const REQUEST_TABS: ReadonlyArray<{ id: RequestFilter; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'declined', label: 'Declined' },
  { id: 'available', label: 'Available' },
  { id: 'all', label: 'All' },
];

const PAGE_SIZE = 20;

type MediaFilter = 'all' | 'movie' | 'series';

export function RequestsPage() {
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const [tab, setTab] = useState<RequestFilter>(manage ? 'pending' : 'all');
  const [mediaType, setMediaType] = useState<MediaFilter>('all');

  return (
    <>
      <PageHeader
        index="03"
        title="Requests"
        subtitle={can(Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW) ? 'Everyone’s requests' : 'Your requests'}
        actions={
          <>
            <Select
              aria-label="Media type filter"
              value={mediaType}
              onChange={(e) => setMediaType(e.currentTarget.value as MediaFilter)}
              options={[
                { value: 'all', label: 'Movies and series' },
                { value: 'movie', label: 'Movies' },
                { value: 'series', label: 'Series' },
              ]}
            />
            <Link className="al-btn al-btn--secondary" to="/requests/mine">
              My requests
            </Link>
          </>
        }
      >
        <Tabs compact aria-label="Request status" value={tab} onChange={(id) => setTab(id as RequestFilter)} tabs={REQUEST_TABS.map((t) => ({ id: t.id, label: t.label }))} />
      </PageHeader>
      <RequestList key={`${tab}-${mediaType}`} filter={tab} mediaType={mediaType} manage={manage} />
    </>
  );
}

function RequestList({ filter, mediaType, manage }: { filter: RequestFilter; mediaType: MediaFilter; manage: boolean }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const query: RequestListQuery = { filter, mediaType, take: PAGE_SIZE, skip: page * PAGE_SIZE, sort: 'added', sortDirection: 'desc' };
  const list = useRequests(query);
  const bulkApprove = useBulkRequestAction('approve');
  const bulkDecline = useBulkRequestAction('decline');
  const toast = useToast();
  const mobile = useIsMobile();

  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title="Could not load requests" onRetry={() => void list.refetch()} />;
  const { results, pageInfo } = list.data;
  const pending = results.filter((r) => r.status === 'pending');
  const pages = Math.max(1, Math.ceil(pageInfo.total / PAGE_SIZE));
  const toggle = (id: number, on: boolean) => setSelected((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  const runBulk = (action: 'approve' | 'decline') => {
    const m = action === 'approve' ? bulkApprove : bulkDecline;
    m.mutate(selected, {
      onSuccess: (res) => {
        setSelected([]);
        toast.push({
          tone: res.failed.length ? 'warning' : 'ok',
          title: `${action === 'approve' ? 'Approved' : 'Declined'} ${res.ok.length} request${res.ok.length === 1 ? '' : 's'}`,
          message: res.failed.length ? res.failed.map((f) => `#${f.id}: ${f.error}`).join('; ') : undefined,
        });
      },
    });
  };

  const columns: Column<MediaRequest>[] = [
    ...(manage
      ? [
          {
            key: 'select',
            width: '44px',
            header: (
              <Checkbox
                aria-label="Select all pending"
                disabled={pending.length === 0}
                checked={pending.length > 0 && pending.every((r) => selected.includes(r.id))}
                onChange={(e) => setSelected(e.currentTarget.checked ? pending.map((r) => r.id) : [])}
              />
            ),
            cell: (r: MediaRequest) => (
              <Checkbox aria-label={`Select ${r.mediaTitle}`} disabled={r.status !== 'pending'} checked={selected.includes(r.id)} onChange={(e) => toggle(r.id, e.currentTarget.checked)} />
            ),
          },
        ]
      : []),
    { key: 'title', header: 'Title', cell: (r) => <RequestTitle r={r} /> },
    { key: 'by', header: 'Requested by', cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
    { key: 'seasons', header: 'Seasons', mono: true, cell: (r) => seasonsLabel(r.seasons) || '—' },
    { key: 'status', header: 'Status', cell: (r) => <RequestStatusCell r={r} /> },
    { key: 'created', header: 'Requested', mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
    {
      key: 'modified',
      header: 'Modified',
      mono: true,
      muted: true,
      cell: (r) => (
        <>
          {formatDateTime(r.updatedAt)}
          {r.modifiedBy ? <div className="mk-title-cell__sub">by {r.modifiedBy.displayName ?? r.modifiedBy.username}</div> : null}
        </>
      ),
    },
    { key: 'actions', header: <span className="al-sr-only">Actions</span>, align: 'right', cell: (r) => <RequestActions r={r} manage={manage} /> },
  ];

  return (
    <>
      {results.length === 0 ? (
        <EmptyState title="No requests">Requests made from Discover show up here.</EmptyState>
      ) : mobile ? (
        <div className="mk-mlist">
          {results.map((r) => (
            <MobileRequestRow key={r.id} r={r} manage={manage} />
          ))}
        </div>
      ) : (
        <Pane flush bare>
          <Table columns={columns} rows={results} rowKey={(r) => r.id} density="rich" sortable={false} caption="Requests" />
        </Pane>
      )}
      {pages > 1 ? (
        <div className="mk-row mk-row--end" style={{ marginTop: 16 }}>
          <Paginator page={page + 1} pageCount={pages} onPageChange={(p) => setPage(p - 1)} />
        </div>
      ) : null}
      {manage && selected.length > 0 ? (
        <FloatBar count={selected.length}>
          <Button variant="secondary" loading={bulkApprove.isPending} onClick={() => runBulk('approve')}>
            Approve selected
          </Button>
          <FloatBarDivider />
          <Button variant="danger" loading={bulkDecline.isPending} onClick={() => runBulk('decline')}>
            Decline selected
          </Button>
          <Button variant="ghost" className="al-floatbar__cancel" onClick={() => setSelected([])}>
            Cancel
          </Button>
        </FloatBar>
      ) : null}
    </>
  );
}

/** Poster + linked title + "1999 · Movie · 4K". Also used by the dashboard requests card. */
export function RequestTitle({ r }: { r: MediaRequest }) {
  return (
    <div className="mk-title-cell">
      <Poster src={r.mediaPoster} title={r.mediaTitle} width={32} />
      <div className="mk-title-cell__text">
        <Link className="mk-link" {...titleLink(r.type, r.mediaTmdbId)}>
          {r.mediaTitle}
        </Link>
        <span className="mk-title-cell__sub">
          {r.mediaYear ? <span className="al-num">{r.mediaYear}</span> : null}
          {r.mediaYear ? ' · ' : ''}
          {[r.type === 'movie' ? 'Movie' : 'Series', r.is4k ? '4K' : null].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}

function RequestStatusCell({ r }: { r: MediaRequest }) {
  return (
    <div className="mk-stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
      <div className="mk-row" style={{ gap: 6 }}>
        <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
        {r.status === 'approved' || r.status === 'completed' ? <StatusLabelChip label={MEDIA_STATUS_META[r.mediaStatus].label} /> : null}
      </div>
      {r.declineReason ? <span className="mk-title-cell__sub">{r.declineReason}</span> : null}
      {r.failureReason ? <span className="mk-title-cell__sub" style={{ color: 'var(--al-danger-text)' }}>{r.failureReason}</span> : null}
    </div>
  );
}

function useRowDialogs() {
  const [approving, setApproving] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return { approving, setApproving, declining, setDeclining, editing, setEditing, deleting, setDeleting };
}

function RequestActions({ r, manage }: { r: MediaRequest; manage: boolean }) {
  const retry = useRetryRequest();
  const d = useRowDialogs();
  return (
    <div className="mk-row mk-row--end">
      {manage && r.status === 'pending' ? (
        <>
          <Button size="sm" onClick={() => d.setApproving(true)}>
            Approve
          </Button>
          <Button size="sm" variant="danger" onClick={() => d.setDeclining(true)}>
            Decline
          </Button>
        </>
      ) : null}
      {r.status === 'pending' && (manage || r.canRemove) ? (
        <Button size="sm" variant="ghost" onClick={() => d.setEditing(true)}>
          Edit
        </Button>
      ) : null}
      {manage && r.status === 'failed' ? (
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(r.id)}>
          Retry
        </Button>
      ) : null}
      {r.canRemove ? (
        <Button size="sm" variant="ghost" onClick={() => d.setDeleting(true)}>
          Delete
        </Button>
      ) : null}
      <RowDialogs r={r} {...d} />
    </div>
  );
}

function RowDialogs({ r, approving, setApproving, declining, setDeclining, editing, setEditing, deleting, setDeleting }: { r: MediaRequest } & ReturnType<typeof useRowDialogs>) {
  return (
    <>
      {approving ? <ApproveDialog request={r} onClose={() => setApproving(false)} /> : null}
      {declining ? <DeclineDialog request={r} onClose={() => setDeclining(false)} /> : null}
      {editing ? <EditRequestDialog request={r} onClose={() => setEditing(false)} /> : null}
      {deleting ? <DeleteRequestDialog request={r} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

/** Mobile row: swipe right reveals Delete; approve/decline stay visible for admins. */
function MobileRequestRow({ r, manage }: { r: MediaRequest; manage: boolean }) {
  const d = useRowDialogs();
  return (
    <SwipeRow onDelete={r.canRemove ? () => d.setDeleting(true) : undefined} deleteLabel="Delete">
      <div className="mk-mrow">
        <div style={{ minWidth: 0 }}>
          <RequestTitle r={r} />
          <div style={{ marginTop: 6 }}>
            <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
          </div>
        </div>
        {manage && r.status === 'pending' ? (
          <div className="mk-stack-sm" style={{ gap: 6 }}>
            <Button size="sm" onClick={() => d.setApproving(true)}>
              Approve
            </Button>
            <Button size="sm" variant="danger" onClick={() => d.setDeclining(true)}>
              Decline
            </Button>
          </div>
        ) : null}
      </div>
      <RowDialogs r={r} {...d} />
    </SwipeRow>
  );
}

function DeleteRequestDialog({ request, onClose }: { request: MediaRequest; onClose: () => void }) {
  const del = useDeleteRequest();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete the request for ${request.mediaTitle}?`}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(request.id, { onSuccess: onClose })}>
            Delete request
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>The title stays in the library if it was already added.</p>
    </Modal>
  );
}

export function DeclineDialog({ request, onClose }: { request: MediaRequest; onClose: () => void }) {
  const decline = useDeclineRequest();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Decline ${request.mediaTitle}?`}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={decline.isPending}
            onClick={() => decline.mutate({ id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }, { onSuccess: onClose })}
          >
            Decline request
          </Button>
        </>
      }
    >
      <Field label="Reason (optional)" hint="Shown to the requester.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </Field>
    </Modal>
  );
}

function EditRequestDialog({ request, onClose }: { request: MediaRequest; onClose: () => void }) {
  const update = useUpdateRequest();
  const rootFolders = useRootFolders();
  const profiles = useQualityProfiles();
  const isSeries = request.type === 'series';
  const title = useTitle(kindOf(request.type), isSeries ? request.mediaTmdbId : 0);
  const [seasons, setSeasons] = useState<number[]>(request.seasons.map((s) => s.seasonNumber));
  const [rootFolderPath, setRootFolderPath] = useState(request.rootFolderPath ?? '');
  const [profileId, setProfileId] = useState(request.qualityProfileId ? String(request.qualityProfileId) : '');
  const [tags, setTags] = useState<number[]>(request.tags);
  const [error, setError] = useState<string | null>(null);
  const seasonChoices = title.data?.seasons.map((s) => s.seasonNumber) ?? request.seasons.map((s) => s.seasonNumber);

  const save = () => {
    if (isSeries && seasons.length === 0) {
      setError('Keep at least one season.');
      return;
    }
    update.mutate(
      {
        id: request.id,
        body: {
          ...(isSeries ? { seasons: [...seasons].sort((a, b) => a - b) } : {}),
          rootFolderPath: rootFolderPath || null,
          qualityProfileId: profileId ? Number(profileId) : null,
          tags,
        },
      },
      { onSuccess: onClose, onError: (err) => setError(err.message) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit request: ${request.mediaTitle}`}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        {isSeries ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="al-label" style={{ marginBottom: 10 }}>
              Seasons
            </legend>
            <div className="mk-check-grid">
              {seasonChoices.map((n) => (
                <Checkbox
                  key={n}
                  label={n === 0 ? 'Specials' : `Season ${n}`}
                  checked={seasons.includes(n)}
                  onChange={(e) => setSeasons((prev) => (e.currentTarget.checked ? [...prev, n] : prev.filter((x) => x !== n)))}
                />
              ))}
            </div>
          </fieldset>
        ) : null}
        <FormRow label="Root folder" htmlFor="edit-request-root">
          <Select id="edit-request-root" value={rootFolderPath} onChange={(e) => setRootFolderPath(e.currentTarget.value)}>
            <option value="">Default folder</option>
            {(rootFolders.data ?? [])
              .filter((f) => f.mediaType === request.type)
              .map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
          </Select>
        </FormRow>
        <FormRow label="Quality target" htmlFor="edit-request-profile">
          <Select id="edit-request-profile" value={profileId} onChange={(e) => setProfileId(e.currentTarget.value)}>
            <option value="">Default profile</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label="Tags">
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
        {error ? (
          <p className="al-field__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
