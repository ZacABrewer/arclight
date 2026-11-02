import { useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MusicPlaylist, MusicPlaylistEntry, MusicPlaylistsSettingsResponse, MusicPlaylistsSettingsUpdate, PlaylistWant } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Checkbox, Chip, EmptyState, ErrorBlock, FormRow, Input, Meter, Modal, PageHeader, Select, Skeleton, Table, Toggle, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { formatDate } from '../../../components/media/format.js';
import { Loading, QueryError } from '../../../components/media/media-kit.js';
import { useRootFolders } from '../../../hooks/library.js';
import { useMediaServers } from '../../../hooks/media-servers.js';
import { useMusicQualityProfiles } from '../../../hooks/music.js';
import {
  useDeleteMusicPlaylist,
  useMusicPlaylistEntries,
  useMusicPlaylists,
  useMusicPlaylistsSettings,
  usePreviewMusicPlaylist,
  useSaveMusicPlaylist,
  useSaveMusicPlaylistsSettings,
  useSyncMusicPlaylist,
} from '../../../hooks/music-playlists.js';
import { MusicCrumb, MusicGate } from './music-kit.js';
import {
  ENTRY_TONE,
  LASTFM_PERIODS,
  SOURCE_KINDS,
  SYNC_TONE,
  availability,
  entryStatusLabel,
  sourceDraft,
  sourceFromDraft,
  sourceKindLabel,
  sourceSummary,
  syncStatusLabel,
  targetLabel,
  type SourceDraft,
} from './playlists-model.js';
import { formatDuration } from './music-model.js';
import '../library.css';
import './music.css';
import { t } from '../../../i18n/index.js';

// Library → Music → Playlists (docs/using/music-playlists.md): playlists followed from Spotify,
// Deezer, ListenBrainz or Last.fm, matched to the library, optionally wanted, written as .m3u8
// and pushed to media servers. Admin-only (the api answers 403 otherwise).

export function MusicPlaylistsPage() {
  return (
    <MusicGate>
      <Playlists />
    </MusicGate>
  );
}

function Playlists() {
  const playlists = useMusicPlaylists();
  const servers = useMediaServers();
  const sync = useSyncMusicPlaylist();
  const del = useDeleteMusicPlaylist();
  const [editing, setEditing] = useState<MusicPlaylist | 'new' | null>(null);
  const [viewing, setViewing] = useState<MusicPlaylist | null>(null);
  const [deleting, setDeleting] = useState<MusicPlaylist | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const serverList = servers.data ?? [];

  const columns: Column<MusicPlaylist>[] = [
    {
      key: 'name',
      header: t('common.name'),
      sortValue: (p) => p.name.toLowerCase(),
      cell: (p) => (
        <span className="music-playlist__name">
          <button type="button" className="al-link music-playlist__open" onClick={() => setViewing(p)}>
            {p.name}
          </button>
          <span className="al-caption music-playlist__source">
            {sourceKindLabel(p.source.kind)} · {p.sourceTitle ?? sourceSummary(p.source)}
          </span>
        </span>
      ),
    },
    {
      key: 'want',
      header: t('musicPlaylists.want'),
      cell: (p) => t(`musicPlaylists.wantOption.${p.want}`),
      muted: true,
    },
    {
      key: 'available',
      header: t('musicPlaylists.available'),
      sortValue: (p) => availability(p).percent,
      cell: (p) => {
        const a = availability(p);
        return <Meter value={a.percent} label={t('musicPlaylists.availableOf', { name: p.name })} valueText={`${a.have}/${a.total}`} />;
      },
    },
    {
      key: 'targets',
      header: t('musicPlaylists.outputs'),
      muted: true,
      cell: (p) => [...(p.writeM3u ? ['.m3u8'] : []), ...p.targets.map((x) => targetLabel(x, serverList))].join(', ') || '—',
    },
    {
      key: 'status',
      header: t('musicPlaylists.lastSync'),
      sortValue: (p) => p.lastSyncAt ?? '',
      cell: (p) => (
        <span className="music-playlist__sync" title={p.lastSyncMessage ?? undefined}>
          <Chip tone={SYNC_TONE[p.lastSyncStatus]}>{syncStatusLabel(p.lastSyncStatus)}</Chip>
          {p.lastSyncAt ? <span className="al-caption">{formatDate(p.lastSyncAt, { dateStyle: 'medium', timeStyle: 'short' })}</span> : null}
          {!p.enabled ? <Chip tone="muted">{t('musicPlaylists.paused')}</Chip> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      mobile: 'end',
      cell: (p) => (
        <span className="music-playlist__actions">
          <Button size="sm" loading={sync.isPending && sync.variables === p.id} disabled={p.lastSyncStatus === 'running'} onClick={() => sync.mutate(p.id)}>
            {t('musicPlaylists.syncNow')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(p)} aria-label={t('musicPlaylists.deleteNamed', { name: p.name })}>
            {t('common.delete')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="lib-page music-playlists">
      <PageHeader
        index="01"
        title={t('musicPlaylists.title')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
              {t('musicPlaylists.sourcesAndOutputs')}
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('musicPlaylists.newPlaylist')}
            </Button>
          </>
        }
      >
        <span className="mk-count">
          <MusicCrumb />
        </span>
      </PageHeader>
      <p className="al-caption music-playlists__intro">{t('musicPlaylists.intro')}</p>
      {playlists.isPending ? (
        <Loading />
      ) : playlists.isError ? (
        <QueryError error={playlists.error} onRetry={() => void playlists.refetch()} />
      ) : (
        <Table
          columns={columns}
          rows={playlists.data}
          rowKey={(p) => p.id}
          density="rich"
          defaultSort={{ key: 'name', direction: 'asc' }}
          empty={
            <EmptyState title={t('musicPlaylists.emptyTitle')} action={<Button variant="primary" onClick={() => setEditing('new')}>{t('musicPlaylists.newPlaylist')}</Button>}>
              {t('musicPlaylists.emptyBody')}
            </EmptyState>
          }
        />
      )}
      {editing ? <PlaylistDialog playlist={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {viewing ? <EntriesDialog playlist={viewing} onClose={() => setViewing(null)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('musicPlaylists.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => del.mutateAsync(deleting!.id).then(() => setDeleting(null))}
      >
        {t('musicPlaylists.deleteBody')}
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------ create / edit

interface Draft {
  name: string;
  source: SourceDraft;
  want: PlaylistWant;
  addArtists: boolean;
  rootFolderPath: string;
  qualityProfileId: string;
  searchOnWant: boolean;
  writeM3u: boolean;
  targets: string[];
  syncIntervalHours: number;
  enabled: boolean;
}

function toDraft(p: MusicPlaylist | null): Draft {
  return {
    name: p?.name ?? '',
    source: sourceDraft(p?.source),
    want: p?.want ?? 'none',
    addArtists: p?.addArtists ?? false,
    rootFolderPath: p?.rootFolderPath ?? '',
    qualityProfileId: p?.qualityProfileId ? String(p.qualityProfileId) : '',
    searchOnWant: p?.searchOnWant ?? false,
    writeM3u: p?.writeM3u ?? true,
    targets: p?.targets ?? [],
    syncIntervalHours: p?.syncIntervalHours ?? 24,
    enabled: p?.enabled ?? true,
  };
}

export function PlaylistDialog({ playlist, onClose }: { playlist: MusicPlaylist | null; onClose: () => void }) {
  const id = useId();
  const save = useSaveMusicPlaylist();
  const preview = usePreviewMusicPlaylist();
  const roots = useRootFolders();
  const profiles = useMusicQualityProfiles();
  const servers = useMediaServers();
  const [d, setDraft] = useState<Draft>(() => toDraft(playlist));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setSource = <K extends keyof SourceDraft>(key: K, value: SourceDraft[K]) => setDraft((prev) => ({ ...prev, source: { ...prev.source, [key]: value } }));
  const source = sourceFromDraft(d.source);
  const musicRoots = (roots.data ?? []).filter((r) => (r as { mediaType?: string }).mediaType === 'music');
  const pushable = (servers.data ?? []).filter((s) => s.kind === 'jellyfin' || s.kind === 'emby' || s.kind === 'plex');
  const targetOptions = [...pushable.map((s) => ({ value: `server:${s.id}`, label: s.name })), { value: 'navidrome', label: 'Navidrome' }];
  const toggleTarget = (value: string, on: boolean) => set('targets', on ? [...new Set([...d.targets, value])] : d.targets.filter((x) => x !== value));
  const valid = d.name.trim() !== '' && source !== null;

  const submit = () => {
    if (!source) return;
    const body = {
      name: d.name.trim(),
      source,
      want: d.want,
      addArtists: d.addArtists,
      rootFolderPath: d.rootFolderPath || null,
      qualityProfileId: d.qualityProfileId ? Number(d.qualityProfileId) : null,
      searchOnWant: d.searchOnWant,
      writeM3u: d.writeM3u,
      targets: d.targets,
      syncIntervalHours: d.syncIntervalHours,
      enabled: d.enabled,
    };
    save.mutate({ id: playlist?.id, body }, { onSuccess: onClose });
  };

  const needsUrl = d.source.kind === 'spotify' || d.source.kind === 'deezer' || d.source.kind === 'listenbrainz';

  return (
    <Modal
      open
      onClose={onClose}
      size={640}
      title={playlist ? t('musicPlaylists.editTitle', { name: playlist.name }) : t('musicPlaylists.newPlaylist')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormRow label={t('common.name')} htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} value={d.name} onChange={(e) => set('name', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('musicPlaylists.sourceLabel')} htmlFor={`${id}-kind`}>
        <Select
          id={`${id}-kind`}
          value={d.source.kind}
          options={SOURCE_KINDS.map((k) => ({ value: k, label: sourceKindLabel(k) }))}
          onChange={(e) => setSource('kind', e.currentTarget.value as SourceDraft['kind'])}
        />
      </FormRow>
      {needsUrl ? (
        <FormRow label={t('musicPlaylists.link')} htmlFor={`${id}-url`} caption={t(`musicPlaylists.linkCaption.${d.source.kind}`)}>
          <Input id={`${id}-url`} mono value={d.source.url} onChange={(e) => setSource('url', e.currentTarget.value)} />
        </FormRow>
      ) : (
        <FormRow label={t('musicPlaylists.user')} htmlFor={`${id}-user`}>
          <Input id={`${id}-user`} mono autoComplete="off" value={d.source.user} onChange={(e) => setSource('user', e.currentTarget.value)} />
        </FormRow>
      )}
      {d.source.kind === 'listenbrainzCreatedFor' ? (
        <FormRow label={t('musicPlaylists.patch')} htmlFor={`${id}-patch`} caption={t('musicPlaylists.patchCaption')}>
          <Input id={`${id}-patch`} mono placeholder="weekly-jams" value={d.source.patch} onChange={(e) => setSource('patch', e.currentTarget.value)} />
        </FormRow>
      ) : null}
      {d.source.kind === 'lastfm' ? (
        <>
          <FormRow label={t('musicPlaylists.chart')} htmlFor={`${id}-chart`}>
            <Select
              id={`${id}-chart`}
              value={d.source.chart}
              options={[
                { value: 'top', label: t('musicPlaylists.chartTop') },
                { value: 'loved', label: t('musicPlaylists.chartLoved') },
              ]}
              onChange={(e) => setSource('chart', e.currentTarget.value as SourceDraft['chart'])}
            />
          </FormRow>
          {d.source.chart === 'top' ? (
            <FormRow label={t('musicPlaylists.period')} htmlFor={`${id}-period`}>
              <Select
                id={`${id}-period`}
                value={d.source.period}
                options={LASTFM_PERIODS.map((p) => ({ value: p, label: t(`musicPlaylists.periodOption.${p}`) }))}
                onChange={(e) => setSource('period', e.currentTarget.value as SourceDraft['period'])}
              />
            </FormRow>
          ) : null}
          <FormRow label={t('musicPlaylists.limit')} htmlFor={`${id}-limit`}>
            <Input id={`${id}-limit`} mono type="number" min={1} max={200} value={String(d.source.limit)} onChange={(e) => setSource('limit', Number(e.currentTarget.value) || 50)} />
          </FormRow>
        </>
      ) : null}
      <div className="music-playlist__preview">
        <Button size="sm" disabled={!source} loading={preview.isPending} onClick={() => source && preview.mutate(source)}>
          {t('musicPlaylists.preview')}
        </Button>
        {preview.isError ? <Banner tone="danger">{errorMessage(preview.error)}</Banner> : null}
        {preview.data ? (
          <div className="music-playlist__preview-body" data-testid="playlist-preview">
            <strong>{preview.data.title}</strong>
            <span className="al-caption">
              {t('musicPlaylists.trackCount', { count: preview.data.trackCount })}
              {preview.data.owner ? ` · ${preview.data.owner}` : ''}
            </span>
            <ol className="music-playlist__preview-list">
              {preview.data.tracks.slice(0, 8).map((tr, i) => (
                <li key={i}>
                  {tr.artist} – {tr.title}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      <FormRow label={t('musicPlaylists.want')} htmlFor={`${id}-want`} caption={t(`musicPlaylists.wantCaption.${d.want}`)}>
        <Select
          id={`${id}-want`}
          value={d.want}
          options={(['none', 'tracks', 'albums'] as const).map((w) => ({ value: w, label: t(`musicPlaylists.wantOption.${w}`) }))}
          onChange={(e) => set('want', e.currentTarget.value as PlaylistWant)}
        />
      </FormRow>
      <FormRow label={t('musicPlaylists.addArtists')} caption={t('musicPlaylists.addArtistsCaption')} captionInline>
        <Toggle aria-label={t('musicPlaylists.addArtists')} checked={d.addArtists} onChange={(e) => set('addArtists', e.currentTarget.checked)} />
      </FormRow>
      {d.addArtists ? (
        <>
          <FormRow label={t('common.rootFolder')} htmlFor={`${id}-root`}>
            <Select
              id={`${id}-root`}
              value={d.rootFolderPath}
              options={[{ value: '', label: t('musicPlaylists.firstRoot') }, ...musicRoots.map((r) => ({ value: r.path, label: r.path }))]}
              onChange={(e) => set('rootFolderPath', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('common.qualityProfile')} htmlFor={`${id}-profile`}>
            <Select
              id={`${id}-profile`}
              value={d.qualityProfileId}
              options={[{ value: '', label: t('musicPlaylists.firstProfile') }, ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))]}
              onChange={(e) => set('qualityProfileId', e.currentTarget.value)}
            />
          </FormRow>
        </>
      ) : null}
      {d.want !== 'none' ? (
        <FormRow label={t('musicPlaylists.searchOnWant')} captionInline>
          <Toggle aria-label={t('musicPlaylists.searchOnWant')} checked={d.searchOnWant} onChange={(e) => set('searchOnWant', e.currentTarget.checked)} />
        </FormRow>
      ) : null}
      <FormRow label={t('musicPlaylists.writeM3u')} caption={t('musicPlaylists.writeM3uCaption')} captionInline>
        <Toggle aria-label={t('musicPlaylists.writeM3u')} checked={d.writeM3u} onChange={(e) => set('writeM3u', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('musicPlaylists.pushTo')} caption={t('musicPlaylists.pushToCaption')}>
        <div className="music-playlist__targets">
          {targetOptions.map((o) => (
            <Checkbox key={o.value} label={o.label} checked={d.targets.includes(o.value)} onChange={(e) => toggleTarget(o.value, e.currentTarget.checked)} />
          ))}
        </div>
      </FormRow>
      <FormRow label={t('musicPlaylists.interval')} htmlFor={`${id}-interval`} caption={t('musicPlaylists.intervalCaption')}>
        <Input
          id={`${id}-interval`}
          mono
          type="number"
          min={0}
          max={720}
          end="h"
          value={String(d.syncIntervalHours)}
          onChange={(e) => set('syncIntervalHours', Math.max(0, Math.round(Number(e.currentTarget.value) || 0)))}
        />
      </FormRow>
      <FormRow label={t('musicPlaylists.enabled')} captionInline>
        <Toggle aria-label={t('musicPlaylists.enabled')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormRow>
      {save.isError ? <Banner tone="danger">{errorMessage(save.error)}</Banner> : null}
    </Modal>
  );
}

// ------------------------------------------------------------------ entries

export function EntriesDialog({ playlist, onClose }: { playlist: MusicPlaylist; onClose: () => void }) {
  const entries = useMusicPlaylistEntries(playlist.id);
  const columns: Column<MusicPlaylistEntry>[] = [
    { key: 'position', header: '#', cell: (e) => e.position, mono: true, muted: true, width: '48px', mobile: 'hide', sortValue: (e) => e.position },
    {
      key: 'title',
      header: t('musicPlaylists.track'),
      sortValue: (e) => e.title.toLowerCase(),
      cell: (e) => (
        <span className="music-playlist__name">
          <span>{e.title}</span>
          <span className="al-caption">
            {e.artistId !== null ? (
              <Link to="/library/music/artist/$id" params={{ id: String(e.artistId) }}>
                {e.artistName ?? e.artist}
              </Link>
            ) : (
              e.artist
            )}
            {e.albumId !== null ? (
              <>
                {' · '}
                <Link to="/library/music/album/$id" params={{ id: String(e.albumId) }}>
                  {e.albumTitle ?? e.album}
                </Link>
              </>
            ) : e.album ? (
              ` · ${e.album}`
            ) : null}
          </span>
        </span>
      ),
    },
    { key: 'length', header: t('musicPlaylists.length'), cell: (e) => (e.durationMs ? formatDuration(e.durationMs) : '—'), mono: true, muted: true, align: 'right' },
    {
      key: 'status',
      header: t('common.status'),
      sortValue: (e) => e.status,
      cell: (e) => <Chip tone={ENTRY_TONE[e.status]}>{entryStatusLabel(e.status)}</Chip>,
    },
  ];
  return (
    <Modal open onClose={onClose} size={1100} title={playlist.sourceTitle ?? playlist.name}>
      {playlist.lastSyncMessage ? <p className="al-caption">{playlist.lastSyncMessage}</p> : null}
      {entries.isPending ? (
        <Skeleton lines={6} />
      ) : entries.isError ? (
        <ErrorBlock title={t('musicPlaylists.couldNotLoadEntries')} onRetry={() => void entries.refetch()}>
          {errorMessage(entries.error)}
        </ErrorBlock>
      ) : (
        <Table
          columns={columns}
          rows={entries.data}
          rowKey={(e) => e.position}
          defaultSort={{ key: 'position', direction: 'asc' }}
          maxHeight="60vh"
          empty={<EmptyState title={t('musicPlaylists.noEntries')}>{t('musicPlaylists.noEntriesBody')}</EmptyState>}
        />
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ settings

/** Only the fields that differ from what is stored. */
export function playlistSettingsChanges(stored: MusicPlaylistsSettingsResponse, draft: MusicPlaylistsSettingsResponse): MusicPlaylistsSettingsUpdate {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as Array<keyof MusicPlaylistsSettingsResponse>) if (draft[key] !== stored[key]) out[key] = draft[key];
  return out as MusicPlaylistsSettingsUpdate;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useMusicPlaylistsSettings();
  return (
    <Modal open onClose={onClose} size={640} title={t('musicPlaylists.sourcesAndOutputs')}>
      {settings.isPending ? (
        <Skeleton lines={6} />
      ) : settings.isError ? (
        <ErrorBlock title={t('musicPlaylists.couldNotLoadSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <SettingsForm key={JSON.stringify(settings.data)} stored={settings.data} onDone={onClose} />
      )}
    </Modal>
  );
}

function SettingsForm({ stored, onDone }: { stored: MusicPlaylistsSettingsResponse; onDone: () => void }) {
  const id = useId();
  const save = useSaveMusicPlaylistsSettings();
  const [d, setDraft] = useState(stored);
  const set = <K extends keyof MusicPlaylistsSettingsResponse>(key: K, value: MusicPlaylistsSettingsResponse[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const changes = playlistSettingsChanges(stored, d);
  const dirty = Object.keys(changes).length > 0;
  const text = (key: 'spotifyClientId' | 'spotifyClientSecret' | 'lastfmApiKey' | 'm3uFolder' | 'navidromeUrl' | 'navidromeUser' | 'navidromePassword', secret = false) => (
    <Input id={`${id}-${key}`} mono type={secret ? 'password' : 'text'} autoComplete="off" value={d[key]} onChange={(e) => set(key, e.currentTarget.value)} />
  );
  return (
    <div className="music-playlist__settings">
      <h3 className="al-title-s">Spotify</h3>
      <p className="al-caption">{t('musicPlaylists.spotifyIntro')}</p>
      <FormRow label={t('musicPlaylists.clientId')} htmlFor={`${id}-spotifyClientId`}>
        {text('spotifyClientId')}
      </FormRow>
      <FormRow label={t('musicPlaylists.clientSecret')} htmlFor={`${id}-spotifyClientSecret`}>
        {text('spotifyClientSecret', true)}
      </FormRow>
      <h3 className="al-title-s">Last.fm</h3>
      <FormRow label={t('musicPlaylists.apiKey')} htmlFor={`${id}-lastfmApiKey`} caption={t('musicPlaylists.lastfmCaption')}>
        {text('lastfmApiKey', true)}
      </FormRow>
      <FormRow label={t('musicPlaylists.similarSource')} htmlFor={`${id}-similar`}>
        <Select
          id={`${id}-similar`}
          value={d.similarSource}
          options={(['both', 'listenbrainz', 'lastfm'] as const).map((v) => ({ value: v, label: t(`musicPlaylists.similarOption.${v}`) }))}
          onChange={(e) => set('similarSource', e.currentTarget.value as MusicPlaylistsSettingsResponse['similarSource'])}
        />
      </FormRow>
      <h3 className="al-title-s">{t('musicPlaylists.m3uHeading')}</h3>
      <FormRow label={t('musicPlaylists.m3uFolder')} htmlFor={`${id}-m3uFolder`} caption={t('musicPlaylists.m3uFolderCaption')}>
        {text('m3uFolder')}
      </FormRow>
      <FormRow label={t('musicPlaylists.m3uPaths')} htmlFor={`${id}-paths`}>
        <Select
          id={`${id}-paths`}
          value={d.m3uPaths}
          options={[
            { value: 'relative', label: t('musicPlaylists.m3uRelative') },
            { value: 'absolute', label: t('musicPlaylists.m3uAbsolute') },
          ]}
          onChange={(e) => set('m3uPaths', e.currentTarget.value as MusicPlaylistsSettingsResponse['m3uPaths'])}
        />
      </FormRow>
      <h3 className="al-title-s">Navidrome</h3>
      <p className="al-caption">{t('musicPlaylists.navidromeIntro')}</p>
      <FormRow label={t('common.url')} htmlFor={`${id}-navidromeUrl`}>
        {text('navidromeUrl')}
      </FormRow>
      <FormRow label={t('common.username')} htmlFor={`${id}-navidromeUser`}>
        {text('navidromeUser')}
      </FormRow>
      <FormRow label={t('common.password')} htmlFor={`${id}-navidromePassword`}>
        {text('navidromePassword', true)}
      </FormRow>
      <FormRow label={t('musicPlaylists.maxSearches')} htmlFor={`${id}-max`} caption={t('musicPlaylists.maxSearchesCaption')}>
        <Input
          id={`${id}-max`}
          mono
          type="number"
          min={0}
          max={1000}
          value={String(d.maxSearchesPerSync)}
          onChange={(e) => set('maxSearchesPerSync', Math.max(0, Math.min(1000, Math.round(Number(e.currentTarget.value) || 0))))}
        />
      </FormRow>
      {save.isError ? <Banner tone="danger">{errorMessage(save.error)}</Banner> : null}
      <div className="music-playlist__settings-actions">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(changes, { onSuccess: onDone })}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
