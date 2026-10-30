import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Permission, type MediaRequest, type RequestFilter, type RequestListQuery } from '@arclight/shared';
import { kindOf } from '../../api/requests.js';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  Field,
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
import { useSelection } from '../../components/bulk-actions.js';
import { BulkBar } from '../../components/media/bulk-bar.js';
import { ListSearchEmpty, ListSearchInput, useListSearch } from '../../components/list-search.js';
import { useRequestBulkActions, type RequestBulkVerb } from './request-bulk.js';
import { titleLink } from '../../features/requests/title-link.js';
import { HeldChip } from '../../features/requests/policy-drawer.js';
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
import { useFeatures } from '../../hooks/music.js';
import { StatusLabelChip } from '../discover/discover-kit.js';
import { ApproveDialog } from './approve-dialog.js';
import { AudioRequestTable, RequestSearchCount } from './audio-request-list.js';
import { LanguageRequestTable } from './language-request-list.js';
import '../../components/media/media-kit.css';
import { t } from '../../i18n/index.js';

export const REQUEST_TABS: ReadonlyArray<{ id: RequestFilter; label: string }> = [
  { id: 'pending', get label() { return t('common.pending'); } },
  { id: 'approved', get label() { return t('common.approved'); } },
  { id: 'declined', get label() { return t('common.declined'); } },
  { id: 'available', get label() { return t('common.available'); } },
  { id: 'all', get label() { return t('common.all'); } },
];

const PAGE_SIZE = 20;

type VideoFilter = 'all' | 'movie' | 'series';
type MediaFilter = VideoFilter | 'music' | 'audiobook' | 'language';

/** The media filter: movies and series, music and audiobooks while their flag is on, then subtitle and language requests. */
export function requestMediaOptions(features: { music: boolean; audiobooks: boolean }): Array<{ value: MediaFilter; label: string }> {
  return [
    { value: 'all', label: t('requests.moviesAndSeries') },
    { value: 'movie', label: t('common.movies') },
    { value: 'series', label: t('common.series') },
    ...(features.music ? [{ value: 'music' as const, label: t('common.music') }] : []),
    ...(features.audiobooks ? [{ value: 'audiobook' as const, label: t('common.audiobooks') }] : []),
    { value: 'language', label: t('requests.language.filter') },
  ];
}

export function RequestsPage() {
  const { can } = usePermissions();
  const manage = can(Permission.MANAGE_REQUESTS);
  const features = useFeatures();
  const [tab, setTab] = useState<RequestFilter>(manage ? 'pending' : 'all');
  const [picked, setPicked] = useState<MediaFilter>('all');
  const mediaOptions = requestMediaOptions(features);
  // A flag turned off while its list was open falls back to movies and series.
  const mediaType = mediaOptions.some((o) => o.value === picked) ? picked : 'all';
  // Text search (`?q=`): title, requester, status, matched by the server. The lists are keyed by
  // it, so a new query starts over at the first page with nothing selected.
  const search = useListSearch();
  const listKey = `${tab}-${mediaType}-${search.q}`;

  return (
    <>
      <PageHeader
        index="03"
        title={t('common.requests')}
        subtitle={can(Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW) ? t('requests.everyonesRequests') : t('requests.yourRequests')}
        actions={
          <>
            <ListSearchInput value={search.q} onChange={search.setQ} placeholder={t('listSearch.ph.requests')} />
            <Select
              aria-label={t('requests.mediaTypeFilter')}
              value={mediaType}
              onChange={(e) => setPicked(e.currentTarget.value as MediaFilter)}
              options={mediaOptions}
            />
            <Link className="al-btn al-btn--secondary" to="/requests/mine">
              {t('common.myRequests')}
            </Link>
          </>
        }
      >
        <Tabs compact aria-label={t('requests.requestStatus')} value={tab} onChange={(id) => setTab(id as RequestFilter)} tabs={REQUEST_TABS.map((item) => ({ id: item.id, label: item.label }))} />
      </PageHeader>
      {mediaType === 'language' ? (
        <LanguageRequestTable key={listKey} filter={tab} manage={manage} q={search.q} onClearSearch={search.clear} />
      ) : mediaType === 'music' || mediaType === 'audiobook' ? (
        <AudioRequestTable key={listKey} filter={tab} domain={mediaType} manage={manage} q={search.q} onClearSearch={search.clear} />
      ) : (
        <RequestList key={listKey} filter={tab} mediaType={mediaType} manage={manage} q={search.q} onClearSearch={search.clear} />
      )}
    </>
  );
}

interface RequestListProps {
  filter: RequestFilter;
  mediaType: VideoFilter;
  manage: boolean;
  /** The page's text search (blank = every request). */
  q?: string | undefined;
  onClearSearch?: (() => void) | undefined;
}

function RequestList({ filter, mediaType, manage, q = '', onClearSearch }: RequestListProps) {
  const [page, setPage] = useState(0);
  const query: RequestListQuery = { filter, mediaType, take: PAGE_SIZE, skip: page * PAGE_SIZE, sort: 'added', sortDirection: 'desc', q: q || undefined };
  const list = useRequests(query);
  const bulk = {
    approve: useBulkRequestAction('approve'),
    decline: useBulkRequestAction('decline'),
    retry: useBulkRequestAction('retry'),
    delete: useBulkRequestAction('delete'),
  };
  const mobile = useIsMobile();
  const results = list.data?.results ?? [];
  const keys = results.map((r) => r.id);
  const selection = useSelection(keys);
  const busy = (Object.keys(bulk) as RequestBulkVerb[]).find((v) => bulk[v].isPending) ?? null;
  const bulkBar = useRequestBulkActions({
    ids: selection.selected,
    manage,
    busy,
    run: (verb, ids) => bulk[verb].mutateAsync(ids),
    nameOf: (id) => results.find((r) => r.id === id)?.mediaTitle,
    onDone: selection.drop,
  });

  if (list.isPending) return <Loading />;
  if (list.isError) return <QueryError error={list.error} title={t('requests.couldNotLoadRequests')} onRetry={() => void list.refetch()} />;
  const { pageInfo } = list.data;
  const pages = Math.max(1, Math.ceil(pageInfo.total / PAGE_SIZE));

  const columns: Column<MediaRequest>[] = [
    { key: 'title', header: t('common.title'), cell: (r) => <RequestTitle r={r} /> },
    { key: 'by', header: t('common.requestedBy'), cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
    { key: 'seasons', header: t('common.seasons'), mono: true, cell: (r) => seasonsLabel(r.seasons) || '—' },
    { key: 'status', header: t('common.status'), cell: (r) => <RequestStatusCell r={r} /> },
    { key: 'created', header: t('common.requested'), mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
    {
      key: 'modified',
      header: t('requests.modified'),
      mono: true,
      muted: true,
      cell: (r) => (
        <>
          {formatDateTime(r.updatedAt)}
          {r.modifiedBy ? <div className="mk-title-cell__sub">{t('requests.byValue', { value: r.modifiedBy.displayName ?? r.modifiedBy.username })}</div> : null}
        </>
      ),
    },
    { key: 'actions', header: <span className="al-sr-only">{t('common.actions')}</span>, align: 'right', cell: (r) => <RequestActions r={r} manage={manage} /> },
  ];

  return (
    <>
      <RequestSearchCount q={q} total={pageInfo.total} />
      {results.length === 0 ? (
        q ? (
          <ListSearchEmpty query={q} onClear={() => onClearSearch?.()} />
        ) : (
          <EmptyState title={t('requests.noRequests')}>{t('requests.requestsMadeFromDiscoverShow')}</EmptyState>
        )
      ) : mobile ? (
        <div className="mk-mlist">
          {results.map((r) => (
            <MobileRequestRow key={r.id} r={r} manage={manage} select={selection.cardProps(r.id, r.mediaTitle)} />
          ))}
        </div>
      ) : (
        <Pane flush bare>
          <Table
            columns={columns}
            rows={results}
            rowKey={(r) => r.id}
            density="rich"
            sortable={false}
            caption={t('common.requests')}
            selectable
            selected={selection.selected}
            onSelectionChange={selection.set}
            rowLabel={(r) => t('requests.selectMediatitle', { mediaTitle: r.mediaTitle })}
          />
        </Pane>
      )}
      <BulkBar count={selection.count} total={keys.length} onSelectAll={() => selection.set(keys)} actions={bulkBar.actions} onClear={selection.clear}>
        {bulkBar.dialogs}
      </BulkBar>
      {pages > 1 ? (
        <div className="mk-row mk-row--end" style={{ marginTop: 16 }}>
          <Paginator page={page + 1} pageCount={pages} onPageChange={(p) => setPage(p - 1)} />
        </div>
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
          {[r.type === 'movie' ? t('common.movie') : t('common.series'), r.is4k ? '4K' : null].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}

/** "Available on Jellyfin": the media server that reported the title (requests availability). */
export function AvailableOnChip({ r }: { r: Pick<MediaRequest, 'availableOn'> }) {
  if (!r.availableOn) return null;
  return <Chip tone="accent">{t('requests.availableOnAvailableon', { availableOn: r.availableOn })}</Chip>;
}

export function RequestStatusCell({ r }: { r: MediaRequest }) {
  return (
    <div className="mk-stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
      <div className="mk-row" style={{ gap: 6 }}>
        <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
        {r.status === 'approved' || r.status === 'completed' ? <StatusLabelChip label={MEDIA_STATUS_META[r.mediaStatus].label} /> : null}
        <HeldChip request={r} />
        <AvailableOnChip r={r} />
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
            {t('common.approve')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => d.setDeclining(true)}>
            {t('requests.decline')}
          </Button>
        </>
      ) : null}
      {r.status === 'pending' && (manage || r.canRemove) ? (
        <Button size="sm" variant="ghost" onClick={() => d.setEditing(true)}>
          {t('common.edit')}
        </Button>
      ) : null}
      {manage && r.status === 'failed' ? (
        <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(r.id)}>
          {t('requests.retry')}
        </Button>
      ) : null}
      {r.canRemove ? (
        <Button size="sm" variant="ghost" onClick={() => d.setDeleting(true)}>
          {t('common.delete')}
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
function MobileRequestRow({ r, manage, select }: { r: MediaRequest; manage: boolean; select?: { checked: boolean; onChange: () => void; label: string } }) {
  const d = useRowDialogs();
  return (
    <SwipeRow onDelete={r.canRemove ? () => d.setDeleting(true) : undefined} deleteLabel={t('common.delete')}>
      <div className={select ? 'mk-mrow mk-mrow--check' : 'mk-mrow'}>
        {select ? <Checkbox aria-label={select.label} checked={select.checked} onChange={select.onChange} /> : null}
        <div style={{ minWidth: 0 }}>
          <RequestTitle r={r} />
          <div className="mk-row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
            <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} />
            <HeldChip request={r} />
            <AvailableOnChip r={r} />
          </div>
        </div>
        {manage && r.status === 'pending' ? (
          <div className="mk-stack-sm" style={{ gap: 6 }}>
            <Button size="sm" onClick={() => d.setApproving(true)}>
              {t('common.approve')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => d.setDeclining(true)}>
              {t('requests.decline')}
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
      title={t('requests.deleteTheRequestForMediatitle', { mediaTitle: request.mediaTitle })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(request.id, { onSuccess: onClose })}>
            {t('requests.deleteRequest')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t('requests.theTitleStaysInThe')}</p>
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
      title={t('requests.declineMediatitle', { mediaTitle: request.mediaTitle })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={decline.isPending}
            onClick={() => decline.mutate({ id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) }, { onSuccess: onClose })}
          >
            {t('requests.declineRequest')}
          </Button>
        </>
      }
    >
      <Field label={t('requests.reasonOptional')} hint={t('requests.shownToTheRequester')}>
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
      setError(t('requests.keepAtLeastOneSeason'));
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
      title={t('requests.editRequestMediatitle', { mediaTitle: request.mediaTitle })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        {isSeries ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="al-label" style={{ marginBottom: 10 }}>
              {t('common.seasons')}
            </legend>
            <div className="mk-check-grid">
              {seasonChoices.map((n) => (
                <Checkbox
                  key={n}
                  label={n === 0 ? t('common.specials') : t('requests.seasonN', { n })}
                  checked={seasons.includes(n)}
                  onChange={(e) => setSeasons((prev) => (e.currentTarget.checked ? [...prev, n] : prev.filter((x) => x !== n)))}
                />
              ))}
            </div>
          </fieldset>
        ) : null}
        <FormRow label={t('common.rootFolder')} htmlFor="edit-request-root">
          <Select id="edit-request-root" value={rootFolderPath} onChange={(e) => setRootFolderPath(e.currentTarget.value)}>
            <option value="">{t('common.defaultFolder')}</option>
            {(rootFolders.data ?? [])
              .filter((f) => f.mediaType === request.type)
              .map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.qualityTarget')} htmlFor="edit-request-profile">
          <Select id="edit-request-profile" value={profileId} onChange={(e) => setProfileId(e.currentTarget.value)}>
            <option value="">{t('common.defaultProfile')}</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.tags')}>
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
