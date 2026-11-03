# Import lists

Import lists add titles for you. Arclight reads each list on a schedule and adds what is on it to your library with the root folder, quality profile, monitoring and tags you chose for that list. Open **Settings > Import Lists** (administrators).

Arclight is not a media server, so "available" below always means "in your Arclight library" or "on one of your streaming subscriptions". It never reads what is on your Jellyfin, Emby or Plex server, except for the Jellyfin/Emby favourites list described below.

## Adding a list

1. Click **Add list** and pick a source.
2. Fill in the source fields (a list id, a user name, an API key and so on).
3. Set the list options and, if you want, the list rules (both below).
4. Click **Preview** to see what the list would add right now. Nothing is added yet.
5. Click **Save**.

**Test** only checks that the source answers and shows the first titles. **Preview** runs the whole list through your library, exclusions and rules, and tells you "This list would add 37 titles", plus how many it would skip and why: already in the library, excluded, rating too low, too few votes, outside the years, or on your streaming services. It also counts entries it could not match to a TMDB title (for example an anime missing from the mapping data). The preview lists up to 500 titles, the ones it would add first.

## Sources

| Source | What it reads | You need |
|---|---|---|
| TMDB List | A public TMDB list. | The list id. |
| TMDB Popular | Popular, top rated, trending, now playing, upcoming (movies), airing today and on the air (series). | Nothing extra. |
| TMDB Collection | Every movie in a collection. | The collection id. |
| TMDB Person | An actor's or crew member's titles. | The person id. |
| TMDB Keyword | Titles tagged with a keyword. | The keyword id. |
| TMDB Company | Every movie from a studio or production company. | The company id (the number in the TMDB company URL). |
| TMDB Network | Every series from a network or streaming service. | The network id. |
| TMDB Discover | A discover query: keywords, companies, networks, streaming services, certification, runtime, sorted by popularity, rating, votes, release date or revenue. | Nothing extra. |
| Trakt List | One Trakt list. | A Trakt app and sign-in (below). |
| Trakt Popular | Trending, popular, anticipated, most watched, played, collected or recommended (for a day, week, month, year or all time), and the box office. | A Trakt client id. |
| Trakt User | A user's watchlist, watched history, collection, favourites, or your personal recommendations. | A Trakt client id; recommendations need sign-in. |
| Trakt User Lists | Every list a user made or liked, or only the ones you name. | A Trakt client id; private lists need sign-in. |
| IMDb List | A public IMDb list or watchlist. | The list id or URL. |
| IMDb Top Rated | IMDb's highest-rated titles with at least the votes you set. | Nothing extra. |
| Letterboxd | A watchlist, one of a user's lists, their diary, or any list URL. Movies only. | The user name or list URL. |
| MDBList | Any MDBList list. | A free MDBList API key. |
| AniList | A user's anime list (by status), or seasonal, trending, popular and top anime. | The user name for user lists. |
| MyAnimeList | A user's anime list (by status), a season, or a ranking. | A MyAnimeList client id (create one at myanimelist.net/apiconfig). |
| Kitsu | A user's library (by status) or trending anime. | The user name for libraries. |
| Simkl | Your plan to watch, watching and other lists, for shows, movies and anime. | A Simkl developer app and sign-in (below). |
| Jellyfin / Emby Favorites | One user's favourite movies and series on your Jellyfin or Emby server. | The server URL, an API key and the user name. |
| Plex Watchlist | Your Plex watchlist. | A Plex token. |
| RSS / JSON feed | An RSS or Atom feed, or a JSON list of titles. | The URL. |
| StevenLu | The StevenLu popular movies feed. | Nothing extra. |
| Custom JSON / CSV URL | Any JSON or CSV document that lists ids (below). | The URL. |

### Signing in to Trakt and Simkl

Both use a code you type on their site, so Arclight never sees your password.

- **Trakt:** create an app at trakt.tv (Settings > Your API Apps), paste its client id and secret, then click **Authenticate with Trakt**, open the link and enter the code.
- **Simkl:** create a developer app at simkl.com (Settings > Developer), paste its client id, then click **Authenticate with Simkl**, open the link and enter the code.

Save the list afterwards to keep the token. Tokens are stored as secrets and never shown again.

### Custom JSON / CSV URL

Point this at any document you or another tool publishes. Arclight reads ids, never code.

- **JSON:** an array of objects, or an object with the array at **Items path** (for example `data.items`). Each object needs at least one of `tmdbId` (or `tmdb_id`, `tmdb`), `imdbId` (or `imdb_id`, `imdb`), `tvdbId` (or `tvdb_id`, `tvdb`). Trakt-style rows (`{"movie": {"ids": {...}}}`) and bare arrays of TMDB ids also work. Optional: `title`, `year`, `mediaType`.
- **CSV:** a header row with a `tmdb`, `imdb` or `tvdb` column (common spellings such as `tmdb_id`, `IMDb ID` or `Const` are recognised). Optional: `title`, `year`, `type`.
- **Header name / value:** an optional request header, for example `Authorization` with a token. The value is stored as a secret.

## List options

Every list has the options used when it adds a title: root folder (a series and a movie folder for lists of both), quality profile, monitoring, series type and season folders (series), minimum availability (movies), tags, and **Search on add**. **Add automatically** off means the list is fetched (so you can see it and its "found in lists" chips) but nothing is added.

## List rules

Under **List rules** in the list editor:

| Rule | What it does |
|---|---|
| Sync every | Hours between syncs of this list. Empty uses the global interval under **Options** on the same page. |
| Minimum rating, Minimum votes | TMDB rating (0 to 10) and vote count a title needs. |
| Released from, Released until | Release years a title must fall in. |
| Skip titles on my streaming services | Titles included with one of the subscriptions you pick, in the country you pick, are not added. |
| When a title leaves the list | Keep it, unmonitor it, remove it from the library, or remove it and delete its files. |

A title that one list skips because of its rules can still be added by another list with looser rules.

**Streaming data** comes from TMDB's watch-provider data (supplied to TMDB by JustWatch). Only subscription ("flatrate") offers count; rentals and purchases do not. Leave the country empty to use your metadata region (Settings > General). If the lookup fails, the title is added rather than silently skipped.

**Clean-up** only touches titles this list added, and only once they are on no other enabled list. Titles you added yourself, or that another list or a request added, are never touched. If a list suddenly comes back empty, Arclight treats that as a problem with the source and does nothing. The global **Clean library level** under **Options** still applies to titles on no list at all.

## Anime

AniList, MyAnimeList, Kitsu and Simkl anime entries are matched to TMDB (and TVDB) with the community [Anime-IDs](https://github.com/Kometa-Team/Anime-IDs) mapping file (MIT licence). Arclight downloads it once a week into its config folder (`cache/import-lists`) and keeps using the last good copy if a download fails. Anime that the file does not map yet are counted as "Not matched" in the preview and skipped.

## Notes and limits

- **IMDb Top Rated** uses IMDb's official [non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) (the ratings file, about 8 MB, downloaded at most once a day). The datasets are for personal, non-commercial use. IMDb has no public "most popular" feed, so there is no IMDb popular list.
- **IMDb List** reads IMDb's list export. IMDb sometimes blocks automated requests to it; if a list fails with a blocked or empty response, use the same list through MDBList or a custom URL.
- **Letterboxd** has no public API, so Arclight reads the public list pages (and each film's page once, to find its TMDB id; the match is remembered). If Letterboxd changes its pages, this source can stop working until Arclight is updated. Private lists cannot be read.
- **Rotten Tomatoes and Metacritic** have no public list feed or API that may be used this way, so there is no source for them. MDBList offers lists filtered and sorted by those scores; add one with the MDBList source.
- An RSS, JSON or custom-URL document larger than 16 MB is refused ("sent more than 16 MB"). Real feeds are far smaller.
- Each list is limited to the number of titles you set (where the source has a limit field) to stay inside the source's rate limits.

## API

All under `/api/v1` (administrators): `GET/POST /importlist`, `GET/PUT/DELETE /importlist/{id}`, `GET /importlist/schema`, `POST /importlist/test`, `POST /importlist/preview` (same body as create, plus an optional `id` to reuse stored secrets), `POST /importlist/sync`, `GET /importlist/{id}/items`, `POST /importlist/trakt/device` and `/trakt/poll`, `POST /importlist/simkl/pin` and `/simkl/poll`. A list's rules are the fields `syncIntervalHours`, `filters` (`minRating`, `minVotes`, `yearFrom`, `yearTo`), `streaming` (`enabled`, `region`, `providerIds`) and `cleanupAction` (`none`, `unmonitor`, `remove`, `removeAndDeleteFiles`). They are also part of the config export (Settings > General > Config as code).
