import { useId, useMemo, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import type { AlbumDetails, AudioFile, Track } from '@arclight/shared';
import { Button, EmptyState, KeyValue, QualityTag, SectionLabel, Select, StatusChip, Table, Tabs, Toggle, type Column } from '../../../arclight/index.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QualityLabel, QueryError } from '../../../components/media/media-kit.js';
import { useAlbum, useSetAlbumsMonitored, useUpdateAlbum } from '../../../hooks/music.js';
import { useMusicSearch } from '../../../hooks/music-acquisition.js';
import { DetailsHero } from '../details-kit.js';
import { AudioFilesTable } from '../media-files-table.js';
import { MusicCrumb, MusicGate, SquareArt } from './music-kit.js';
import { MusicInteractiveSearchModal } from './music-release-table.js';
import { albumCover, albumTypeLabel, albumYear, artistBackdrop, formatDuration, groupTracks, releaseLabel, trackProgress, type DiscGroup } from './music-model.js';
import '../library.css';
import './music.css';
import { ItemHealthPanel, useCanSeeHealth } from '../item-health.js';
import { t } from '../../../i18n/index.js';

const route = getRouteApi('/library/music/album/$id');

export function AlbumDetailsPage() {
  return (
    <MusicGate>
      <AlbumDetailsView />
    </MusicGate>
  );
}

function AlbumDetailsView() {
  const canSeeHealth = useCanSeeHealth();
  const { id: rawId } = route.useParams();
  const id = Number(rawId);
  const album = useAlbum(id);
  const setMonitored = useSetAlbumsMonitored();
  const [tab, setTab] = useState('tracks');
  const [interactive, setInteractive] = useState(false);
  const search = useMusicSearch();

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('music.invalidAlbumId', { rawId }))} title={t('music.albumNotFound')} />;
  if (album.isPending) return <Loading />;
  if (album.isError) return <QueryError error={album.error} onRetry={() => void album.refetch()} title={t('music.couldNotLoadThisAlbum')} />;
  const a = album.data;
  const p = trackProgress(a.statistics);
  const release = a.releases.find((r) => r.id === a.selectedReleaseId);
  const duration = a.tracks.reduce((n, tr) => n + (tr.durationMs ?? 0), 0);

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('music.albumOverview')}
        backdrop={artistBackdrop(a.artist)}
        art={<SquareArt src={albumCover(a)} title={a.title} className="mk-hero__poster" loading="eager" />}
        title={a.title}
        year={albumYear(a)}
        crumb={<MusicCrumb artist={a.artist} />}
        meta={[
          a.artist.name,
          [albumTypeLabel(a.primaryType), ...a.secondaryTypes].join(' · '),
          a.genres.slice(0, 3).join(', ') || null,
          t('music.trackCount', { count: p.total }),
          duration > 0 ? formatDuration(duration) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        chips={
          <>
            <MonitorSwitch
              monitored={a.monitored}
              onChange={(m) => setMonitored.mutate({ artistId: a.artistId, albumIds: [a.id], monitored: m })}
              label={t('common.monitorTitle', { monitored: a.monitored, title: a.title })}
            />
            <StatusChip status={a.monitored ? 'monitored' : 'unmonitored'} large />
            {release?.formats.map((f) => <QualityTag key={f}>{f}</QualityTag>)}
          </>
        }
        facts={
          <KeyValue
            layout="grid"
            columns={4}
            items={[
              { label: t('common.released'), value: a.releaseDate ? formatDate(a.releaseDate) : '—' },
              { label: t('music.tracks'), value: `${p.have} / ${p.total}` },
              { label: t('common.sizeOnDisk'), value: formatBytes(a.statistics?.sizeOnDisk) },
              { label: t('music.label'), value: release?.labels.map((l) => l.name).join(', ') || '—' },
            ]}
          />
        }
        overview={a.overview}
        actions={
          <>
            <Button variant="primary" loading={search.isPending} onClick={() => search.mutate({ name: 'AlbumSearch', albumIds: [a.id] })}>
              {t('common.search')}
            </Button>
            <Button onClick={() => setInteractive(true)}>{t('library.seriesDetails.interactiveSearch')}</Button>
          </>
        }
      >
        <EditionPicker album={a} />
      </DetailsHero>

      <Tabs
        aria-label={t('music.albumSections')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tracks', label: t('music.tracks'), count: a.tracks.length, content: <TrackList album={a} /> },
          { id: 'files', label: t('common.files'), count: a.files.length, content: <AudioFilesTable files={a.files} error={null} loading={false} /> },
          ...(canSeeHealth ? [{ id: 'health', label: t('library.health.tab'), content: <ItemHealthPanel scope={{ albumId: a.id }} /> }] : []),
        ]}
      />
      <MusicInteractiveSearchModal
        target={interactive ? { albumId: a.id, artistId: a.artistId } : null}
        title={`${a.artist.name} – ${a.title}`}
        albumTitles={new Map([[a.id, a.title]])}
        onClose={() => setInteractive(false)}
      />
    </div>
  );
}

/** Edition (release) choice: switching re-fetches the tracks for that release (PUT selectedReleaseId). */
function EditionPicker({ album }: { album: AlbumDetails }) {
  const update = useUpdateAlbum();
  const id = useId();
  if (album.releases.length === 0) return <p className="al-caption">{t('music.noEditionsYet')}</p>;
  const releases = [...album.releases].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.title.localeCompare(b.title));
  return (
    <div className="music-edition">
      <label className="al-label" htmlFor={`${id}-edition`}>
        {t('music.edition')}
      </label>
      <Select
        id={`${id}-edition`}
        value={album.selectedReleaseId != null ? String(album.selectedReleaseId) : ''}
        disabled={update.isPending}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isInteger(next) && next !== album.selectedReleaseId) update.mutate({ id: album.id, body: { selectedReleaseId: next } });
        }}
      >
        {album.selectedReleaseId == null ? <option value="">{t('music.chooseAnEdition')}</option> : null}
        {releases.map((r) => (
          <option key={r.id} value={r.id}>
            {releaseLabel(r)}
          </option>
        ))}
      </Select>
      <Toggle
        size="sm"
        label={t('music.anyEditionOk')}
        checked={album.anyReleaseOk}
        onChange={(e) => update.mutate({ id: album.id, body: { anyReleaseOk: e.target.checked } })}
      />
    </div>
  );
}

function TrackList({ album }: { album: AlbumDetails }) {
  const release = album.releases.find((r) => r.id === album.selectedReleaseId);
  const discs = useMemo(() => groupTracks(album.tracks, release), [album.tracks, release]);
  const fileById = useMemo(() => new Map(album.files.map((f) => [f.id, f])), [album.files]);
  if (album.tracks.length === 0) return <EmptyState title={t('music.noTracksYet')}>{t('music.noTracksBody')}</EmptyState>;
  if (discs.length === 1) return <DiscTable disc={discs[0]!} fileById={fileById} />;
  return (
    <div>
      {discs.map((d) => (
        <section key={d.medium} className="music-disc" aria-label={discTitle(d)}>
          <div className="music-disc__head">
            <SectionLabel as="h3" count={d.tracks.length}>
              {discTitle(d)}
            </SectionLabel>
          </div>
          <DiscTable disc={d} fileById={fileById} />
        </section>
      ))}
    </div>
  );
}

function discTitle(d: DiscGroup): string {
  return [t('music.discNumber', { number: d.medium }), d.name, d.format].filter(Boolean).join(' · ');
}

function DiscTable({ disc, fileById }: { disc: DiscGroup; fileById: Map<number, AudioFile> }) {
  const fileOf = (tr: Track) => (tr.audioFileId != null ? fileById.get(tr.audioFileId) : undefined);
  const columns: Column<Track>[] = [
    { key: 'disc', header: t('music.disc'), cell: (tr) => tr.mediumNumber, mono: true, width: '56px', muted: true },
    { key: 'number', header: '#', sortValue: (tr) => tr.trackNumber, cell: (tr) => String(tr.trackNumber).padStart(2, '0'), mono: true, width: '56px' },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (tr) => tr.title,
      cell: (tr) => (
        <span>
          {tr.title}
          {tr.artistCredit ? <span className="music-track__credit">{tr.artistCredit}</span> : null}
        </span>
      ),
    },
    { key: 'duration', header: t('music.duration'), sortValue: (tr) => tr.durationMs ?? 0, cell: (tr) => formatDuration(tr.durationMs), mono: true, align: 'right', width: '90px' },
    {
      key: 'file',
      header: t('common.file'),
      cell: (tr) => (tr.hasFile ? <StatusChip status="downloaded" /> : <StatusChip status="missing" />),
      width: '140px',
    },
    {
      key: 'quality',
      header: t('common.quality'),
      cell: (tr) => {
        const f = fileOf(tr);
        return f ? <QualityLabel quality={f.quality} /> : <span className="mk-muted">—</span>;
      },
    },
  ];
  return (
    <Table
      columns={columns}
      rows={disc.tracks}
      rowKey={(tr) => tr.id}
      density="dense"
      sortable={false}
      caption={t('music.discNumber', { number: disc.medium })}
    />
  );
}
