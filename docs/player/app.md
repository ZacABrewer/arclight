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
- The owner profile can add profiles from the picker, and edit name, colour, PIN and Kids limits, or delete profiles, under Settings > Profiles > Manage profiles.
- The app follows the active profile's theme (`ui/profile-theme.ts`); no theme means the built-in Cinema look.

## Phone

The phone shell (`ui/shell.tsx`) has tabs for Home, TV Shows, Movies, My List and Search. The top bar holds the Mark, the offline badge, Music and Audiobooks (when turned on) and the profile avatar, whose sheet has Switch profile, Settings, Manage profiles and Sign out.

In landscape (`useLayout()` is `wide`), the phone uses the same wide header as the web player instead (`ui/landscape-frame.tsx`): 72 px tall, 56 px on screens under 430 px tall, with the tabs, Music, Audiobooks, Settings and the avatar in one row. There are no bottom tabs; the mini-player docks at the bottom right. The header and the page keep clear of the side safe-area insets.

## Launch intro

On a cold launch the app shows the Arclight intro (`intro/`) over the app while it loads: the MP4 with its sound, muted if the WebView blocks sound, or the still frame when the video does not start within 1.5 s. Any key or tap skips it, and Back only skips it while it is up. With Reduce motion on, the still shows for 1 s. It never plays before a video, on resume from the background, or on a WebView reload. Settings > Display > Play intro on launch turns it off on that device.
