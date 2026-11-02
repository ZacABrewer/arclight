import { useId, useMemo, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import type { AlbumDetails, AudioFile, Track } from '@arclight/shared';
import { Button, EmptyState, KeyValue, type RowKey, QualityTag, SectionLabel, Select, StatusChip, Table, Tabs, Toggle, type Column } from '../../../arclight/index.js';
import { formatBytes, formatDate } from '../../../components/media/format.js';
import { Loading, MonitorSwitch, QualityLabel, QueryError } from '../../../components/media/media-kit.js';
import { useAlbum, useSetAlbumsMonitored, useSetTracksMonitored, useUpdateAlbum, useWantTracks } from '../../../hooks/music.js';
import { useMusicSearch } from '../../../hooks/music-acquisition.js';
import { DetailsHero } from '../details-kit.js';
import { AudioFilesTable } from '../media-files-table.js';
import { MusicCrumb, MusicGate, SquareArt } from './music-kit.js';
import { MusicInteractiveSearchModal } from './music-release-table.js';
import { SoulseekActions, useSoulseekAvailable } from './soulseek-search.js';
import {
  albumCover,
  albumEyebrow,
  albumFormat,
  albumTypeLabel,
  albumYear,
  artistBackdrop,
  formatChipText,
  formatDuration,
  groupTracks,
  releaseLabel,
  trackProgress,
  type DiscGroup,
} from './music-model.js';
import '../library.css';
import './music.css';
import { ItemHealthPanel, useCanSeeHealth } from '../item-health.js';
import { dateReleaseState } from '../../../components/media/release-state.js';
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
  const soulseek = useSoulseekAvailable();

  if (!Number.isInteger(id) || id <= 0) return <QueryError error={new Error(t('music.invalidAlbumId', { rawId }))} title={t('music.albumNotFound')} />;
  if (album.isPending) return <Loading />;
  if (album.isError) return <QueryError error={album.error} onRetry={() => void album.refetch()} title={t('music.couldNotLoadThisAlbum')} />;
  const a = album.data;
  const p = trackProgress(a.statistics);
  const release = a.releases.find((r) => r.id === a.selectedReleaseId);
  const duration = a.tracks.reduce((n, tr) => n + (tr.durationMs ?? 0), 0);
  const format = albumFormat(a.files);

  return (
    <div className="lib-details music-details">
      <DetailsHero
        label={t('music.albumOverview')}
        eyebrow={albumEyebrow(a.primaryType, format)}
        titleAside={
          format ? (
            <span className="music-format-chip" data-lossless={format.lossless || undefined} title={t('music.album.formatOnDisk')}>
              {formatChipText(format)}
            </span>
          ) : null
        }
        backdrop={artistBackdrop(a.artist)}
        art={<SquareArt src={albumCover(a)} title={a.title} className="mk-hero__poster" loading="eager" />}
        title={a.title}
        year={albumYear(a)}
        crumb={<MusicCrumb artist={a.artist} />}
        meta={[
          a.artist.name,
          [...(a.secondaryTypes.length > 0 ? [albumTypeLabel(a.primaryType)] : []), ...a.secondaryTypes].join(' · ') || null,
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
            {soulseek ? <SoulseekActions albumId={a.id} title={`${a.artist.name} – ${a.title}`} /> : null}
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
        release={dateReleaseState(a)}
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
  const wanted = album.tracks.filter((tr) => tr.monitored !== false).length;
  const note =
    wanted < album.tracks.length ? <p className="music-wanted-note">{t('music.album.wantedNote', { wanted, total: album.tracks.length })}</p> : null;
  if (discs.length === 1)
    return (
      <>
        {note}
        <DiscTable album={album} disc={discs[0]!} fileById={fileById} />
      </>
    );
  return (
    <div>
      {note}
      {discs.map((d) => (
        <section key={d.medium} className="music-disc" aria-label={discTitle(d)}>
          <div className="music-disc__head">
            <SectionLabel as="h3" count={d.tracks.length}>
              {discTitle(d)}
            </SectionLabel>
          </div>
          <DiscTable album={album} disc={d} fileById={fileById} />
        </section>
      ))}
    </div>
  );
}

function discTitle(d: DiscGroup): string {
  return [t('music.discNumber', { number: d.medium }), d.name, d.format].filter(Boolean).join(' · ');
}

/**
 * One disc's tracks: # / title (credit) / wanted / time / file / quality. Rows are selectable;
 * the bulk bar wants exactly the selection (the album is monitored, every other track is not)
 * or flips the wanted switch of the selected tracks.
 */
function DiscTable({ album, disc, fileById }: { album: AlbumDetails; disc: DiscGroup; fileById: Map<number, AudioFile> }) {
  const setTracks = useSetTracksMonitored();
  const wantOnly = useWantTracks();
  const fileOf = (tr: Track) => (tr.audioFileId != null ? fileById.get(tr.audioFileId) : undefined);
  const busy = setTracks.isPending || wantOnly.isPending;
  const monitorTracks = (trackIds: number[], monitored: boolean) => setTracks.mutate({ albumId: album.id, artistId: album.artistId, trackIds, monitored });
  const ids = (keys: Set<RowKey>) => [...keys].map(Number).filter((n) => Number.isInteger(n));
  const columns: Column<Track>[] = [
    { key: 'number', header: '#', sortValue: (tr) => tr.trackNumber, cell: (tr) => String(tr.trackNumber).padStart(2, '0'), mono: true, width: '56px', muted: true },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (tr) => tr.title,
      mobile: 'primary',
      cell: (tr) => (
        <span className="music-track" data-unwanted={tr.monitored === false || undefined}>
          {tr.title}
          {tr.artistCredit ? <span className="music-track__credit">{tr.artistCredit}</span> : null}
        </span>
      ),
    },
    {
      key: 'wanted',
      header: t('music.album.wanted'),
      width: '84px',
      cell: (tr) => (
        <MonitorSwitch
          monitored={tr.monitored !== false}
          disabled={busy}
          onChange={(m) => monitorTracks([tr.id], m)}
          label={t('music.album.wantTrack', { title: tr.title })}
        />
      ),
    },
    { key: 'duration', header: t('music.duration'), sortValue: (tr) => tr.durationMs ?? 0, cell: (tr) => formatDuration(tr.durationMs), mono: true, align: 'right', width: '90px' },
    {
      key: 'file',
      header: t('common.file'),
      cell: (tr) => (tr.hasFile ? <StatusChip status="downloaded" /> : <StatusChip status={tr.monitored === false ? 'unmonitored' : 'missing'} />),
      width: '140px',
    },
    {
      key: 'quality',
      header: t('common.quality'),
      mobile: 'hide',
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
      selectable
      rowLabel={(tr) => t('music.album.selectTrack', { title: tr.title })}
      bulkActions={(keys, clear) => (
        <>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => wantOnly.mutate({ albumId: album.id, artistId: album.artistId, trackIds: ids(keys) }, { onSuccess: clear })}
          >
            {t('music.album.wantOnlyThese')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => (monitorTracks(ids(keys), true), clear())}>
            {t('music.album.wantSelected')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => (monitorTracks(ids(keys), false), clear())}>
            {t('music.album.unwantSelected')}
          </Button>
        </>
      )}
    />
  );
}
