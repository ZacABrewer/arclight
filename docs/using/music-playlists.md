# Music: playlists and similar artists

Arclight can follow playlists from Spotify, Deezer, ListenBrainz and Last.fm. On each sync it reads the playlist and matches every track to MusicBrainz and your library. It can then want what is missing, write an `.m3u8` file, and push the playlist to Jellyfin, Emby, Plex or Navidrome.

It also shows **similar artists** on artist pages, in the library and in Discover.

Both only show while music is turned on. The Playlists page is for admins.

## Following a playlist

1. Open **Library > Music > Playlists** (or **Playlists** at the top of the music library).
2. Press **New playlist**.
3. Give it a name. This name is used for the `.m3u8` file and for the playlist on your media servers.
4. Pick a **Source** and fill in its fields (see below). **Preview** reads the source and shows its title and first tracks. Nothing is saved or matched yet.
5. Choose what to **Want**, the outputs and how often to sync, then **Save**.
6. Press **Sync now**, or wait for the next scheduled sync.

| Source | What you enter | Notes |
|---|---|---|
| Spotify | A playlist link or ID | Needs a Spotify app (see [Sources and outputs](#sources-and-outputs)). Spotify only lets new apps read playlists that users made. Its own editorial and algorithmic playlists (such as "Discover Weekly") are refused |
| Deezer | A public playlist link or ID | No account needed |
| ListenBrainz playlist | A playlist link or ID | No account needed. ListenBrainz tracks carry MusicBrainz recording IDs, so they match best |
| ListenBrainz made for a user | A user name and, optionally, a playlist type such as `weekly-jams` or `weekly-exploration` | Follows the newest playlist of that type that ListenBrainz made for the user. Leave the type empty to follow the newest of any type |
| Last.fm chart | A user name, **Top tracks** or **Loved tracks**, a period (top tracks only) and how many tracks (1 to 200) | Needs a Last.fm API key |

Changing a playlist's source clears its matched tracks. The next sync starts over.

## What a sync does

Each track goes through these steps until one finds it:

1. **Recording ID.** The source already gave a MusicBrainz recording (ListenBrainz does).
2. **ISRC.** The track's ISRC code is looked up on MusicBrainz (Spotify and Deezer give one for most tracks).
3. **Library.** The artist and title match a track already in your library.
4. **Search.** A MusicBrainz search on the artist, title and album, then again without the album.

MusicBrainz allows about one request a second, so a long playlist can take a few minutes on its first sync. Matches are cached, so later syncs are quick. **MusicBrainz searches per sync** caps step 4; tracks past the cap are tried on the next sync. If MusicBrainz stops answering, the sync stops searching and keeps what it found.

Then, depending on **Want**:

| Want | What happens |
|---|---|
| Nothing (match only) | Nothing is monitored. You see what you have and what you are missing |
| The tracks | Each listed track's album is monitored. On albums the playlist monitored, only the listed tracks are wanted (their **Wanted** switch, see [music-library.md](music-library.md#wanted-tracks)). Albums you monitored yourself keep all their tracks |
| Their albums | The whole album of every listed track is monitored |

A wanted album that is not in the library yet is added under its artist. When **Add missing artists** is on, artists that are not in the library are added too. They are added with nothing monitored, in the root folder and profile you chose (or the first ones). Only what the playlist wants is monitored once their albums load, which happens on a follow-up sync a little later. With **Search for newly wanted albums**, Arclight starts an album search for what the sync just wanted.

Arclight never unmonitors an album because a track left the playlist.

### Track statuses

Open a playlist (click its name) to see every track and where it stands:

| Status | Meaning |
|---|---|
| Available | The track has a file in your library |
| Wanted | Monitored, no file yet |
| Not monitored | In your library, not wanted |
| Artist added | The artist was just added and its albums are loading |
| Not in library | Found on MusicBrainz, but its artist is not in your library |
| Not found | No MusicBrainz recording matched |

### Sync results

| Result | Meaning |
|---|---|
| Synced | Everything worked |
| Partial | The tracks were read, but something else failed: some tracks were not found, the `.m3u8` could not be written, or a push failed. Hover the status (or open the playlist) for the reason |
| Failed | The source could not be read. Nothing was changed |

## Outputs

**Write an .m3u8 file** lists the tracks you have, in playlist order, for any player that reads playlist files. The file goes to the **Playlist folder** (or the first music root folder) and is named after the playlist. Track paths are relative to the file by default, so the folder can be mounted elsewhere. Choose **Absolute** if your player needs full paths.

**Push to** creates the playlist on each chosen server, then replaces its contents on every sync:

- **Jellyfin and Emby** servers from Settings > Media Servers. The playlist belongs to the first admin account the API key can see.
- **Plex** servers from Settings > Media Servers. Tracks are found in the music libraries.
- **Navidrome**, or any server with the Subsonic API, using the account under [Sources and outputs](#sources-and-outputs).

Tracks are matched on each server by MusicBrainz ID, file path, or artist, title and length. Tracks the server does not have are left out and counted in the sync message. If someone deletes the playlist on the server, the next sync creates it again. Deleting a playlist in Arclight leaves the `.m3u8` file and the server playlists alone.

## Sync schedule

Arclight checks every hour for playlists that are due. **Sync every** sets the hours between syncs (default 24). Set it to 0 to sync only when you press **Sync now**. Turning a playlist off (**Enabled**) pauses its scheduled syncs.

## Sources and outputs

**Sources & outputs** on the Playlists page holds the accounts and defaults that all playlists share. Secrets are stored like other secrets and shown masked.

| Setting | What it does |
|---|---|
| Spotify client ID and secret | From an app you create in the Spotify developer dashboard. Only needed for Spotify sources |
| Last.fm API key | Free from the Last.fm API page. Needed for Last.fm charts and for Last.fm similar artists |
| Similar artists from | **ListenBrainz and Last.fm** (default; Last.fm is used only with a key), **ListenBrainz only** or **Last.fm only** |
| Playlist folder | Where `.m3u8` files go. Empty uses the first music root folder. In Docker, this is a path inside Arclight's container |
| Track paths | Relative (default) or absolute paths in the `.m3u8` |
| Navidrome URL, user name, password | The account for the **Navidrome** push target. Requests are signed with a salted token; the password is never sent as is |
| MusicBrainz searches per sync | Cap on MusicBrainz searches in one sync (0 to 1000, default 200) |

## Similar artists

An artist's page in the library ends with **Similar artists**: up to 20 artists from ListenBrainz and/or Last.fm, closest first. Artists already in your library are marked **In library** and open their page. The others open **Add artist** with the name filled in.

Discover shows the same list on its artist pages, as cards with each artist's status (see [Discover and requests](discover-and-requests.md#similar-artists)).

Lists are cached for a day. If both services fail, the last list is shown; with no list at all, the section is hidden.

## Related

- [Library](library.md) - adding artists and monitoring albums
- [Media servers](media-servers.md) - connecting Jellyfin, Emby and Plex
- [Discover and requests](discover-and-requests.md) - music requests
- [Music: cue sheets and tagging](music-cue-and-tagging.md)
