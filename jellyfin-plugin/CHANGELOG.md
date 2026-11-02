# Changelog

Release notes for Arclight for Jellyfin. The section for a version is copied into the plugin
repository manifest, which Jellyfin shows in Dashboard > Plugins.

## 1.3.0

- My stats: your own watch history for the last 7, 30, 90 or 365 days, or all time:
  - plays, watch time, titles, movies and episodes;
  - how things played (direct play, direct stream, transcode);
  - your top movies, series and genres, your devices and apps;
  - watch time per day, and a weekday-by-hour chart of when you watch.
- Year in review: your year in numbers (watch time, busiest month, favourite day and hour, longest day, first play, top titles and genres), with a year picker.
  - The Year in review card is shown as an image you can download.
  - "Create share link" makes an expiring link to your card, when Arclight allows share links.
- Server stats: the same view for the whole server, with the most active users, for the people Arclight allows to see it.
- A "Leaving Soon" row on the Discover page shows titles Arclight's clean-up rules will remove soon, with the date each one leaves. Titles in your library open Jellyfin's own page.
- The pages are under "Stats" in the menu. Four new settings (all on) can hide each of them. Who may see what is set in Arclight under Settings > Stats & collections.
- Needs an Arclight release newer than 0.19.0. With older Arclight versions the new pages and the Leaving Soon row stay hidden, and everything else keeps working.

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
