# Indexers

Indexers are the sites Arclight searches to find releases: torrent trackers and usenet providers. This page covers adding and testing indexers, the proxies and challenge solver that get you past Cloudflare, global indexer options, private-tracker account tracking, indexer statistics, and cross-seeding. Everyone needs at least one working indexer; the rest is for private trackers, Cloudflare-protected sites and power users.

Arclight does the job Prowlarr does, so you do not need Prowlarr (it works fine alongside Arclight if you already run it, as a Torznab/Newznab source).

## Where things live

| What | Where |
|---|---|
| Add, edit, test indexers | Settings > Indexers (also reachable from the Indexers section in the left rail) |
| Proxies (FlareSolverr, HTTP, SOCKS5) | Settings > Indexer Proxies |
| Global limits, RSS interval, site definition feed | Settings > Indexer Options |
| Built-in Cloudflare solver | Settings > Challenge Solver |
| Cross-seed settings | Settings > Cross-seed |
| Usage charts | Indexers > Stats |
| Private tracker ratio and buffer | Indexers > Tracker stats |
| Cross-seeds found | Activity > Cross-seeds |

## Adding an indexer

1. Go to Settings > Indexers and press **Add indexer**.
2. Choose how to add it:
   - **Definitions**: pick a site from the catalogue (public, semi-private or private). Filter by privacy, protocol and language, or search by name.
   - **Endpoint types**: add a generic **Torznab** (torrents) or **Newznab** (usenet) endpoint. Use this for Jackett, Prowlarr, NZBHydra or any tracker that offers a Torznab/Newznab API: you supply a URL and an API key.
3. Fill in the form (below) and press **Test**. Arclight reports how many releases came back, or what went wrong.
4. Save.

**Test all** on the main page tests every indexer at once.

### Settings of an indexer

| Setting | Default | What it does |
|---|---|---|
| Name | - | Your label |
| Enable RSS | On | Poll this indexer for new releases (needed to grab new episodes as they appear) |
| Enable automatic search | On | Use for automatic and Wanted searches |
| Enable interactive search | On | Use for manual searches from [Interactive search](interactive-search.md) |
| Priority | 25 | 1 is the highest, 50 the lowest. Breaks ties between equally good releases |
| Tags | none | Only use for items with a matching tag; empty means all items |
| Download client | none | Send this indexer's grabs to one specific client. Empty uses the client default |
| Proxy | By tag (automatic) | Pick a proxy explicitly, or let proxies whose tags match apply |
| Minimum seeders | 0 (torrents) | Ignore torrent releases with fewer seeders |
| Seed ratio, Seed time, Season-pack seed time | empty | Seeding goals sent to the download client for grabs from this indexer |
| Rate limit | empty | Minimum seconds between two requests to this indexer. Use it if a tracker bans you for hammering the API |
| API path (Torznab/Newznab) | `/api` | Path to the API |
| Categories, Anime categories (Torznab/Newznab) | none | Which categories to search. Test the indexer first so the category list loads. Empty searches every category the site maps |
| Additional parameters (Torznab/Newznab) | empty | Extra query string added to every request, such as `&attrs=poster` |
| Site link (definitions) | first mirror | Which mirror of the site to use |

Definition indexers also show the definition's own fields: username and password, API key, passkey, cookie, and so on, depending on the site. An "Untested definition" badge means nobody has verified that definition against the live site yet; it may need small fixes.

### Health, failures and backoff

If an indexer fails repeatedly, Arclight backs off: the row shows "Failed" with the number of recent failures, then "Skipped until" a time, and RSS and searches skip it until then. A successful test or request clears the state. Common causes: wrong API key, site down, Cloudflare challenge, rate limiting or IP ban. See [Nothing found](../TROUBLESHOOTING.md#nothing-found) and [Cloudflare challenge](../TROUBLESHOOTING.md#cloudflare-challenge).

### Built-in definitions and the definition feed

Arclight ships a catalogue of site definitions (YAML files that describe how to search and log in to a site). Three sources exist, shown as badges in the catalogue:

| Source | Meaning |
|---|---|
| Built-in | Shipped with Arclight |
| Feed | Downloaded from the definition feed |
| Custom | Your own YAML file, placed in the `definitions` folder of your config folder. A custom definition overrides the others with the same id |

Press **Reload definitions** in the catalogue after you add a custom file. Settings > Indexer Options has a **Definition feed** panel, which lets definitions be updated without a new Arclight release:

| Setting | Default | What it does |
|---|---|---|
| Feed mode | Automatic | Automatic syncs on the interval and installs changes; Manual syncs only when you press **Sync now** |
| Feed URL | Arclight's own definitions folder on GitHub | Base URL serving `index.json` and the definition files |
| Sync interval | 12 hours | 1 to 168 hours |

Each installed feed definition keeps its previous version, and you can **Roll back** if an update breaks a site. Entries the feed offered but Arclight refused (for example a bad checksum) are listed as Rejected, and the installed version stays in use. Syncing needs internet access to the feed host.

## Indexer Proxies

Settings > Indexer Proxies. A proxy sends an indexer's requests through something else. Add one only if a site is behind Cloudflare or must be reached through a proxy.

| Type | Use it for |
|---|---|
| FlareSolverr | A FlareSolverr container (or the built-in solver) that passes browser challenges |
| HTTP | A normal HTTP proxy |
| SOCKS5 | A SOCKS5 proxy |

| Field | What it does |
|---|---|
| Name, Host, Port | Where the proxy listens. For FlareSolverr the host may include `http://` |
| Username, Password | If the proxy needs them (the password is hidden after saving) |
| Request timeout | Seconds to wait (FlareSolverr), 1 to 600 |
| Tags | The proxy applies to every indexer with a matching tag, unless the indexer picks a proxy explicitly |

Use **Test** to check the proxy. For FlareSolverr, the test solves a real page, so it fails if the solver's browser is broken even when the container is running.

Proxies marked **Managed** were created automatically by proxy detection: "FlareSolverr (bundled)" in Docker and "Built-in solver" on a machine with a browser. They carry the tag `cloudflare`, so tagging an indexer `cloudflare` routes it through them.

## Cloudflare and the challenge solver

Some sites show a "Just a moment..." check that a plain HTTP client cannot pass. Arclight handles it with a solver, using two layers:

- **FlareSolverr** (Docker): the shipped compose files run a FlareSolverr container behind the same VPN as Arclight and register it for you.
- **Built-in solver** (native installs): drives a local Edge, Chrome, Brave or Chromium in the background. The Docker image has no browser, so it applies to native Windows, macOS and Linux installs.

Indexers whose definition says it needs FlareSolverr get the first FlareSolverr proxy automatically. A yellow "Needs a challenge solver. Set up" hint appears on such an indexer if none is configured.

Settings > Challenge Solver (the built-in one):

| Setting | Default | What it does |
|---|---|---|
| Use a local browser to solve challenges | On | Register and serve the built-in solver |
| Browser path | empty (auto) | Leave empty to find Edge, Chrome, Brave or Chromium in that order |
| Timeout | 60 seconds | Give up on a challenge after this long (5 to 300) |
| Close when idle | 300 seconds | Close the browser after this long without work. 0 keeps it open |

The page shows whether a browser was found and whether it is running, and **Detect now** re-runs proxy detection. It solves one request at a time. Interactive challenges (a "verify you are human" checkbox or a CAPTCHA) cannot be solved automatically. Full details, limits and the Windows workaround are in [Cloudflare and other browser challenges](../CLOUDFLARE.md).

## Indexer Options

Settings > Indexer Options, limits that apply to every indexer:

| Setting | Default | What it does |
|---|---|---|
| RSS sync interval | 15 min | How often indexers are polled for new releases. 0 turns RSS sync off; otherwise 10 to 1440 |
| Minimum age (usenet) | 0 min | Releases younger than this are not grabbed. 0 is off |
| Retention (usenet) | 0 days | Releases older than this are ignored. 0 is unlimited |
| Maximum size | 0 MB | Releases larger than this are rejected. 0 is unlimited |
| Allow hardcoded subs | Off | Accept releases with burned-in subtitles |
| Whitelisted subtitle tags | empty | Comma-separated tags (for example `ENG, HC.ENG`) allowed even though hardcoded subs are not. Shown only when Allow hardcoded subs is off |
| Prefer indexer flags | Off | Prefer releases the indexer flags as freeleech, internal and so on |

Per-quality size limits are separate: see [Quality profiles](quality-profiles.md).

## Private trackers: account tracking

Private trackers care about ratio. For a torrent indexer, open it and use the **Tracker account** tab.

| Setting | Default | What it does |
|---|---|---|
| Track this account | Off | Treat the indexer as a private tracker account: ratio, buffer and hit-and-run checks |
| Required ratio | not set | Health warns when your account ratio falls below this |
| Hit-and-run rule: Minimum seed time | not set | The built-in client keeps a finished torrent until it has seeded this many hours or reached the ratio |
| Hit-and-run rule: Minimum ratio | not set | Reaching this ratio also meets the rule (either condition is enough) |
| Freeleech only | Off | Reject releases from this indexer that are not freeleech |
| Track buffer | Off | Buffer = uploaded / required ratio - downloaded |
| Minimum buffer | not set | Warn when the buffer drops below this |
| Announce hosts | empty | One host per line. Used to match torrents in the built-in engine to this tracker. Empty uses the indexer's own site hosts and their subdomains |
| Read account page | On | Read ratio, upload, download, buffer and hit-and-runs from the tracker's account page when the definition has one |

**Indexers > Tracker stats** shows one card per tracked account: ratio with a status (OK, near limit within 10 percent of the requirement, low, or unknown), uploaded and downloaded, buffer, seed time, how many torrents are seeding, hit-and-runs pending, seed bonus and warnings. Press **Sync now** to refresh. Numbers from the built-in engine are labelled "This client"; numbers from the tracker's own account page are labelled "Account page". If the account page cannot be read, you see the error, and the engine numbers still work.

The hit-and-run protection only works for torrents in the built-in engine; see [Download clients](download-clients.md).

## Indexer statistics

**Indexers > Stats** shows queries, grabs and failures per indexer over the last 7, 30 or 90 days, with a daily activity chart, average response time and failure rate. "Queries" counts both searches and RSS fetches. Use it to spot an indexer that never delivers or fails a lot. Stats appear once indexers have been queried.

## Cross-seeding

Cross-seeding finds the same release on your other trackers and seeds it using the file already in your library, with no new download. It helps ratio on private trackers. It needs a torrent indexer or two, and either the built-in engine or qBittorrent as the client.

Settings > Cross-seed:

| Setting | Default | What it does |
|---|---|---|
| Enable cross-seeding | Off | Search on a schedule |
| Indexers | every enabled torrent indexer with automatic search | Which torrent indexers to search |
| Size tolerance | 0.5 % | How far a release size may differ from the file size (0 to 10). Exact matches come first |
| Search on import | Off | Search right after a file is imported |
| Schedule | `0 4 * * *` | Cron expression, server time. Default: daily at 04:00 |
| Search interval | 30 days | The scheduled search skips files searched within this many days |
| Files per run | 50 | Files searched per scheduled run |
| Exclude tags | none | Skip series and movies with any of these tags |
| Download client | first enabled (built-in first) | Built-in engine or qBittorrent |
| Category | `cross-seed` | Client category for cross-seeds. Keep it different from your import category |
| Link folder | empty | Hard links go here when a torrent names the file differently. Empty uses a `cross-seed` folder inside the engine downloads folder |

Cross-seeds are listed under **Activity > Cross-seeds** with their state (Seeding or Failed), indexer, info-hash and save path. Hard links need the link folder on the same volume as the library.

## Related

- [Download clients](download-clients.md)
- [Quality profiles](quality-profiles.md)
- [Interactive search](interactive-search.md)
- [VPN](vpn.md) (indexer traffic goes through the VPN too)
- [Cloudflare and other browser challenges](../CLOUDFLARE.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Indexer definitions spec](../spec/indexer-definitions.md)
