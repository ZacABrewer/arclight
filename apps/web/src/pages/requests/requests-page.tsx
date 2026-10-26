import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission, type MediaRequest, type RequestFilter, type RequestListQuery } from '@arclight/shared';
import { kindOf } from '../../api/requests.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Select } from '../../components/form.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { TagPicker } from '../../components/forms/tag-picker.js';
import { Poster } from '../../components/media/media-ui.js';
import { Modal } from '../../components/modal.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Tabs } from '../../components/tabs.js';
import { useToast } from '../../components/toast.js';
import { titleLink } from '../../features/requests/discover-ui.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useQualityProfiles, useRootFolders } from '../../hooks/library.js';
import {
  useApproveRequest,
  useBulkRequestAction,
  useDeclineRequest,
  useDeleteRequest,
  useRequests,
  useRetryRequest,
  useTitle,
  useUpdateRequest,
} from '../../hooks/requests.js';
import { EditorFooter } from '../settings/shared.js';
import '../../features/requests/requests.css';
import '../../components/media/media.css';

export const REQUEST_TABS: ReadonlyArray<{ id: RequestFilter; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'declined', label: 'Declined' },
  { id: 'available', label: 'Available' },
  { id: 'all', label: 'All' },
];

const PAGE_SIZE = 20;

export function RequestsPage() {
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const [tab, setTab] = useState<RequestFilter>(manage ? 'pending' : 'all');
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'series'>('all');

  return (
    <Page
      title="Requests"
      subtitle={can(Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW) ? 'Everyone’s requests' : 'Your requests'}
      actions={
        <Select
          aria-label="Media type filter"
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value as typeof mediaType)}
          options={[
            { value: 'all', label: 'Movies and series' },
            { value: 'movie', label: 'Movies' },
            { value: 'series', label: 'Series' },
          ]}
        />
      }
    >
      <Tabs
        value={tab}
        onChange={(id) => setTab(id as RequestFilter)}
        tabs={REQUEST_TABS.map((t) => ({
          id: t.id,
          label: t.label,
          content: <RequestList key={`${t.id}-${mediaType}`} filter={t.id} mediaType={mediaType} manage={manage} />,
        }))}
      />
    </Page>
  );
}

function RequestList({ filter, mediaType, manage }: { filter: RequestFilter; mediaType: 'all' | 'movie' | 'series'; manage: boolean }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const query: RequestListQuery = { filter, mediaType, take: PAGE_SIZE, skip: page * PAGE_SIZE, sort: 'added', sortDirection: 'desc' };
  const list = useRequests(query);
  const bulkApprove = useBulkRequestAction('approve');
  const bulkDecline = useBulkRequestAction('decline');
  const toast = useToast();

  if (list.isPending) return <LoadingBlock />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => void list.refetch()} />;
  const { results, pageInfo } = list.data;
  const pending = results.filter((r) => r.status === 'pending');
  const pages = Math.max(1, Math.ceil(pageInfo.total / PAGE_SIZE));

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

  return (
    <Card flush>
      {manage && selected.length > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span>{selected.length} selected</span>
          <Button size="sm" variant="primary" loading={bulkApprove.isPending} onClick={() => runBulk('approve')}>
            Approve selected
          </Button>
          <Button size="sm" variant="danger" loading={bulkDecline.isPending} onClick={() => runBulk('decline')}>
            Decline selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      ) : null}
      {results.length === 0 ? (
        <EmptyState title="No requests" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {manage ? (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all pending"
                      disabled={pending.length === 0}
                      checked={pending.length > 0 && pending.every((r) => selected.includes(r.id))}
                      onChange={(e) => setSelected(e.currentTarget.checked ? pending.map((r) => r.id) : [])}
                    />
                  </th>
                ) : null}
                <th>Title</th>
                <th>Requested by</th>
                <th>Seasons</th>
                <th>Status</th>
                <th>Requested</th>
                <th>Modified</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <RequestRow
                  key={r.id}
                  r={r}
                  manage={manage}
                  selected={selected.includes(r.id)}
                  onSelect={(on) => setSelected((prev) => (on ? [...prev, r.id] : prev.filter((x) => x !== r.id)))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <div className="pager">
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="pager-info">
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function RequestTitle({ r }: { r: MediaRequest }) {
  return (
    <div className="request-row-title">
      <Poster url={r.mediaPoster ?? undefined} title={r.mediaTitle} size="sm" />
      <div>
        <Link {...titleLink(r.type, r.mediaTmdbId)}>{r.mediaTitle}</Link>
        <div className="muted small">
          {[r.mediaYear, r.type === 'movie' ? 'Movie' : 'Series', r.is4k ? '4K' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  );
}

function RequestRow({ r, manage, selected, onSelect }: { r: MediaRequest; manage: boolean; selected: boolean; onSelect: (on: boolean) => void }) {
  const approve = useApproveRequest();
  const retry = useRetryRequest();
  const del = useDeleteRequest();
  const [declining, setDeclining] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const status = REQUEST_STATUS_META[r.status];

  return (
    <tr>
      {manage ? (
        <td>
          <input type="checkbox" aria-label={`Select ${r.mediaTitle}`} disabled={r.status !== 'pending'} checked={selected} onChange={(e) => onSelect(e.currentTarget.checked)} />
        </td>
      ) : null}
      <td>
        <RequestTitle r={r} />
      </td>
      <td>{r.requestedBy.displayName ?? r.requestedBy.username}</td>
      <td>{seasonsLabel(r.seasons) || '—'}</td>
      <td>
        <div className="chip-stack">
          <Badge tone={status.tone}>{status.label}</Badge>
          {r.status === 'approved' || r.status === 'completed' ? (
            <Badge tone={MEDIA_STATUS_META[r.mediaStatus].tone}>{MEDIA_STATUS_META[r.mediaStatus].label}</Badge>
          ) : null}
          {r.declineReason ? <span className="muted small">{r.declineReason}</span> : null}
          {r.failureReason ? <span className="text-error small">{r.failureReason}</span> : null}
        </div>
      </td>
      <td>{formatDateTime(r.createdAt)}</td>
      <td>
        {formatDateTime(r.updatedAt)}
        {r.modifiedBy ? <div className="muted small">by {r.modifiedBy.displayName ?? r.modifiedBy.username}</div> : null}
      </td>
      <td className="align-right">
        <div className="row row-end">
          {manage && r.status === 'pending' ? (
            <>
              <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate({ id: r.id })}>
                Approve
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDeclining(true)}>
                Decline
              </Button>
            </>
          ) : null}
          {r.status === 'pending' && (manage || r.canRemove) ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {manage && r.status === 'failed' ? (
            <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(r.id)}>
              Retry
            </Button>
          ) : null}
          {r.canRemove ? (
            <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          ) : null}
        </div>
        {declining ? <DeclineDialog request={r} onClose={() => setDeclining(false)} /> : null}
        {editing ? <EditRequestDialog request={r} onClose={() => setEditing(false)} /> : null}
        <ConfirmDialog
          open={deleting}
          title={`Delete the request for ${r.mediaTitle}?`}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await del.mutateAsync(r.id);
            setDeleting(false);
          }}
        >
          The title stays in the library if it was already added.
        </ConfirmDialog>
      </td>
    </tr>
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
      size="sm"
      footer={
        <EditorFooter
          onCancel={onClose}
          saveLabel="Decline"
          saving={decline.isPending}
          onSave={() => decline.mutate({ id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }, { onSuccess: onClose })}
        />
      }
    >
      <FormField label="Reason (optional)" hint="Shown to the requester.">
        <textarea className="input textarea" rows={3} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </FormField>
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
    <Modal open onClose={onClose} title={`Edit request: ${request.mediaTitle}`} footer={<EditorFooter onCancel={onClose} onSave={save} saving={update.isPending} />}>
      <div className="stack-sm">
        {isSeries ? (
          <fieldset className="perm-group">
            <legend>Seasons</legend>
            <div className="check-grid">
              {seasonChoices.map((n) => (
                <label key={n} className="check">
                  <input
                    type="checkbox"
                    checked={seasons.includes(n)}
                    onChange={(e) => setSeasons((prev) => (e.currentTarget.checked ? [...prev, n] : prev.filter((x) => x !== n)))}
                  />
                  {n === 0 ? 'Specials' : `Season ${n}`}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <FormField label="Root folder">
          <Select value={rootFolderPath} onChange={(e) => setRootFolderPath(e.currentTarget.value)}>
            <option value="">Default</option>
            {(rootFolders.data ?? [])
              .filter((f) => f.mediaType === request.type)
              .map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
          </Select>
        </FormField>
        <FormField label="Quality profile">
          <Select value={profileId} onChange={(e) => setProfileId(e.currentTarget.value)}>
            <option value="">Default</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tags">
          <TagPicker value={tags} onChange={setTags} />
        </FormField>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
