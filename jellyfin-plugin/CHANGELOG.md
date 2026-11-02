# Changelog

Release notes for Arclight for Jellyfin. The section for a version is copied into the plugin
repository manifest, which Jellyfin shows in Dashboard > Plugins.

## 1.2.0

- Title pages for titles you don't have yet. Any search result, Discover title, Coming soon entry, request or recommendation opens a full page with:
  - backdrop, poster, runtime, rating and TMDB score;
  - genres, overview, cast with photos, director or creators, networks and studios;
  - trailer (opens in a new tab), release dates, and seasons with episode counts and status;
  - "Also on", request status with the request dialog, watchlist, and "More like this".
  Titles already in Jellyfin open Jellyfin's own page. Library item pages get a "View in Arclight" link.
- A bigger Discover:
  - rows: Recommended for you (from your watch history), Trending (today / this week), Popular, Top rated, In cinemas now, Upcoming, Airing today, On the air;
  - genre chips for movies and series;
  - "See all" grids that load more as you scroll;
  - genre pages with sorting (popularity, rating, release date, title) and a movies/series switch.
- The title page data, the new Discover rows and genres need an Arclight release newer than 0.18.2. With older Arclight versions the plugin keeps working, and rows Arclight doesn't know yet show an error instead of titles.

## 1.1.0

- Coming soon only lists what is not here yet: Arclight leaves out releases it already has, and the plugin also drops movies and episodes this Jellyfin already holds. Missing (placeholder) episodes still show.
- Arclight intro in Cinema Mode (opt-in): a 6-second Arclight intro before movies, and optionally before the first episode of a viewing session. Off by default; 1080p or 720p.
- New 16:9 catalog image.

## 1.0.0

- First release.
- Forwards playback start/progress/stop, watched and favourite changes, new library items and user changes to Arclight.
- Jellyfin Web: Arclight results in search with request dialog (seasons, 4K), status badges on item pages, watchlist, report a problem, subtitle/audio language requests.
- API key stays on the Jellyfin server; browser calls go through the plugin with the user's own Jellyfin session.
- Discover page, My requests page, Coming soon row, "Also on" streaming providers, quality labels on posters, and opt-in Arclight themes.
- Every call acts as the linked Arclight account: content caps, request rights and visibility follow that account.
