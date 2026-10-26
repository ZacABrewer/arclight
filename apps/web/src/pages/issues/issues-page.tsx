import { useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { IssueType, Permission, type Issue, type IssueComment } from '@arclight/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Select } from '../../components/form.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Poster } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { titleLink } from '../../features/requests/discover-ui.js';
import { ISSUE_TYPE_LABELS, formatDateTime, usePermissions } from '../../features/requests/status.js';
import {
  useDeleteIssue,
  useDeleteIssueComment,
  useEditIssueComment,
  useIssue,
  useIssueComment,
  useIssues,
  useSetIssueStatus,
} from '../../hooks/requests.js';
import '../../features/requests/requests.css';

type StatusFilter = 'open' | 'resolved' | 'all';
const PAGE_SIZE = 25;

export function problemLabel(issue: Pick<Issue, 'problemSeason' | 'problemEpisode'>): string {
  if (issue.problemSeason === 0) return '';
  return issue.problemEpisode > 0 ? `S${issue.problemSeason}E${issue.problemEpisode}` : `Season ${issue.problemSeason}`;
}

export function IssuesPage() {
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [type, setType] = useState<IssueType | 'all'>('all');
  const [page, setPage] = useState(0);
  const list = useIssues({ filter, take: PAGE_SIZE, skip: page * PAGE_SIZE, sort: 'modified' });
  // The api filters by status; the type filter is applied to the page client-side (no type param in IssueListQuery).
  const rows = (list.data?.results ?? []).filter((i) => type === 'all' || i.type === type);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.pageInfo.total / PAGE_SIZE)) : 1;

  return (
    <Page
      title="Issues"
      actions={
        <div className="row">
          <div className="segmented" role="group" aria-label="Status filter">
            {(['open', 'resolved', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
              >
                {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All'}
              </button>
            ))}
          </div>
          <Select
            aria-label="Issue type filter"
            value={type}
            onChange={(e) => setType(e.currentTarget.value as IssueType | 'all')}
            options={[{ value: 'all', label: 'All types' }, ...IssueType.options.map((t) => ({ value: t, label: ISSUE_TYPE_LABELS[t] }))]}
          />
        </div>
      }
    >
      <Card flush>
        {list.isPending ? (
          <LoadingBlock />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No issues">
            <p className="muted">Report a problem from a title page in Discover.</p>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Reported by</th>
                  <th>Comments</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div className="request-row-title">
                        <Poster url={i.mediaPoster ?? undefined} title={i.mediaTitle} size="sm" />
                        <div>
                          <Link to="/issues/$id" params={{ id: String(i.id) }}>
                            {i.mediaTitle}
                          </Link>
                          <div className="muted small">{[i.mediaYear, problemLabel(i)].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    </td>
                    <td>{ISSUE_TYPE_LABELS[i.type]}</td>
                    <td>
                      <Badge tone={i.status === 'open' ? 'warning' : 'ok'}>{i.status === 'open' ? 'Open' : 'Resolved'}</Badge>
                    </td>
                    <td>{i.createdBy.displayName ?? i.createdBy.username}</td>
                    <td>{i.comments.length}</td>
                    <td>{formatDateTime(i.updatedAt)}</td>
                  </tr>
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
    </Page>
  );
}

const detailRoute = getRouteApi('/issues/$id');

export function IssueDetailPage() {
  const { id } = detailRoute.useParams();
  const issue = useIssue(Number(id));
  if (issue.isPending) return <LoadingBlock />;
  if (issue.isError) return <ErrorView error={issue.error} onRetry={() => void issue.refetch()} />;
  return <IssueView issue={issue.data} />;
}

function IssueView({ issue }: { issue: Issue }) {
  const { can, userId } = usePermissions();
  const navigate = useNavigate();
  const comment = useIssueComment();
  const setStatus = useSetIssueStatus();
  const del = useDeleteIssue();
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState(false);
  const manage = can(Permission.MANAGE_ISSUES);
  const isCreator = userId !== null && issue.createdBy.id === userId;
  const canComment = manage || isCreator;
  const canDelete = manage || (isCreator && issue.comments.length <= 1);

  return (
    <Page
      title={`${ISSUE_TYPE_LABELS[issue.type]} issue: ${issue.mediaTitle}`}
      subtitle={
        <span className="row">
          <Badge tone={issue.status === 'open' ? 'warning' : 'ok'}>{issue.status === 'open' ? 'Open' : 'Resolved'}</Badge>
          <span>
            Reported by {issue.createdBy.displayName ?? issue.createdBy.username} · {formatDateTime(issue.createdAt)}
          </span>
          {problemLabel(issue) ? <span>{problemLabel(issue)}</span> : null}
        </span>
      }
      actions={
        <div className="row">
          <Link className="btn btn-secondary btn-md" {...titleLink(issue.mediaType, issue.mediaTmdbId)}>
            View title
          </Link>
          {canComment ? (
            <Button loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: issue.id, status: issue.status === 'open' ? 'resolved' : 'open' })}>
              {issue.status === 'open' ? 'Resolve' : 'Reopen'}
            </Button>
          ) : null}
          {canDelete ? (
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          ) : null}
        </div>
      }
    >
      <Card title="Comments">
        <ol className="comment-thread" aria-label="Comments">
          {issue.comments.map((c) => (
            <CommentItem key={c.id} c={c} mine={userId !== null && c.user.id === userId} manage={manage} />
          ))}
        </ol>
        {canComment ? (
          <form
            className="stack-sm"
            style={{ marginTop: 'var(--space-4)' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!message.trim()) return;
              comment.mutate({ id: issue.id, message: message.trim() }, { onSuccess: () => setMessage('') });
            }}
          >
            <textarea className="input textarea" rows={3} aria-label="New comment" placeholder="Add a comment" value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
            <div className="row">
              <Button type="submit" variant="primary" loading={comment.isPending} disabled={!message.trim()}>
                Comment
              </Button>
            </div>
          </form>
        ) : null}
      </Card>
      <ConfirmDialog
        open={deleting}
        title="Delete this issue?"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          await del.mutateAsync(issue.id);
          setDeleting(false);
          await navigate({ to: '/issues' });
        }}
      />
    </Page>
  );
}

function CommentItem({ c, mine, manage }: { c: IssueComment; mine: boolean; manage: boolean }) {
  const edit = useEditIssueComment();
  const remove = useDeleteIssueComment();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.message);
  return (
    <li className="comment" aria-label={`Comment by ${c.user.displayName ?? c.user.username}`}>
      <div className="comment-head">
        <strong>{c.user.displayName ?? c.user.username}</strong>
        <span className="muted">
          {formatDateTime(c.createdAt)}
          {c.updatedAt !== c.createdAt ? ' (edited)' : ''}
        </span>
      </div>
      {editing ? (
        <div className="stack-sm">
          <textarea className="input textarea" rows={3} aria-label="Edit comment" value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              loading={edit.isPending}
              disabled={!draft.trim()}
              onClick={() => edit.mutate({ commentId: c.id, message: draft.trim() }, { onSuccess: () => setEditing(false) })}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="comment-body">{c.message}</p>
      )}
      {!editing && (mine || manage) ? (
        <div className="row">
          {mine ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(c.id)}>
            Delete
          </Button>
        </div>
      ) : null}
    </li>
  );
}
