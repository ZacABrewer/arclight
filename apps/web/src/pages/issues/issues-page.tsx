import { useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { IssueType, Permission, type Issue, type IssueComment, type RequestUser } from '@arclight/shared';
import {
  Button,
  Chip,
  EmptyState,
  FilterBar,
  Modal,
  PageHeader,
  Pane,
  Paginator,
  Poster,
  Segmented,
  Select,
  Table,
  Textarea,
  type Column,
} from '../../arclight/index.js';
import { Loading, QueryError } from '../../components/media/media-kit.js';
import { titleLink } from '../../features/requests/title-link.js';
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
import '../../components/media/media-kit.css';
import { t } from '../../i18n/index.js';

type StatusFilter = 'open' | 'resolved' | 'all';
const PAGE_SIZE = 25;

export function problemLabel(issue: Pick<Issue, 'problemSeason' | 'problemEpisode'>): string {
  if (issue.problemSeason === 0) return '';
  return issue.problemEpisode > 0 ? t('issues.sProblemseasonEProblemepisode', { problemSeason: issue.problemSeason, problemEpisode: issue.problemEpisode }) : t('issues.seasonProblemseason', { problemSeason: issue.problemSeason });
}

export function userName(u: Pick<RequestUser, 'username' | 'displayName'>): string {
  return u.displayName ?? u.username;
}

/** Two-letter initials for the square avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[1]![0]}`;
}

function IssueStatusChip({ status }: { status: Issue['status'] }) {
  return status === 'open' ? <Chip tone="warn">{t('common.open')}</Chip> : <Chip tone="accent" dot="ring">{t('issues.resolved')}</Chip>;
}

const columns: Column<Issue>[] = [
  {
    key: 'title',
    get header() {
      return t('common.title');
    },
    cell: (i) => (
      <div className="mk-title-cell">
        <Poster src={i.mediaPoster} title={i.mediaTitle} width={32} />
        <div className="mk-title-cell__text">
          <Link className="mk-link" to="/issues/$id" params={{ id: String(i.id) }}>
            {i.mediaTitle}
          </Link>
          <span className="mk-title-cell__sub al-num">{[i.mediaYear, problemLabel(i)].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
    ),
  },
  { key: 'type', get header() { return t('common.type'); }, cell: (i) => ISSUE_TYPE_LABELS[i.type] },
  { key: 'status', get header() { return t('common.status'); }, cell: (i) => <IssueStatusChip status={i.status} /> },
  { key: 'by', get header() { return t('issues.reportedBy'); }, cell: (i) => userName(i.createdBy) },
  { key: 'comments', get header() { return t('issues.comments'); }, mono: true, align: 'right', cell: (i) => i.comments.length },
  { key: 'updated', get header() { return t('issues.updated'); }, mono: true, muted: true, cell: (i) => formatDateTime(i.updatedAt) },
];

export function IssuesPage() {
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [type, setType] = useState<IssueType | 'all'>('all');
  const [page, setPage] = useState(0);
  const navigate = useNavigate();
  const list = useIssues({ filter, take: PAGE_SIZE, skip: page * PAGE_SIZE, sort: 'modified' });
  // The api filters by status; the type filter applies to the page client-side (no type param in IssueListQuery).
  const rows = (list.data?.results ?? []).filter((i) => type === 'all' || i.type === type);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.pageInfo.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader index="03" title={t('common.issues')} subtitle={list.data ? <><span className="al-num">{list.data.pageInfo.total}</span> {filter === 'all' ? t('issues.issues') : filter}</> : undefined} />
      <FilterBar onClear={() => { setType('all'); setFilter('open'); setPage(0); }} activeCount={(type !== 'all' ? 1 : 0) + (filter !== 'open' ? 1 : 0)}>
        <Segmented
          aria-label={t('issues.statusFilter')}
          variant="soft"
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setPage(0);
          }}
          options={[
            { value: 'open', label: t('common.open') },
            { value: 'resolved', label: t('issues.resolved') },
            { value: 'all', label: t('common.all') },
          ]}
        />
        <Select
          aria-label={t('issues.issueTypeFilter')}
          value={type}
          onChange={(e) => setType(e.currentTarget.value as IssueType | 'all')}
          options={[{ value: 'all', label: t('issues.allTypes') }, ...IssueType.options.map((item) => ({ value: item, label: ISSUE_TYPE_LABELS[item] }))]}
        />
      </FilterBar>
      <div style={{ marginTop: 20 }}>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <QueryError error={list.error} title={t('issues.couldNotLoadIssues')} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('issues.noIssues')}>{t('issues.reportAProblemFromA')}</EmptyState>
        ) : (
          <Pane flush bare>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(i) => i.id}
              density="rich"
              sortable={false}
              caption={t('common.issues')}
              onRowClick={(i) => void navigate({ to: '/issues/$id', params: { id: String(i.id) } })}
            />
          </Pane>
        )}
        {pages > 1 ? (
          <div className="mk-row mk-row--end" style={{ marginTop: 16 }}>
            <Paginator page={page + 1} pageCount={pages} onPageChange={(p) => setPage(p - 1)} />
          </div>
        ) : null}
      </div>
    </>
  );
}

const detailRoute = getRouteApi('/issues/$id');

export function IssueDetailPage() {
  const { id } = detailRoute.useParams();
  const issue = useIssue(Number(id));
  if (issue.isPending) return <Loading />;
  if (issue.isError) return <QueryError error={issue.error} title={t('issues.couldNotLoadThisIssue')} onRetry={() => void issue.refetch()} />;
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
  const problem = problemLabel(issue);

  return (
    <>
      <div className="mk-crumb" style={{ marginBottom: 10 }}>
        <Link to="/issues">{t('common.issues')}</Link> / #{issue.id}
      </div>
      <PageHeader
        title={`${ISSUE_TYPE_LABELS[issue.type]} issue: ${issue.mediaTitle}`}
        subtitle={
          <span className="mk-row">
            <IssueStatusChip status={issue.status} />
            <span>
              {t('issues.reportedByUsername', { userName: userName(issue.createdBy) })} <span className="al-num">{formatDateTime(issue.createdAt)}</span>
            </span>
            {problem ? <span className="al-num">{problem}</span> : null}
          </span>
        }
        actions={
          <>
            <Link className="al-btn al-btn--secondary" {...titleLink(issue.mediaType, issue.mediaTmdbId)}>
              {t('issues.viewTitle')}
            </Link>
            {canComment ? (
              <Button loading={setStatus.isPending} onClick={() => setStatus.mutate({ id: issue.id, status: issue.status === 'open' ? 'resolved' : 'open' })}>
                {issue.status === 'open' ? t('issues.resolve') : t('issues.reopen')}
              </Button>
            ) : null}
            {canDelete ? (
              <Button variant="danger" onClick={() => setDeleting(true)}>
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        }
      />
      <section aria-label={t('issues.commentThread')} className="mk-stack-sm" style={{ maxWidth: 860 }}>
        <ol className="mk-thread" aria-label={t('issues.comments')}>
          {issue.comments.map((c) => (
            <CommentItem key={c.id} c={c} mine={userId !== null && c.user.id === userId} manage={manage} />
          ))}
        </ol>
        {canComment ? (
          <Pane>
            <form
              className="mk-stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                if (!message.trim()) return;
                comment.mutate({ id: issue.id, message: message.trim() }, { onSuccess: () => setMessage('') });
              }}
            >
              <Textarea rows={3} aria-label={t('issues.newComment')} placeholder={t('issues.addAComment')} value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
              <div className="mk-row mk-row--end">
                <Button type="submit" variant="primary" loading={comment.isPending} disabled={!message.trim()}>
                  {t('issues.comment')}
                </Button>
              </div>
            </form>
          </Pane>
        ) : null}
      </section>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t('issues.deleteTheValueIssueFor', { value: ISSUE_TYPE_LABELS[issue.type].toLowerCase(), mediaTitle: issue.mediaTitle })}
        size={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={async () => {
                await del.mutateAsync(issue.id);
                setDeleting(false);
                await navigate({ to: '/issues' });
              }}
            >
              {t('issues.deleteIssue')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          {t('issues.theIssueAndIts')} <span className="al-num">{issue.comments.length}</span> {t('issues.commentsAreDeleted')}
        </p>
      </Modal>
    </>
  );
}

function CommentItem({ c, mine, manage }: { c: IssueComment; mine: boolean; manage: boolean }) {
  const edit = useEditIssueComment();
  const remove = useDeleteIssueComment();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.message);
  const name = userName(c.user);
  return (
    <li className="mk-comment" aria-label={t('issues.commentByName', { name })}>
      <span className="mk-avatar" aria-hidden="true">
        {initials(name)}
      </span>
      <Pane>
        <div className="mk-comment__head">
          <span className="mk-comment__name">{name}</span>
          <span className="al-num al-caption">
            {formatDateTime(c.createdAt)}
            {c.updatedAt !== c.createdAt ? t('issues.edited') : ''}
          </span>
          {!editing && (mine || manage) ? (
            <span className="mk-row" style={{ marginLeft: 'auto', gap: 4 }}>
              {mine ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(c.id)}>
                {t('common.delete')}
              </Button>
            </span>
          ) : null}
        </div>
        {editing ? (
          <div className="mk-stack-sm">
            <Textarea rows={3} aria-label={t('issues.editComment')} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
            <div className="mk-row mk-row--end">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={edit.isPending}
                disabled={!draft.trim()}
                onClick={() => edit.mutate({ commentId: c.id, message: draft.trim() }, { onSuccess: () => setEditing(false) })}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mk-comment__body">{c.message}</p>
        )}
      </Pane>
    </li>
  );
}
