// Pure mapping from MusicBrainz WS/2 wire shapes to the clean types in ./types.ts.

import type {
  MbAlias,
  MbArtist,
  MbArtistCredit,
  MbArtistSearchResult,
  MbLabel,
  MbLink,
  MbMedium,
  MbMediumSummary,
  MbRelease,
  MbReleaseGroup,
  MbReleaseGroupDetail,
  MbReleaseSummary,
  MbTrack,
} from './types.js';
import type {
  MbArtistCreditWire,
  MbArtistWire,
  MbMediumWire,
  MbReleaseGroupWire,
  MbReleaseWire,
} from './schemas.js';

/** `{ key: value }` when value is present, else `{}`; keeps exactOptionalPropertyTypes happy. */
function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** Non-empty trimmed string or undefined (MusicBrainz uses "" and null interchangeably). */
function text(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInt(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/** Year of an ISO date, full or partial ("1997", "1997-05", "1997-05-21"). */
export function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const match = /^(\d{4})/.exec(date);
  return match ? Number(match[1]) : undefined;
}

export function mapArtistCredits(
  credits: readonly MbArtistCreditWire[] | null | undefined,
): MbArtistCredit[] {
  return (credits ?? []).map((credit) => ({
    artistMbid: credit.artist.id,
    name: credit.artist.name,
    creditedName: credit.name,
    joinPhrase: credit.joinphrase ?? '',
  }));
}

/** "Artist A & Artist B feat. C" from a credit list. */
export function formatArtistCredit(credits: readonly MbArtistCredit[]): string {
  return credits.map((c) => `${c.creditedName}${c.joinPhrase}`).join('').trim();
}

function artistCore(wire: MbArtistWire) {
  const lifeSpan = wire['life-span'];
  return {
    mbid: wire.id,
    name: wire.name,
    sortName: text(wire['sort-name']) ?? wire.name,
    ...maybe('disambiguation', text(wire.disambiguation)),
    ...maybe('type', text(wire.type)),
    ...maybe('country', text(wire.country)),
    ...maybe('area', text(wire.area?.name)),
    ...maybe('beginDate', text(lifeSpan?.begin)),
    ...maybe('endDate', text(lifeSpan?.end)),
    status: (lifeSpan?.ended === true ? 'ended' : 'continuing') as MbArtist['status'],
  };
}

export function mapArtistSearchResult(wire: MbArtistWire): MbArtistSearchResult {
  return { ...artistCore(wire), score: wire.score ?? 0 };
}

/** Genre names, most-voted first. */
function genreNames(genres: readonly { name: string; count?: number | null | undefined }[] | null | undefined): string[] {
  return [...(genres ?? [])]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name))
    .map((g) => g.name);
}

export function mapArtist(wire: MbArtistWire): MbArtist {
  const genres = genreNames(wire.genres);
  const aliases: MbAlias[] = (wire.aliases ?? []).map((alias) => ({
    name: alias.name,
    sortName: text(alias['sort-name']) ?? alias.name,
    ...maybe('locale', text(alias.locale)),
    primary: alias.primary === true,
    ...maybe('type', text(alias.type)),
  }));
  const links: MbLink[] = [];
  for (const relation of wire.relations ?? []) {
    const url = relation.url?.resource;
    if (url) links.push({ type: relation.type, url });
  }
  return { ...artistCore(wire), genres, aliases, links };
}

export function mapReleaseGroup(wire: MbReleaseGroupWire): MbReleaseGroup {
  const firstReleaseDate = text(wire['first-release-date']);
  return {
    mbid: wire.id,
    title: wire.title,
    ...maybe('disambiguation', text(wire.disambiguation)),
    ...maybe('primaryType', text(wire['primary-type'])),
    secondaryTypes: wire['secondary-types'] ?? [],
    ...maybe('firstReleaseDate', firstReleaseDate),
    ...maybe('year', yearOf(firstReleaseDate)),
    artistCredits: mapArtistCredits(wire['artist-credit']),
    ...maybe('score', wire.score ?? undefined),
  };
}

export function mapReleaseGroupDetail(wire: MbReleaseGroupWire): MbReleaseGroupDetail {
  return { ...mapReleaseGroup(wire), genres: genreNames(wire.genres) };
}

function mediumSummary(wire: MbMediumWire, index: number): MbMediumSummary {
  return {
    position: positiveInt(wire.position) ?? index + 1,
    ...maybe('format', text(wire.format)),
    ...maybe('title', text(wire.title)),
    trackCount: wire['track-count'],
  };
}

function releaseCore(wire: MbReleaseWire, releaseGroupMbid: string | undefined) {
  const media = (wire.media ?? []).map(mediumSummary).sort((a, b) => a.position - b.position);
  const date = text(wire.date);
  const rgMbid = wire['release-group']?.id ?? releaseGroupMbid;
  return {
    mbid: wire.id,
    ...maybe('releaseGroupMbid', rgMbid),
    title: wire.title,
    ...maybe('status', text(wire.status)),
    ...maybe('country', text(wire.country)),
    ...maybe('date', date),
    ...maybe('year', yearOf(date)),
    ...maybe('disambiguation', text(wire.disambiguation)),
    ...maybe('barcode', text(wire.barcode)),
    formats: media.map((m) => m.format ?? 'Unknown'),
    mediumCount: media.length,
    trackCount: media.reduce((sum, m) => sum + m.trackCount, 0),
    media,
  };
}

export function mapReleaseSummary(wire: MbReleaseWire, releaseGroupMbid?: string): MbReleaseSummary {
  return releaseCore(wire, releaseGroupMbid);
}

export function mapRelease(wire: MbReleaseWire): MbRelease {
  const core = releaseCore(wire, undefined);
  const releaseCredits = mapArtistCredits(wire['artist-credit']);
  const wireMedia = [...(wire.media ?? [])]
    .map((m, index) => ({ m, position: positiveInt(m.position) ?? index + 1 }))
    .sort((a, b) => a.position - b.position);

  let absolute = 0;
  let durationMs = 0;
  let anyDuration = false;
  const media: MbMedium[] = wireMedia.map(({ m, position }, index) => {
    const tracks: MbTrack[] = (m.tracks ?? []).map((t, trackIndex) => {
      absolute += 1;
      const duration = positiveInt(t.length) ?? positiveInt(t.recording.length);
      if (duration !== undefined) {
        durationMs += duration;
        anyDuration = true;
      }
      const credits = mapArtistCredits(t['artist-credit']);
      const trackPosition = positiveInt(t.position) ?? trackIndex + 1;
      return {
        mbid: t.id,
        recordingMbid: t.recording.id,
        title: t.title,
        number: text(t.number) ?? String(trackPosition),
        position: trackPosition,
        mediumNumber: position,
        absoluteNumber: absolute,
        ...maybe('durationMs', duration),
        artistCredits: credits.length > 0 ? credits : releaseCredits,
      };
    });
    return { ...mediumSummary(m, index), position, tracks };
  });

  const labels: MbLabel[] = (wire['label-info'] ?? []).flatMap((info) => {
    const name = info.label?.name;
    const catalogNumber = text(info['catalog-number']);
    if (!name && !catalogNumber) return [];
    return [
      {
        name: name ?? '[no label]',
        ...maybe('mbid', info.label?.id),
        ...maybe('catalogNumber', catalogNumber),
      },
    ];
  });

  return {
    ...core,
    artistCredits: releaseCredits,
    labels,
    ...maybe('durationMs', anyDuration ? durationMs : undefined),
    media,
  };
}
