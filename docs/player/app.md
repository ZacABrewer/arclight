# Arclight app: TV and phone shell

How the Arclight app (`apps/player`) lays out its screens. Using the app is covered in [docs/using/arclight-app.md](../using/arclight-app.md); building it is in [apps/player/README.md](../../apps/player/README.md).

## Layout switch

`tv/tv-mode.ts` decides once at start-up whether the device is a TV (Leanback, or `?tv=1` in a browser). The router renders the TV screen or the phone page for the same route (`byDevice` in `app/router.tsx`), so links and deep links are identical on both.

## TV

- **Stage.** Every TV screen is drawn on a fixed 1920x1080 stage (`tv/stage.tsx`), scaled to fit the screen. The top header (Home, TV Shows, Movies, My List, Search; Music and Audiobooks when turned on; Settings) stays fixed; the page under it scrolls.
- **Focus.** `tv/focus-manager.ts` moves focus with the D-pad. Elements opt in with data attributes:
  - `data-tv-row`: left and right stay inside the row.
  - `data-tv-fixed`: the header; moving up into it from the page only happens when nothing in the page is above.
  - `data-tv-scroll="x|y"`: a row or page that scrolls to keep the focused item in view (smooth unless Reduce motion is on).
  - `data-tv-key`: a stable key, so focus comes back to the same item when you return to a page.
  - `data-tv-autofocus`: where focus starts on a page.
  - `data-tv-scope`: a panel (PIN pad, name keyboard, editor) that traps focus until it closes.
  - `data-tv-r`: the focus ring's corner radius.
  Focus style follows the profile setting (white frame or cyan glow).
- **Back** (`tv/tv-runtime.ts`), in order: an open panel closes; a pushed screen (a title, Listen) goes back; a tab other than Home goes to Home; on Home, Back first moves focus to the Home tab, and from there leaves the app. On "Who's watching?" Back does nothing.
- **Screens** (`tv/screens/`): `home` (rotating hero, then Continue Watching, Trending, New Episodes, Movies for Tonight, Recently Played, Continue Listening, My List, each only when it has items), `browse` (TV Shows, Movies, My List with genre chips), `detail`, `search`, `music` (Music and Audiobooks), `listen`, `settings`, `profiles` and `manage-profiles`.
- **Settings** are saved to the active profile, except Streaming quality and Play intro on launch, which stay on the device.

## Profiles

- `households/gate.ts`: before the first `/player` page of an app run, accounts with two or more profiles go to `/profiles` ("Who's watching?").
- `households/use-pick.ts`: picking a profile, with the PIN step, wrong-PIN and lock messages.
- The owner profile can add profiles from the picker's round Add tile (the full profile page, saved at once) and edit them in the picker's edit mode (the pencil button under the row; Back leaves it), or under Settings > Profiles > Manage profiles. Settings > Profiles > Add profile, and Add profile in the phone's avatar sheet, cover an account with one profile, which has no picker.
- The app follows the active profile's theme (`ui/profile-theme.ts`); no theme means the built-in Cinema look.

## Phone

The phone shell (`ui/shell.tsx`) has tabs for Home, TV Shows, Movies, My List and Search. The top bar holds the Mark, the offline badge, Music and Audiobooks (when turned on) and the profile avatar, whose sheet has Switch profile, Settings, Manage profiles, Add profile (owner profile, below the limit) and Sign out.

In landscape (`useLayout()` is `wide`), the phone uses the same wide header as the web player instead (`ui/landscape-frame.tsx`): 72 px tall, 56 px on screens under 430 px tall, with the tabs, Music, Audiobooks, Settings and the avatar in one row. There are no bottom tabs; the mini-player docks at the bottom right. The header and the page keep clear of the side safe-area insets.

## Launch intro

On a cold launch the app shows the Arclight intro (`intro/`) over the app while it loads: the MP4 with its sound, muted if the WebView blocks sound, or the still frame when the video does not start within 1.5 s. Any key or tap skips it, and Back only skips it while it is up. With Reduce motion on, the still shows for 1 s. It never plays before a video, on resume from the background, or on a WebView reload. Settings > Display > Play intro on launch turns it off on that device.

## Video player (Android)

Movies and episodes play in the native player (`video/native-video.ts` asks the server for a session and hands it to `VideoActivity`).

- **Delivery.** The app tells the server it takes HLS as well as progressive streams. Anything that is not direct play then comes as an HLS session: fMP4 segments that carry media time, so seeking, ±10 s and scrubbing stay in the player and subtitles line up without shifting. A server older than 0.24 keeps sending progressive streams, and seeking in those still asks for a new stream.
- **Quality.** On Auto the player adapts across the server's ladder, never above the screen's height. Original, 1080p, 720p and 480p lock one variant. When the server reports that its encoder cannot keep up (the session's health, or the `X-Arclight-Encode` header on segments), Auto stays at or below the rung it names.
- **Buffering.** At least 30 s ahead, up to 120 s on phones and 60 s on TVs and low-memory devices, capped at a quarter of the app's memory (32 to 150 MB). 30 s stays behind the playhead, so seeking back is instant.
- **Start rung.** The last throughput measured on this network type (Wi-Fi/other or cellular), kept per account on the device, seeds the bandwidth estimate. Without one, the player starts on the rung the server picked.
- **Health.** Progress reports carry the startup time and the number and length of rebuffers after startup; seeks and short blips under 0.5 s are not counted. In direct play on Auto, two rebuffers within 60 s or one longer than 3 s make the player ask once for an HLS stream at the same position.
- **Never stuck.** A stream that shows no picture within 25 s of wanted playback (60 s for a converted stream), stays in one rebuffer for 60 s, or fails to decode on the device (or, over HLS, breaks on the server) is replaced once per item by a safe stream at the same position: H.264 with AAC stereo in MP4, up to 1080p, converted by the server as needed, and progressive when HLS was the stream that failed. This happens on any quality. If that one fails too, or the app does not answer a stream request within 45 s, the player closes and says the video could not load. Paused time and time in the background do not count. Logcat (`ArclightVideo`) shows `No picture in time`, `Stuck buffering` or `Playback failed (...)` with what happened next.
- **Sessions.** When a video closes, moves on to the next episode, or is replaced, the app ends its HLS session so the server can free the encoder.
