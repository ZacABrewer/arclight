# Changelog

Release notes for Arclight for Jellyfin. The section for a version is copied into the plugin
repository manifest, which Jellyfin shows in Dashboard > Plugins.

## 1.0.0

- First release.
- Forwards playback start/progress/stop, watched and favourite changes, new library items and user changes to Arclight.
- Jellyfin Web: Arclight results in search with request dialog (seasons, 4K), status badges on item pages, watchlist, report a problem, subtitle/audio language requests.
- API key stays on the Jellyfin server; browser calls go through the plugin with the user's own Jellyfin session.
- Discover page, My requests page, Coming soon row, "Also on" streaming providers, quality labels on posters, and opt-in Arclight themes.
- Every call acts as the linked Arclight account: content caps, request rights and visibility follow that account.
