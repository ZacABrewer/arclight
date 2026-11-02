import { Link } from '@tanstack/react-router';
import type { SimilarArtist } from '@arclight/shared';
import { Skeleton } from '../../../arclight/index.js';
import { useSimilarArtists } from '../../../hooks/music-playlists.js';
import { t } from '../../../i18n/index.js';

/**
 * "Similar artists" on the library artist page (ListenBrainz and/or Last.fm, cached a day).
 * Artists already in the library link to their page; the rest open Add artist with the name
 * filled in. Hidden when there is nothing to show.
 */
export function SimilarArtistsStrip({ artistId }: { artistId: number }) {
  const similar = useSimilarArtists(artistId);
  if (similar.isPending) {
    return (
      <section className="music-similar" aria-busy="true">
        <h2 className="al-title-m mk-section-title">{t('musicPlaylists.similarArtists')}</h2>
        <Skeleton lines={1} />
      </section>
    );
  }
  if (similar.isError) return null;
  const items = similar.data.items;
  if (items.length === 0) return null;
  return (
    <section className="music-similar" aria-label={t('musicPlaylists.similarArtists')}>
      <h2 className="al-title-m mk-section-title">
        {t('musicPlaylists.similarArtists')} <span className="al-num al-caption">{items.length}</span>
      </h2>
      <ul className="music-similar__list">
        {items.map((a) => (
          <li key={a.mbid}>
            <SimilarLink artist={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SimilarLink({ artist }: { artist: SimilarArtist }) {
  if (artist.artistId !== null) {
    return (
      <Link to="/library/music/artist/$id" params={{ id: String(artist.artistId) }} className="music-similar__item" data-in-library="">
        <span>{artist.name}</span>
        <span className="music-similar__mark">{t('musicPlaylists.inLibrary')}</span>
      </Link>
    );
  }
  return (
    <Link to="/library/add" search={{ type: 'music', term: artist.name }} className="music-similar__item" title={t('musicPlaylists.addSimilar', { name: artist.name })}>
      <span>{artist.name}</span>
    </Link>
  );
}
