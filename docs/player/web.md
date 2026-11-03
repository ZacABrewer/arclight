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

## Who's watching?

When your account has two or more profiles, the player asks who is watching the first time you
open it in a browser tab. Choose a profile (and type its PIN if it has one). The choice lasts
until you close the tab. Switch later from your avatar menu or **Settings → Profiles**.

Choosing a profile other than your own switches the whole browser session to it. While it is
active, the admin pages and the request portal send you back to `/player`. Choose your own
profile again to get them back.

The owner profile can **Manage profiles**: add a profile, change its name, colour and PIN,
cap the movie and TV ratings it can see, or delete it.

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

## Search

Type to search movies and shows, plus albums and audiobooks when those sections are on. Before
you type, the page shows what is popular.

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
