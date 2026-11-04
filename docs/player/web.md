# The player in the browser

This page describes the redesigned player at `/player` (Arclight 0.23). For turning the player
on, giving people access and the audio pages, see [Player](../using/player.md).

The player picks one of two layouts from the window size:

- **Portrait**: phones held upright (narrower than 700 px, or taller than wide below 1000 px).
  A top bar with the Arclight mark, Music, Audiobooks and your avatar; a tab bar at the bottom
  with Home, TV Shows, Movies, My List and Search; a mini player above the tab bar while
  something plays.
- **Wide**: phones on their side, tablets and computers. A header across the top with the same
  tabs, a Now playing pill, Music, Audiobooks, Settings and your avatar.

Both use the same pages. Tiles and text scale with the window between 80 % and 120 % of their
TV size.

## Account menu

Select your avatar to open the account menu: your other profiles, **Settings**, **Manage
profiles** (owner profile), **Request portal**, **Open Arclight**, **Sign in to the Arclight
app** and **Sign out**.

- **Request portal** shows when your account may request something. It opens the portal's
  public address (the first portal hostname or path under Settings > Requests > Public request
  portal) while the public portal is on, else the built-in `/portal`.
- **Open Arclight** shows when your account may open part of the app: admins, users with
  [app access](../using/users-and-security.md#app-access), and users who may manage or view
  requests or issues. It opens the first page you may use. On a
  [player hostname](address.md#open-arclight-on-a-player-hostname) it opens your Application
  URL instead, and is hidden when none is set.

Neither shows while a profile other than the owner is active (profiles cannot request).

## Who's watching?

When your account has two or more profiles, the player asks who is watching the first time you
open it in a browser tab. Choose a profile (and type its PIN if it has one). The choice lasts
until you close the tab. Switch later from your avatar menu or **Settings → Profiles**.

Choosing a profile other than your own switches the whole browser session to it. While it is
active, the admin pages and the request portal send you back to `/player`. Choose your own
profile again to get them back.

The owner profile can add a profile with the round **Add profile** tile, and the pencil
**Manage profiles** button under the row turns the tiles into edit mode: choose one to change
its name, colour and PIN, cap the movie and TV ratings it can see, or delete it. **Back**,
**Esc** or **Done** returns to choosing. With only one profile there is no picker: use **Add
profile** in the avatar menu or **Settings → Profiles**. See
[Household profiles](../guides/profiles.md#adding-and-editing-profiles-in-the-player).

## Home

- **Featured** at the top: up to five titles that change once a day. They move on every 8
  seconds unless **Rotate featured titles** is off or motion is reduced. On a phone, swipe
  them. Each shows why it is featured, the year, the rating, the length or number of seasons,
  genres and quality chips (4K, HDR, Atmos, audio languages, file size, TMDB score).
- Rows: **Continue Watching**, **Trending Now**, **New Episodes**, **Movies for Tonight**,
  **My List**, then **Recently Played** (music) and **Continue Listening** (audiobooks) when
  those sections are on. Empty rows are hidden.

Quality chips only ever appear in the line of details under a title, never on top of artwork.

## TV Shows, Movies and My List

A grid of every title with genre chips on top. Scroll to load more. My List holds what you
saved with the **My List** button on a title; each profile has its own.

## Title pages

Backdrop, title (or its logo), details, the overview, **Play** or **Resume**, **Start over**
when you are part-way through, and **My List**. Shows list their episodes by season; movies
show **More like this**. On a phone the buttons sit in a row under Play and the overview opens
with **More**.

The **More** menu (the three dots) has **Mark watched** / **Mark unwatched**, **Copy link** and,
when a movie has two or more files, **Versions**. **Copy link** puts the title's address on the
clipboard, on the [player address](address.md) when an admin set one (for example
`https://watch.example.com/watch/movies/12`), else on the address you opened the player on.

## Search

Type to search movies and shows, plus albums and audiobooks when those sections are on. Before
you type, the page shows what is popular. The phone and TV apps use the same search.

Matching is forgiving: case, accents and punctuation do not matter ("spiderman" finds
*Spider-Man*, "greys anatomy" finds *Grey's Anatomy*, "shield" finds *S.H.I.E.L.D.*), words can be
shortened or in any order ("star wa"), and "the", "a", "an", "and" and "of" may be left out or
added. Movies also match their original title and year, shows their year and network, and a show
is found by the title of an episode you have ("good news about hell"). Only what the profile may
watch is searched.

## Music and Audiobooks

Music and Audiobooks use the same page style as the rest of the player (Arclight 0.24).

- **Music**: the page title with the number of albums, chips for **Albums**, **Artists** and
  **Playlists**, then rows: **Recently played**, **Albums**, **Artists**, **Jump back in**,
  **Recently added**, **Your playlists** and **On this day**. A Recently played or Jump back in
  tile starts playing; the other tiles open their page.
- **Albums** and **Artists**: every album or artist as a grid of tiles (or a list), with search,
  sort, genre and the letter rail. **Playlists**: your playlists as tiles and **New playlist**.
- **Audiobooks**: the number of audiobooks, **Continue listening** (time left and progress),
  the newest books, each series, finished books, then the whole library as a grid you can search
  and sort.
- **Album, artist, playlist and book pages**: the artwork on a blurred backdrop, the title and
  details, **Play** (or **Resume** / **Play all**), and icon buttons for Shuffle, Add to
  playlist, Download (in the apps), Rename and Delete (playlists) and Mark finished (books). On a
  phone the artwork sits above the title and each button has its name under it. The track list,
  chapters and the series follow.
- **Search** at `/player/search` searches music and audiobooks as well as movies and shows, and
  lists tracks.

Screenshots for this section (to take for the docs site):

1. Music, wide window.
2. Music, phone portrait.
3. Albums grid, wide window.
4. Album page, wide window.
5. Album page, phone portrait.
6. Artist page, wide window.
7. Playlist page with the edit buttons, wide window.
8. Audiobooks with Continue listening, wide window.
9. Audiobook page with progress, phone portrait.
10. Search with music results, wide window.

## Settings

Six groups: Library, Playback, Subtitles, Display, Profiles and About. On a phone each group
opens its own page and choices open a sheet from the bottom.

| Setting | Where it is kept |
| --- | --- |
| Show Music, Show Audiobooks | Your profile |
| Streaming quality (Auto, Original, 1080p, 720p, 480p) | This browser, per profile |
| Autoplay next episode, Skip intros automatically | Your profile |
| Subtitle language, Text size | Your profile |
| Rotate featured titles, Reduce motion | Your profile |
| Focus style (White frame or Cyan glow) | Your profile |
| Theme | Your profile. **Cinema** unless you pick another; see [Themes](../THEMES.md) |

**Reduce motion** also follows your system's reduced-motion setting. It stops the featured
crossfade and rotation, the tile zoom on hover and the focus-ring animation.

## Watching a video

The video page has the title and episode at the top left, then play and pause, back and forward
10 seconds, the next episode, and **Audio & subtitles**. **Skip intro** shows during an intro
when the file has one marked. Move the mouse or tap to show the controls; they hide after a few
seconds of playback.

Video that is repacked or converted comes as HLS, so seeking and quality changes happen in
place. **Playback settings** then lists the stream's own quality steps, and **Auto** moves
between them to match your connection and the server. See
[How video reaches you](../using/player.md#how-video-reaches-you).
