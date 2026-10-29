import { useParams, useSearch } from '@tanstack/react-router';
import type { AudioAlbumDetail, AudioArtistDetail, AudioTrackEntry } from '@arclight/shared';
import { EmptyState, KeyValue, PageHeader, Pane, Skeleton, Table, Tag, type Column, type KeyValueItem } from '../../arclight/index.js';
import { DLink } from '../../features/discover/base.js';
import { useAudioAlbum, useAudioArtist, useAudioDiscoverHome, useAudioDiscoverSearch } from '../../hooks/audio-requests.js';
import { formatDuration } from '../library/music/music-model.js';
import { AudioFeatureGate, AudioGrid, AudioHero, AudioQueryError, AudioRow, AudioSearchForm, AudioSkeletons } from './audio-kit.js';
import { t } from '../../i18n/index.js';

// Music in Discover: the home sliders with a search box (/music?q=), album pages (tracklist,
// artist, more by the artist) and artist pages (album grid, "Request artist"). Catalogue:
// MusicBrainz via /discover/music. Off (EmptyState) while the music feature flag is off.

export function MusicHomePage() {
  return (
    <AudioFeatureGate domain="music">
      <MusicHome />
    </AudioFeatureGate>
  );
}

function MusicHome() {
  const { q = '' } = useSearch({ strict: false }) as { q?: string };
  return (
    <>
      <PageHeader index="02" title={t('common.music')} actions={<AudioSearchForm key={q} domain="music" initial={q} />} />
      {q ? <AudioSearchResults domain="music" query={q} /> : <AudioHomeSections domain="music" />}
    </>
  );
}

/** The home sliders of a domain (music or audiobooks). */
export function AudioHomeSections({ domain }: { domain: 'music' | 'audiobook' }) {
  const home = useAudioDiscoverHome(domain);
  if (home.isPending) return <AudioSkeletons />;
  if (home.isError) return <AudioQueryError domain={domain} error={home.error} title={t('discover.audio.couldNotLoad')} onRetry={() => void home.refetch()} />;
  const sections = home.data.sections.filter((s) => s.items.length > 0);
  if (sections.length === 0) return <EmptyState title={t('discover.kit.nothingHereYet')}>{t('discover.audio.searchHelp')}</EmptyState>;
  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      {sections.map((s) => (
        <AudioRow key={s.id} title={s.title} items={s.items} />
      ))}
    </div>
  );
}

/** Search results of a domain: artists + albums, or authors + books. */
export function AudioSearchResults({ domain, query }: { domain: 'music' | 'audiobook'; query: string }) {
  const search = useAudioDiscoverSearch(domain, query);
  if (search.isPending) return <AudioSkeletons />;
  if (search.isError) return <AudioQueryError domain={domain} error={search.error} title={t('discover.audio.couldNotSearch')} onRetry={() => void search.refetch()} />;
  const { people, titles } = search.data;
  if (people.length === 0 && titles.length === 0) return <EmptyState title={t('discover.audio.noResults', { query })}>{t('discover.audio.tryOtherWords')}</EmptyState>;
  const music = domain === 'music';
  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      {people.length > 0 ? <AudioGrid title={music ? t('discover.audio.artists') : t('audiobooks.authors')} items={people} /> : null}
      {titles.length > 0 ? <AudioGrid title={music ? t('music.albums') : t('audiobooks.books')} items={titles} /> : null}
    </div>
  );
}

function useParam(name: 'mbid' | 'asin'): string {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  return params[name] ?? '';
}

export function MusicAlbumPage() {
  const mbid = useParam('mbid');
  return (
    <AudioFeatureGate domain="music">
      <AlbumLoader key={mbid} mbid={mbid} />
    </AudioFeatureGate>
  );
}

function AlbumLoader({ mbid }: { mbid: string }) {
  const album = useAudioAlbum(mbid);
  if (album.isPending) return <Skeleton lines={8} />;
  if (album.isError) return <AudioQueryError domain="music" error={album.error} title={t('discover.audio.couldNotLoadAlbum')} onRetry={() => void album.refetch()} />;
  return <AlbumView album={album.data} />;
}

const trackColumns: Column<AudioTrackEntry>[] = [
  { key: 'position', header: '#', mono: true, muted: true, width: '56px', cell: (r) => r.position },
  { key: 'title', get header() { return t('common.title'); }, cell: (r) => r.title },
  { key: 'duration', get header() { return t('music.duration'); }, mono: true, muted: true, align: 'right', cell: (r) => formatDuration(r.durationMs) },
];

function AlbumView({ album }: { album: AudioAlbumDetail }) {
  const { item } = album;
  const totalMs = album.tracks.reduce((sum, tr) => sum + (tr.durationMs ?? 0), 0);
  const facts: KeyValueItem[] = [
    {
      label: t('music.artist'),
      value: (
        <DLink to="/music/artist/$mbid" params={{ mbid: album.artistForeignId }}>
          {album.artistName}
        </DLink>
      ),
      mono: false,
    },
    { label: t('discover.browse.releaseDate'), value: item.releaseDate ?? (item.year ? String(item.year) : '—') },
    { label: t('music.tracks'), value: album.tracks.length ? String(album.tracks.length) : '—' },
    { label: t('music.duration'), value: totalMs > 0 ? formatDuration(totalMs) : '—' },
  ];
  return (
    <>
      <AudioHero
        item={item}
        label={t('discover.audio.albumOverview')}
        crumb={
          <>
            <DLink to="">{t('common.discover')}</DLink> / <DLink to="/music">{t('common.music')}</DLink>
          </>
        }
        meta={item.detail ?? t('music.album')}
        chips={album.genres.slice(0, 6).map((g) => (
          <Tag key={g}>{g}</Tag>
        ))}
        facts={<KeyValue layout="grid" columns={facts.length} items={facts} />}
        overview={album.overview}
      />
      <div className="mk-stack" style={{ gap: 40 }}>
        {album.tracks.length > 0 ? (
          <Pane title={t('discover.audio.tracklist')} flush bare>
            <Table columns={trackColumns} rows={album.tracks} rowKey={(r) => `${r.position}-${r.title}`} sortable={false} caption={t('discover.audio.tracklist')} />
          </Pane>
        ) : null}
        {album.moreByArtist.length > 0 ? (
          <AudioRow
            title={t('discover.audio.moreBy', { name: album.artistName })}
            items={album.moreByArtist}
            seeAll={{ to: '/music/artist/$mbid', params: { mbid: album.artistForeignId } }}
          />
        ) : null}
      </div>
    </>
  );
}

export function MusicArtistPage() {
  const mbid = useParam('mbid');
  return (
    <AudioFeatureGate domain="music">
      <ArtistLoader key={mbid} mbid={mbid} />
    </AudioFeatureGate>
  );
}

function ArtistLoader({ mbid }: { mbid: string }) {
  const artist = useAudioArtist(mbid);
  if (artist.isPending) return <Skeleton lines={8} />;
  if (artist.isError) return <AudioQueryError domain="music" error={artist.error} title={t('discover.audio.couldNotLoadArtist')} onRetry={() => void artist.refetch()} />;
  return <ArtistView artist={artist.data} />;
}

function ArtistView({ artist }: { artist: AudioArtistDetail }) {
  const { item } = artist;
  return (
    <div className="mk-stack" style={{ gap: 40 }}>
      <AudioHero
        item={item}
        label={t('discover.audio.artistOverview')}
        crumb={
          <>
            <DLink to="">{t('common.discover')}</DLink> / <DLink to="/music">{t('common.music')}</DLink>
          </>
        }
        meta={[t('music.artist'), item.subtitle, artist.country].filter(Boolean).join(' · ')}
        chips={artist.genres.slice(0, 6).map((g) => (
          <Tag key={g}>{g}</Tag>
        ))}
        overview={artist.overview}
      />
      <AudioGrid title={t('music.albums')} items={artist.albums} />
    </div>
  );
}
