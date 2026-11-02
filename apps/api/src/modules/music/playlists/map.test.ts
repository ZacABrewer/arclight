import { describe, expect, it } from 'vitest';
import type { MbRecording, MbRecordingRelease } from '@arclight/metadata';
import {
  artistSimilarity,
  baseTitle,
  chooseReleaseGroup,
  creditedArtists,
  entryStatus,
  indexRemoteTracks,
  isSyncDue,
  m3uEntryPath,
  mergeSimilarArtists,
  normalize,
  pathTail,
  pickRecording,
  playlistFileName,
  renderM3u8,
  scoreRecording,
  similarity,
  trackMonitoringChanges,
} from './map.js';

const A = '33333333-3333-4333-8333-333333333333';

function rec(over: Partial<MbRecording> = {}): MbRecording {
  return {
    mbid: '55555555-5555-4555-8555-555555555555',
    title: 'Paper Lanterns',
    durationMs: 214_000,
    artistCredits: [{ artistMbid: A, name: 'The Example Band', creditedName: 'The Example Band', joinPhrase: '' }],
    isrcs: [],
    releases: [],
    ...over,
  };
}

function release(id: string, rg: { id: string; title: string; type?: string; secondary?: string[]; date?: string }, status = 'Official'): MbRecordingRelease {
  return {
    mbid: id,
    title: rg.title,
    status,
    releaseGroup: { mbid: rg.id, title: rg.title, ...(rg.type ? { primaryType: rg.type } : {}), secondaryTypes: rg.secondary ?? [], ...(rg.date ? { firstReleaseDate: rg.date } : {}) },
  };
}

describe('text helpers', () => {
  it('normalizes case, accents, ampersands and punctuation', () => {
    expect(normalize('  Beyoncé & Friends — Live!  ')).toBe('beyonce and friends live');
    expect(normalize("Don't Stop")).toBe('dont stop');
  });

  it('strips version notes and features but keeps live and remix', () => {
    expect(baseTitle('Paper Lanterns (Remastered 2011)')).toBe('Paper Lanterns');
    expect(baseTitle('Paper Lanterns - 2011 Remaster')).toBe('Paper Lanterns');
    expect(baseTitle('Paper Lanterns (feat. Someone Else)')).toBe('Paper Lanterns');
    expect(baseTitle('Paper Lanterns [Radio Edit]')).toBe('Paper Lanterns');
    expect(baseTitle('Paper Lanterns (Live at the Hall)')).toBe('Paper Lanterns (Live at the Hall)');
    expect(baseTitle('Paper Lanterns - Club Remix')).toBe('Paper Lanterns - Club Remix');
    expect(baseTitle('(Remastered)')).toBe('(Remastered)');
  });

  it('scores likeness between 0 and 1', () => {
    expect(similarity('Paper Lanterns', 'paper lanterns')).toBe(1);
    expect(similarity('Paper Lanterns', 'Paper Lantern')).toBeGreaterThan(0.9);
    expect(similarity('Paper Lanterns', 'Iron Horses')).toBeLessThan(0.3);
    expect(similarity('', '')).toBe(0);
    expect(similarity('a', 'b')).toBe(0);
  });

  it('splits credit lines', () => {
    expect(creditedArtists('A feat. B')).toEqual(['A', 'B']);
    expect(creditedArtists('A, B & C')).toEqual(['A', 'B', 'C']);
    expect(creditedArtists('Alpha x Beta')).toEqual(['Alpha', 'Beta']);
    expect(artistSimilarity('Other Artist, The Example Band', ['The Example Band'])).toBe(1);
    expect(artistSimilarity('Anyone', [])).toBe(0);
  });
});

describe('scoreRecording / pickRecording', () => {
  const track = { title: 'Paper Lanterns - Remastered', artist: 'The Example Band', durationMs: 215_000 };

  it('scores a close match highly and a stranger low', () => {
    expect(scoreRecording(track, rec())).toBeGreaterThan(0.95);
    expect(scoreRecording(track, rec({ title: 'Iron Horses', artistCredits: [{ artistMbid: A, name: 'Nobody', creditedName: 'Nobody', joinPhrase: '' }] }))).toBeLessThan(0.3);
  });

  it('weighs the length', () => {
    const near = scoreRecording(track, rec());
    const far = scoreRecording(track, rec({ durationMs: 400_000 }));
    const unknown = scoreRecording({ title: track.title, artist: track.artist }, rec());
    expect(near).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(far);
  });

  it('adds a bonus for an ISRC match, capped at 1', () => {
    const withIsrc = scoreRecording({ ...track, isrc: 'USABC2400001' }, rec({ isrcs: ['USABC2400001'] }));
    expect(withIsrc).toBe(1);
  });

  it('picks the best candidate over the threshold', () => {
    const live = rec({ mbid: 'live', title: 'Paper Lanterns (Live)', durationMs: 260_000 });
    const studio = rec({ mbid: 'studio' });
    expect(pickRecording(track, [live, studio])?.mbid).toBe('studio');
    expect(pickRecording({ title: 'Unrelated', artist: 'Someone' }, [studio])).toBeUndefined();
    expect(pickRecording(track, [])).toBeUndefined();
  });
});

describe('chooseReleaseGroup', () => {
  const album = release('r-album', { id: 'rg-album', title: 'Night Market', type: 'Album', date: '2019-05-01' });
  const single = release('r-single', { id: 'rg-single', title: 'Paper Lanterns', type: 'Single', date: '2019-03-01' });
  const comp = release('r-comp', { id: 'rg-comp', title: 'Best Of', type: 'Album', secondary: ['Compilation'], date: '2015-01-01' });
  const reissue = release('r-reissue', { id: 'rg-album-2', title: 'Night Market (Deluxe)', type: 'Album', date: '2021-01-01' });
  const bootleg = release('r-boot', { id: 'rg-boot', title: 'Live Somewhere', type: 'Album', date: '2010-01-01' }, 'Bootleg');

  it('prefers an official studio album over singles and compilations', () => {
    expect(chooseReleaseGroup({}, rec({ releases: [single, comp, album, bootleg] }))?.releaseGroup.mbid).toBe('rg-album');
  });

  it('follows the album the source names', () => {
    expect(chooseReleaseGroup({ album: 'Best Of' }, rec({ releases: [single, comp, album] }))?.releaseGroup.mbid).toBe('rg-comp');
    expect(chooseReleaseGroup({ album: 'Paper Lanterns - Single' }, rec({ releases: [single, album] }))?.releaseGroup.mbid).toBe('rg-single');
  });

  it('uses the exact release id when the source has one', () => {
    expect(chooseReleaseGroup({ releaseMbid: 'r-reissue' }, rec({ releases: [album, reissue] }))?.releaseGroup.mbid).toBe('rg-album-2');
  });

  it('takes the earliest of equals and answers undefined without groups', () => {
    expect(chooseReleaseGroup({}, rec({ releases: [reissue, album] }))?.releaseGroup.mbid).toBe('rg-album');
    expect(chooseReleaseGroup({}, rec({ releases: [{ mbid: 'x', title: 'x' }] }))).toBeUndefined();
  });
});

describe('entryStatus', () => {
  it('walks from file to nothing', () => {
    expect(entryStatus(true, { albumId: 1, trackId: 1, hasFile: true, albumMonitored: false }, false)).toBe('available');
    expect(entryStatus(true, { albumId: 1, trackId: 1, albumMonitored: true }, false)).toBe('wanted');
    expect(entryStatus(true, { albumId: 1, trackId: 1, albumMonitored: true, trackMonitored: false }, false)).toBe('notMonitored');
    expect(entryStatus(true, { albumId: 1, albumMonitored: false }, false)).toBe('notMonitored');
    expect(entryStatus(true, { artistId: 1 }, true)).toBe('artistAdded');
    expect(entryStatus(true, { artistId: 1 }, false)).toBe('notMonitored');
    expect(entryStatus(true, {}, true)).toBe('artistAdded');
    expect(entryStatus(true, {}, false)).toBe('matched');
    expect(entryStatus(false, {}, false)).toBe('unmatched');
  });
});

describe('trackMonitoringChanges', () => {
  it('monitors exactly the listed tracks', () => {
    const tracks = [
      { id: 1, monitored: true },
      { id: 2, monitored: true },
      { id: 3, monitored: false },
    ];
    expect(trackMonitoringChanges(tracks, new Set([1, 3]))).toEqual({ monitor: [3], unmonitor: [2] });
    expect(trackMonitoringChanges([], new Set([1]))).toEqual({ monitor: [], unmonitor: [] });
  });
});

describe('isSyncDue', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const base = { enabled: true, syncIntervalHours: 24, lastSyncAt: null as string | null, lastSyncStatus: 'never' };

  it('honours interval, manual-only, disabled and running', () => {
    expect(isSyncDue(base, now)).toBe(true);
    expect(isSyncDue({ ...base, lastSyncAt: '2026-11-01T11:30:00Z', lastSyncStatus: 'ok' }, now)).toBe(true);
    expect(isSyncDue({ ...base, lastSyncAt: '2026-11-02T06:00:00Z', lastSyncStatus: 'ok' }, now)).toBe(false);
    expect(isSyncDue({ ...base, syncIntervalHours: 0 }, now)).toBe(false);
    expect(isSyncDue({ ...base, enabled: false }, now)).toBe(false);
    expect(isSyncDue({ ...base, lastSyncStatus: 'running' }, now)).toBe(false);
  });
});

describe('m3u8', () => {
  it('makes safe file names', () => {
    expect(playlistFileName('Weekly: Mix / 2026?')).toBe('Weekly Mix 2026.m3u8');
    expect(playlistFileName('...')).toBe('playlist.m3u8');
  });

  it('writes relative or absolute paths', () => {
    expect(m3uEntryPath('/music/Band/Album/01 Song.flac', '/music/Playlists/Mix.m3u8', 'relative')).toBe('../Band/Album/01 Song.flac');
    expect(m3uEntryPath('/music/Band/Album/01 Song.flac', '/music/Playlists/Mix.m3u8', 'absolute')).toBe('/music/Band/Album/01 Song.flac');
    expect(m3uEntryPath('Band/01.flac', '/music/Mix.m3u8', 'relative')).toBe('Band/01.flac');
  });

  it('renders extended M3U', () => {
    const text = renderM3u8(
      'Road\nTrip',
      [
        { path: '/music/A/B/01.flac', title: 'One', artist: 'Band', durationMs: 61_400 },
        { path: '/music/A/B/02.flac', title: 'Two', artist: 'Band' },
      ],
      '/music/Mix.m3u8',
      'relative',
    );
    expect(text).toBe('#EXTM3U\n#PLAYLIST:Road Trip\n#EXTINF:61,Band - One\nA/B/01.flac\n#EXTINF:-1,Band - Two\nA/B/02.flac\n');
  });
});

describe('remote track matching', () => {
  const remote = [
    { id: 'm', recordingMbid: 'AAAA', path: '/data/elsewhere/x.flac', title: 'X', artist: 'Y' },
    { id: 'p', path: 'D:\\Media\\Music\\Band\\Album\\01 One.flac', title: 'One', artist: 'Band' },
    { id: 't', title: 'Paper Lanterns (Remastered)', artist: 'The Example Band', durationMs: 214_500 },
  ];
  const find = indexRemoteTracks(remote);

  it('takes the path tail', () => {
    expect(pathTail('C:\\a\\b\\c\\d.flac')).toBe('b/c/d.flac');
    expect(pathTail('/x/y.flac', 2)).toBe('x/y.flac');
  });

  it('matches by recording id, then path, then title and artist', () => {
    expect(find({ path: '/nowhere.flac', recordingMbid: 'aaaa', title: 'Q', artist: 'R' })?.id).toBe('m');
    expect(find({ path: '/music/Band/Album/01 One.flac', title: 'Whatever', artist: 'Band' })?.id).toBe('p');
    expect(find({ path: '/other.flac', title: 'Paper Lanterns', artist: 'The Example Band', durationMs: 214_000 })?.id).toBe('t');
    expect(find({ path: '/other.flac', title: 'Paper Lanterns', artist: 'The Example Band', durationMs: 300_000 })).toBeUndefined();
    expect(find({ path: '/other.flac', title: 'Paper Lanterns', artist: 'Someone Else' })).toBeUndefined();
  });
});

describe('mergeSimilarArtists', () => {
  const lb = [
    { mbid: 'B', name: 'Band B', score: 200 },
    { mbid: 'c', name: 'Band C', score: 100 },
    { mbid: 'self', name: 'Self', score: 900 },
  ];
  const lf = [
    { name: 'Band C', mbid: 'C', match: 0.95 },
    { name: 'Band D', mbid: 'd', match: 0.4 },
    { name: 'No Id', match: 0.99 },
  ];

  it('scales, merges and sorts', () => {
    expect(mergeSimilarArtists(lb, lf, 'SELF', 10)).toEqual([
      { mbid: 'c', name: 'Band C', score: 1, source: 'both' },
      { mbid: 'b', name: 'Band B', score: 0.222, source: 'listenbrainz' },
      { mbid: 'd', name: 'Band D', score: 0.4, source: 'lastfm' },
    ].sort((x, y) => y.score - x.score));
  });

  it('works with one side empty and honours the limit', () => {
    expect(mergeSimilarArtists([], lf, 'x', 1)).toEqual([{ mbid: 'c', name: 'Band C', score: 0.95, source: 'lastfm' }]);
    expect(mergeSimilarArtists(lb, [], 'x', 5).map((a) => a.mbid)).toEqual(['self', 'b', 'c']);
  });
});
