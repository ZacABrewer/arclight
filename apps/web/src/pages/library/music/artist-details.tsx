import { useMemo, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import type { Album, ArtistDetails, MonitorNewAlbums, MusicMonitorOption } from '@arclight/shared';
import { Banner, Button, EmptyState, FormRow, Input, KeyValue, Meter, Modal, QualityTag, Select, StatusChip, Toggle } from '../../../arclight/index.js';
import { DeleteMediaDialog } from '../../../components/media/delete-media-dialog.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QueryError, TagChips } from '../../../components/media/media-kit.js';
import { TagPicker } from '../../../components/media/tag-picker.js';
import { useRootFolders, useTags } from '../../../hooks/library.js';
import {
  isLoadingAlbums,
  useAlbumTypeProfiles,
  useArtist,
  useDeleteArtist,
  useMusicCommand,
  useMusicQualityProfiles,
  useSetAlbumsMonitored,
  useSetArtistMonitored,
  useUpdateArtist,
} from '../../../hooks/music.js';
import { DetailsHero } from '../details-kit.js';
import { MusicCrumb, MusicGate, NotYetButton, SquareArt } from './music-kit.js';
import {
  MONITOR_OPTIONS,
  NEW_ALBUM_OPTIONS,
  albumCover,
  albumTypeGroupLabel,
  albumYear,
  artistBackdrop,
  artistImage,
  artistStatusLabel,
  featuredArtistLinks,
  groupAlbums,
  monitorNewAlbumsLabel,
  monitorOptionLabel,
  progressText,
  trackProgress,
  type AlbumGroup,
} from './music-model.js';
import '../library.css';
import './music.css';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/music/artist/$id');

export function ArtistDetailsPage() {
  return (
    <MusicGate>
      <ArtistDetailsView />
    </MusicGate>
  );
}

function ArtistDetailsView() {
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const artist = useArtist(id);
  const profiles = useMusicQualityProfiles();
  const typeProfiles = useAlbumTypeProfiles();
  const tags = useTags();
  const setMonitored = useSetArtistMonitored();
  const command = useMusicCommand();
  const del = useDeleteArtist();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('music.invalidArtistId', { rawId }))} title={t('music.artistNotFound')} />;
  if (artist.isPending) return <Loading />;
  if (artist.isError) return <QueryError error={artist.error} onRetry={() => void artist.refetch()} title={t('music.couldNotLoadThisArtist')} />;
  const a = artist.data;
  const stats = a.statistics;
  const links = featuredArtistLinks(a.links, a.mbArtistId);
  const p = trackProgress(stats);
  const profile = profiles.data?.find((x) => x.id === a.qualityProfileId);
  const typeProfile = typeProfiles.data?.find((x) => x.id === a.albumTypeProfileId);
  const running = command.isPending ? command.variables.name : null;

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('music.artistOverview')}
        backdrop={artistBackdrop(a)}
        art={<SquareArt src={artistImage(a)} title={a.name} className="mk-hero__poster" loading="eager" />}
        title={a.name}
        crumb={<MusicCrumb />}
        meta={[a.artistType, a.disambiguation, a.genres.slice(0, 3).join(', ') || null, artistStatusLabel(a.status), t('music.albumCount', { count: stats?.albumCount ?? a.albums.length })]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch monitored={a.monitored} onChange={(m) => setMonitored.mutate({ id: a.id, monitored: m })} label={t('common.monitorTitle', { monitored: a.monitored, title: a.name })} />
            <StatusChip status={a.monitored ? 'monitored' : 'unmonitored'} large />
            {profile ? <QualityTag>{profile.name}</QualityTag> : null}
            {typeProfile ? <span className="al-chip al-chip--nodot al-chip--lg">{typeProfile.name}</span> : null}
            <TagChips ids={a.tags} tags={tags.data} />
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.path'), value: a.path },
              { label: t('common.sizeOnDisk'), value: formatBytes(stats?.sizeOnDisk) },
              { label: t('music.tracks'), value: `${p.have} / ${p.total}` },
              { label: t('music.completeAlbums'), value: `${stats?.completeAlbumCount ?? 0} / ${stats?.albumCount ?? 0}` },
            ]}
          />
        }
        overview={a.overview}
        actions={
          <>
            <NotYetButton variant="primary">{t('library.seriesDetails.searchMonitored')}</NotYetButton>
            <Button loading={running === 'RefreshArtist'} disabled={running === 'RescanArtist'} onClick={() => command.mutate({ name: 'RefreshArtist', artistId: a.id })}>
              {t('common.refresh')}
            </Button>
            <Button loading={running === 'RescanArtist'} disabled={running === 'RefreshArtist'} onClick={() => command.mutate({ name: 'RescanArtist', artistId: a.id })}>
              {t('music.rescanFolder')}
            </Button>
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {links.length > 0 ? (
          <ul className="music-links" aria-label={t('music.links')}>
            {links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </DetailsHero>

      <AlbumGroups artist={a} />

      {editing ? <EditArtistModal artist={a} onClose={() => setEditing(false)} /> : null}
      <DeleteMediaDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        subject={a.name}
        noun={t('music.artistNoun', { count: 1 })}
        path={a.path}
        loading={del.isPending}
        onConfirm={(opts) =>
          del.mutate(
            { id: a.id, ...opts },
            {
              onSuccess: () => {
                setDeleting(false);
                void navigate({ to: '/library/music' });
              },
            },
          )
        }
      />
    </div>
  );
}

function AlbumGroups({ artist }: { artist: ArtistDetails }) {
  const groups = useMemo(() => groupAlbums(artist.albums), [artist.albums]);
  if (isLoadingAlbums(artist)) {
    return (
      <Banner tone="info">
        <span data-testid="loading-albums">{t('music.loadingAlbums')}</span>
      </Banner>
    );
  }
  if (groups.length === 0) return <EmptyState title={t('music.noAlbums')}>{t('music.noAlbumsBody')}</EmptyState>;
  return (
    <div className="music-groups">
      {groups.map((g) => (
        <AlbumGroupSection key={g.type} artistId={artist.id} group={g} />
      ))}
    </div>
  );
}

function AlbumGroupSection({ artistId, group }: { artistId: number; group: AlbumGroup }) {
  const setAlbums = useSetAlbumsMonitored();
  const label = albumTypeGroupLabel(group.type);
  const allMonitored = group.albums.every((a) => a.monitored);
  const have = group.albums.reduce((n, a) => n + trackProgress(a.statistics).have, 0);
  const total = group.albums.reduce((n, a) => n + trackProgress(a.statistics).total, 0);
  return (
    <section aria-label={label} data-testid={`album-group-${group.type}`}>
      <div className="music-group__head">
        <MonitorSwitch
          monitored={allMonitored}
          label={t('common.monitorTitle', { monitored: allMonitored, title: label })}
          onChange={(m) => setAlbums.mutate({ artistId, albumIds: group.albums.map((a) => a.id), monitored: m })}
        />
        <h2 className="al-title-m mk-section-title">
          {label} <span className="al-num mk-muted">{group.albums.length}</span>
        </h2>
        <span className="mk-spacer" />
        <div className="lib-collection-meter">
          <Meter value={total > 0 ? (have / total) * 100 : 0} label={t('library.seriesDetails.labelProgress', { label })} valueText={`${have}/${total}`} />
        </div>
      </div>
      <div className="music-album-grid">
        {group.albums.map((album) => (
          <AlbumCard key={album.id} artistId={artistId} album={album} onMonitor={(m) => setAlbums.mutate({ artistId, albumIds: [album.id], monitored: m })} />
        ))}
      </div>
    </section>
  );
}

function AlbumCard({ album, onMonitor }: { artistId: number; album: Album; onMonitor: (m: boolean) => void }) {
  const p = trackProgress(album.statistics);
  const year = albumYear(album);
  return (
    <article className="music-album" aria-label={album.title} data-unmonitored={!album.monitored || undefined}>
      <span className="music-album__monitor">
        <MonitorSwitch monitored={album.monitored} onChange={onMonitor} label={t('common.monitorTitle', { monitored: album.monitored, title: album.title })} />
      </span>
      <Link to="/library/music/album/$id" params={{ id: String(album.id) }} className="music-card">
        <SquareArt src={albumCover(album)} title={album.title} progress={p.percent} progressTone={!album.monitored ? 'muted' : p.have < p.total ? 'warn' : 'default'} />
        <span className="music-album__title">{album.title}</span>
      </Link>
      <div className="music-album__meta">
        <span className="al-num">{year ?? '—'}</span>
        {album.secondaryTypes.length ? <span>· {album.secondaryTypes.join(', ')}</span> : null}
        <span className="al-num" style={{ marginLeft: 'auto', color: p.have < p.total ? 'var(--al-warn-text)' : undefined }}>
          {progressText(p)}
        </span>
      </div>
    </article>
  );
}

function EditArtistModal({ artist, onClose }: { artist: ArtistDetails; onClose: () => void }) {
  const profiles = useMusicQualityProfiles();
  const typeProfiles = useAlbumTypeProfiles();
  const rootFolders = useRootFolders();
  const update = useUpdateArtist();
  const [monitored, setMonitored] = useState(artist.monitored);
  const [monitorNewAlbums, setMonitorNewAlbums] = useState<MonitorNewAlbums>(artist.monitorNewAlbums);
  const [monitorOption, setMonitorOption] = useState<MusicMonitorOption | ''>('');
  const [qualityProfileId, setProfile] = useState(artist.qualityProfileId);
  const [albumTypeProfileId, setTypeProfile] = useState(artist.albumTypeProfileId);
  const [path, setPath] = useState(artist.path);
  const [tags, setTags] = useState<number[]>([...artist.tags]);
  const roots = (rootFolders.data ?? []).filter((r) => r.mediaType === 'music');

  return (
    <Modal
      open
      onClose={onClose}
      title={t('library.seriesDetails.editTitle', { title: artist.name })}
      size={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-artist-form" variant="primary" loading={update.isPending}>
            {t('common.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        id="edit-artist-form"
        className="mk-stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            {
              id: artist.id,
              body: {
                monitored,
                monitorNewAlbums,
                qualityProfileId,
                albumTypeProfileId,
                tags,
                ...(monitorOption ? { monitorOption } : {}),
                ...(path.trim() && path !== artist.path ? { path: path.trim() } : {}),
              },
            },
            { onSuccess: onClose },
          );
        }}
      >
        <FormRow label={t('status.monitored')} htmlFor="edit-artist-monitored" captionInline caption={t('music.monitoredCaption')}>
          <Toggle id="edit-artist-monitored" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
        </FormRow>
        <FormRow label={t('music.monitorNewAlbumsLabel')} htmlFor="edit-artist-new">
          <Select id="edit-artist-new" value={monitorNewAlbums} onChange={(e) => setMonitorNewAlbums(e.target.value as MonitorNewAlbums)}>
            {NEW_ALBUM_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {monitorNewAlbumsLabel(v)}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('music.reapplyMonitoring')} htmlFor="edit-artist-reapply" caption={t('music.reapplyMonitoringCaption')}>
          <Select id="edit-artist-reapply" value={monitorOption} onChange={(e) => setMonitorOption(e.target.value as MusicMonitorOption | '')}>
            <option value="">{t('music.keepAsIs')}</option>
            {MONITOR_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {monitorOptionLabel(v)}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.qualityProfile')} htmlFor="edit-artist-profile">
          <Select id="edit-artist-profile" value={String(qualityProfileId)} onChange={(e) => setProfile(Number(e.target.value))}>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('music.albumTypeProfile')} htmlFor="edit-artist-types">
          <Select id="edit-artist-types" value={String(albumTypeProfileId)} onChange={(e) => setTypeProfile(Number(e.target.value))}>
            {(typeProfiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('common.path')} htmlFor="edit-artist-path" caption={roots.length ? t('library.seriesDetails.rootFoldersMap', { map: roots.map((r) => r.path).join(', ') }) : undefined} captionMono>
          <Input id="edit-artist-path" mono value={path} onChange={(e) => setPath(e.target.value)} />
        </FormRow>
        <FormRow label={t('common.tags')}>
          <TagPicker value={tags} onChange={setTags} />
        </FormRow>
      </form>
    </Modal>
  );
}
