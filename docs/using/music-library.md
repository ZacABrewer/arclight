# Music: profiles, editions and wanted tracks

This page covers how Arclight decides which albums an artist has, which edition (release) of each album it follows, and which tracks it looks for. To turn music on, go to **Settings → General → Features**.

## Album-type profiles

Go to **Settings → Profiles → Album types**. Each artist uses one album-type profile, and the profile decides which MusicBrainz release groups become albums.

| Option | What it does |
| --- | --- |
| Primary types | Album, EP, Single, Broadcast, Other. A release group is kept when its primary type is ticked |
| Secondary types | Compilation, Live, Remix, Soundtrack, Demo and so on. A release group is kept only when *every* one of its secondary types is ticked. With none ticked, only plain studio releases are kept |
| Release statuses | Official, Promotion, Bootleg, Pseudo-release. An album is kept when at least one of its editions has a ticked status |
| Preferred edition | Which edition Arclight picks when it chooses one automatically (see below) |
| Preferred countries | Two-letter country codes in order, such as `GB, US, XW` (`XW` means worldwide). Leave it empty to use the list under **Settings → General → Music metadata** |
| Preferred formats | MusicBrainz medium formats in order, such as `Digital Media, CD, Vinyl`. Leave it empty to use the metadata setting |

A fresh install comes with "Studio albums", which is the default for new artists, and "Everything".

## Editions

Most albums have several editions: the first pressing, national releases, a deluxe set, a remaster. Arclight follows one edition per album, and its track list decides what counts as complete. You can switch the edition on the album page at any time. When you switch, Arclight re-links your files by MusicBrainz recording ID first, then by disc and track position.

When Arclight picks the edition itself, it ranks them in this order:

1. Official releases come before others.
2. The profile's **preferred edition**:
   - **Most common release** (the default): no preference by kind.
   - **Original release**: the earliest release date wins.
   - **Standard**: avoids deluxe, expanded, anniversary and remastered editions.
   - **Deluxe or expanded**: prefers those, and the one with the most tracks among them.
   - **Remaster**: prefers remastered editions.
3. Preferred country, then preferred format.
4. How common the edition is, then the release date.

Arclight reads deluxe and remaster from the edition's title and its MusicBrainz disambiguation, for example "Deluxe Edition", "Collector's Edition", "Expanded" or "2011 Remaster".

**Any edition on import** on the album page lets the importer accept files that match another edition of the same album. Arclight then switches to that edition.

## Wanted tracks

Every track has a **Wanted** switch in the album's track list. It is on by default. Turn it off for tracks you don't care about, such as bonus tracks, skits or a hidden track.

- An album counts as complete once every wanted track is on disk. It then leaves **Wanted → Missing**, and searches stop looking for it.
- Release decisions count only the wanted tracks. A release that has all the wanted tracks is enough.
- The Soulseek source also accepts a folder that holds every wanted track ([music-soulseek.md](music-soulseek.md)).
- Tick tracks to get the bulk bar:
  - **Want only these** monitors the album, wants the ticked tracks and turns every other track off.
  - **Want** and **Don't want** flip just the ticked tracks.
- A playlist set to "The tracks" uses the same switches for the albums it monitored ([music-playlists.md](music-playlists.md)).

Switching edition keeps each track's switch. Arclight matches tracks by recording, then by position.

## The album page

The header shows:

- the album type and the quality on disk, for example `ALBUM · LOSSLESS 24/96`;
- the artist, track count and running time;
- a format chip such as `FLAC · 16/44.1`, or `MP3 · 320` for lossy files. A `+` means the album mixes formats.

The track list has these columns: number, title (with the track's artist credit when it differs), Wanted, time, file status and quality. On a phone each track becomes a card.

## Metadata, caching and artist bios

| Setting (Settings → General → Music metadata) | What it does |
| --- | --- |
| MusicBrainz URL | `https://musicbrainz.org` by default. Point it at your own MusicBrainz mirror to drop the public rate limit |
| Rate limit | Requests per second. Keep the default of 1 for the public server; a mirror can take more |
| Contact email | Optional. Sent in the User-Agent, as MusicBrainz asks |
| Fanart.tv key | Optional. Adds artist and album images; Wikidata and Commons images are used without it |

- **Caching:** Arclight caches MusicBrainz answers in its database. When MusicBrainz is unreachable or rate-limits it, Arclight serves the last cached answer instead of failing, even if that answer is past its refresh time.
- **Cover art:** album covers come from the Cover Art Archive.
- **Artist bios:** Arclight follows the artist's Wikidata entry (or a Wikipedia link on MusicBrainz) to the English Wikipedia article and shows its summary. Without one, it uses the Last.fm biography if a Last.fm API key is set under the playlist settings. A bio is fetched when the artist has none, and again on every full refresh.
