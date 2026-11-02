# Changelog

Release notes for Arclight for Jellyfin. The section for a version is copied into the plugin
repository manifest, which Jellyfin shows in Dashboard > Plugins.

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
