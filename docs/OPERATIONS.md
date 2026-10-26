# Operations

> Part of the [documentation](README.md). Day-to-day System pages (Status, Tasks, Logs, Health) are in
> [System](using/system.md); backups are in [Backup and restore](getting-started/backup-restore.md).

Running Arclight as infrastructure: configuration as code, environment overrides, Prometheus
metrics and the audit log. Route details are in [API.md](API.md); contracts in
`packages/shared/src/operations.ts`.

## Configuration as code

One YAML (or JSON) document describes the whole configuration: every settings section plus
the resources you would otherwise click together. Resources are keyed by **stable names**,
never database ids, so the same file works on any install.

| Collection | Key | References it may make (by name) |
|---|---|---|
| `settings.<section>` | section name (`metadata`, `mediaManagement`, `naming`, `releases`, `vpn`, `security`, `importLists`, `subtitles`, `compat`, `backup`, `torrent`, `indexers`, `requests`, `mediaServer`, `solver`, `guides`, `metrics`, `audit`, ...) | quality profiles, language profiles and tags inside `requests`, `importLists`, `subtitles`, `guides` |
| `tags` | list of labels | |
| `customFormats` | name | |
| `qualityProfiles` | name | custom formats (`formatItems[].format`) |
| `delayProfiles` | tag set (`default` for the untagged profile, else labels joined with `, `) | tags |
| `releaseProfiles` | name | indexer, tags |
| `downloadClients` | name | tags |
| `indexerProxies` | name | tags |
| `indexers` | name | download client, proxy, tags |
| `remotePathMappings` | `host:remotePath` (taken from the entry, the key is only a label) | |
| `rootFolders` | path | |
| `notifications` | name | tags |
| `importLists` | name | quality profile, tags |
| `languageProfiles` | name | |

Tags referenced anywhere are created when missing. Quality ids inside quality profiles
(`cutoff`, `items[].qualityId`) are the fixed vocabulary from `packages/shared/src/quality.ts`,
which is the same on every install.

### Export

```
GET /api/v1/config/export                    # YAML, secrets masked
GET /api/v1/config/export?format=json
GET /api/v1/config/export?includeSecrets=true   # admin + header  X-Confirm: export-secrets
```

Secrets (any key named like `password`, `apiKey`, `token`, `secret`, `cookie`, `privateKey`,
`webhookUrl`, `passkey`, ...) are exported as `********`. Importing `********` keeps whatever
is stored for that field, so a masked export can be edited and imported back safely. A mask
with nothing stored behind it (a fresh install) is dropped with a warning. Install state
(`security.setupComplete`, `security.setupCompletedAt`) is never exported.

### Import, dry run, validate

```
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/yaml" \
     --data-binary @arclight.yml "http://arclight:7878/api/v1/config/import?dryRun=true"
```

or JSON: `POST /api/v1/config/import` with `{"content": "<yaml text>", "dryRun": true}` or
`{"document": {...}}`. The result lists every change (`create` / `update` / `delete`, with the
changed fields for updates; secret values masked) plus errors and warnings.

- **Upsert by name.** An entry whose key exists is updated, otherwise created.
- **Settings merge.** Only the keys a section lists change; the rest of the section stays.
  Nested objects given at the top level of a section are replaced whole.
- **Never deletes** unless `prune: true` (in the document, or the `prune` flag on the request,
  which wins). Pruning only touches collections the document contains: a file without
  `indexers:` never removes an indexer. Pruning something a kept entry still references is an
  error.
- **All or nothing.** The whole document is checked first (structure, references, settings
  validation); any error means nothing is written (HTTP 422 on apply). Writes run in one
  transaction.
- Download client and notification settings are also checked against their implementation;
  mismatches are warnings (the client fails at runtime until fixed), a wrong `protocol` for a
  download client implementation is an error.

`POST /api/v1/config/validate` takes the same body and only reports.

### Managed mode: `ARCLIGHT_CONFIG_FILE`

Set `ARCLIGHT_CONFIG_FILE=/config/arclight.yml`. At every start, if the file exists, it is
applied with the same importer before any engine or job starts. Rules:

- **The file wins over the UI for the keys it defines.** Settings keys and resources it lists
  are rewritten from the file on each start. Keys and resources it does not mention stay
  editable in the UI as usual.
- When a module reports a settings change at runtime (the `settings` event: media management,
  naming, requests, torrent, compat, metrics, audit, ...) managed keys of that section are put
  back immediately.
- `GET /api/v1/config/managed-keys` lists what is managed (`settings: {section: [keys]}`,
  `resources: {kind: [keys]}`) so the UI can show a "managed by config file" lock.
- `prune: true` in the file makes it authoritative for the collections it contains.
- A file that does not parse or validate is not applied at all; Arclight still starts, logs
  the errors and reports them in `managed-keys.errors`.

Keep a managed file small: list only what you want pinned. An export lists every key of every
section, which would lock the whole UI.

### Environment overrides: `ARCLIGHT_SETTING__<section>__<key>`

Scalar settings can be set per variable, applied after the config file (precedence, lowest
first: **database/UI < config file < environment**):

```
ARCLIGHT_SETTING__metadata__region=GB
ARCLIGHT_SETTING__audit__retentionDays=30
ARCLIGHT_SETTING__metrics__allowAnonymous=true
ARCLIGHT_SETTING__vpn__provider__type=gluetun      # nested keys: one more __ per level
```

Section and key names match case-insensitively. The value is converted to the type of the
setting it replaces (`true/false/1/0/yes/no/on/off` for booleans, numbers for numbers, text
for strings; JSON for anything else). An override that fails validation is skipped and
reported in `managed-keys.errors`. Overridden keys count as managed.

### Full example

```yaml
version: 1
# prune: true            # uncomment to make this file authoritative for the collections below

settings:
  metadata:
    tmdbApiKey: "0123456789abcdef0123456789abcdef"
    language: en-US
    region: US
  mediaManagement:
    useHardlinks: true
    recycleBinPath: /data/recycle
    recycleBinCleanupDays: 14
  naming:
    renameEpisodes: true
    renameMovies: true
  releases:
    minimumAgeMinutes: 0
    retentionDays: 0
  metrics:
    allowAnonymous: false
  audit:
    enabled: true
    retentionDays: 180

tags:
  - 4k
  - anime

customFormats:
  x265:
    includeWhenRenaming: false
    specifications:
      - implementation: releaseTitle
        name: x265
        fields:
          pattern: "\\b(x265|hevc)\\b"

qualityProfiles:
  HD-1080p:
    upgradeAllowed: true
    cutoff: 7                      # Bluray-1080p
    items:
      - { kind: quality, qualityId: 9, allowed: true }    # HDTV-1080p
      - { kind: quality, qualityId: 3, allowed: true }    # WEBDL-1080p
      - { kind: quality, qualityId: 16, allowed: true }   # WEBRip-1080p
      - { kind: quality, qualityId: 7, allowed: true }    # Bluray-1080p
    formatItems:
      - { format: x265, score: 100 }
    languages: [en]

delayProfiles:
  default:
    order: 2147483647
    preferredProtocol: torrent
    usenetDelayMinutes: 0
    torrentDelayMinutes: 0
  anime:
    order: 1
    tags: [anime]
    torrentDelayMinutes: 60

releaseProfiles:
  No CAM:
    ignored: [CAM, TELESYNC]

downloadClients:
  # Optional external client (needs `docker compose --profile qbittorrent up -d`). The built-in
  # engine registers itself on first start and does not need an entry here.
  qBittorrent:
    implementation: qbittorrent
    protocol: torrent
    priority: 1
    settings:
      host: qbittorrent
      port: 8080
      useSsl: false
      username: admin
      password: "change-me"
      category: arclight

indexerProxies:
  FlareSolverr:
    type: flaresolverr
    host: flaresolverr
    port: 8191

indexers:
  NZBgeek:
    implementation: newznab
    priority: 10
    settings:
      baseUrl: https://api.nzbgeek.info
      apiPath: /api
      apiKey: "your-nzbgeek-key"
      categories: [5030, 5040, 2040, 2045]
      animeCategories: [5070]
  Torznab via proxy:
    implementation: torznab
    downloadClient: qBittorrent
    proxy: FlareSolverr
    tags: [anime]
    settings:
      baseUrl: http://jackett:9117/api/v2.0/indexers/nyaa/results/torznab
      apiPath: /api
      apiKey: "your-jackett-key"
      categories: [5070]
      animeCategories: [5070]

remotePathMappings:
  qbittorrent downloads:
    host: qbittorrent
    remotePath: /downloads/
    localPath: /data/downloads/

rootFolders:
  /data/tv:
    mediaType: series
  /data/movies:
    mediaType: movie

notifications:
  Discord:
    implementation: discord
    onGrab: true
    onDownload: true
    onUpgrade: true
    onHealthIssue: true
    settings:
      webhookUrl: "https://discord.com/api/webhooks/000/your-token"

importLists:
  TMDB Popular:
    implementation: tmdbPopular
    enabled: true
    enableAutomaticAdd: false
    rootFolderPath: /data/movies
    qualityProfile: HD-1080p
    mediaType: movie
    minimumAvailability: released

languageProfiles:
  English:
    languages:
      - { code: en, forced: never, hi: also }
    cutoff: en
```

(`docs/OPERATIONS.md` is checked by `config-export/docs.test.ts`: this example must import
cleanly into an empty database.)

## Metrics

`GET /metrics` at the server root (not under `/api/v1`) serves the Prometheus text format.
It takes the API's credentials (`X-Api-Key` header, `?apikey=`, Basic auth or a session
cookie); set `metrics.allowAnonymous` (Settings, `PUT /api/v1/settings/metrics`, the config
file or `ARCLIGHT_SETTING__metrics__allowAnonymous=true`) to scrape without one.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: arclight
    metrics_path: /metrics
    params:
      apikey: ["<your api key>"]
    static_configs:
      - targets: ["arclight:7878"]
```

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `arclight_info` | gauge | `version`, `node` | Always 1 |
| `process_cpu_seconds_total`, `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | | CPU time |
| `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_heap_size_total_bytes`, `nodejs_external_memory_bytes` | gauge | | Memory |
| `nodejs_eventloop_lag_p99_seconds` | gauge | | Event loop delay p99 since the previous scrape |
| `process_uptime_seconds`, `process_start_time_seconds` | gauge | | Uptime |
| `arclight_http_requests_total` | counter | `method`, `route`, `status` | Requests; `route` is the matched pattern (`/api/v1/series/:id`), `(unmatched)` for 404s |
| `arclight_http_request_duration_seconds` | histogram | `method`, `route` | Request duration |
| `arclight_job_runs_total` | counter | `job`, `status` | Finished job runs (`completed`, `failed`, `cancelled`) |
| `arclight_job_failures_total` | counter | `job` | Failed runs |
| `arclight_job_duration_seconds` | histogram | `job` | Run duration |
| `arclight_jobs_running` | gauge | `job` | Running now |
| `arclight_releases_grabbed_total` | counter | | Grabs since start |
| `arclight_imports_total` | counter | `result` | Import outcomes since start |
| `arclight_queue_items` | gauge | `state` | Tracked downloads by state |
| `arclight_library_series`, `arclight_library_files`, `arclight_library_size_bytes` | gauge | | Library size |
| `arclight_library_movies` | gauge | `has_file` | Movies |
| `arclight_library_episodes` | gauge | `monitored`, `has_file` | Episodes (missing = `monitored="true",has_file="false"`) |
| `arclight_indexer_queries_24h`, `arclight_indexer_rss_24h`, `arclight_indexer_grabs_24h` | gauge | `indexer`, `result` | Rolling 24 h counts from the indexer stats table |
| `arclight_indexer_failures_24h` | gauge | `indexer` | Failed requests of any kind, 24 h |
| `arclight_indexer_response_seconds_avg_24h` | gauge | `indexer` | Average response time, 24 h |
| `arclight_indexer_disabled` | gauge | `indexer` | 1 while backed off after failures |
| `arclight_torrent_engine_up`, `arclight_torrent_download_rate_bytes`, `arclight_torrent_upload_rate_bytes`, `arclight_torrent_peers` | gauge | | Built-in torrent engine |
| `arclight_download_client_up` | gauge | `client` | Last queue refresh reached the client |
| `arclight_download_client_rate_bytes` | gauge | `client` | **Estimated** download rate: queue progress between two scrapes |
| `arclight_download_client_remaining_bytes` | gauge | `client` | Bytes left in the queue |
| `arclight_vpn_enabled`, `arclight_vpn_connected` | gauge | | VPN state |
| `arclight_subtitles_wanted` | gauge | | Wanted subtitles (recomputed at most every 5 minutes) |
| `arclight_requests` | gauge | `status` | Media requests by status |
| `arclight_requests_pending` | gauge | | Requests waiting for approval |
| `arclight_metrics_collector_errors_total` | counter | `collector` | A collector threw during a scrape (the rest of the scrape still answers) |

Counters that come from bus events (`job_*`, `releases_grabbed`, `imports`) start at zero on
every restart; use `increase()`/`rate()`. The `*_24h` indexer gauges are read from the
database on each scrape.

A ready-made dashboard is in [grafana-dashboard.json](grafana-dashboard.json) (Dashboards ->
Import; pick your Prometheus data source).

## Audit log

Table `audit_events`: `time`, `user_id`, `username`, `ip`, `action`, `target`, `method`,
`route`, `status_code`, `details` (JSON).

- **Automatic.** Every `POST`/`PUT`/`PATCH`/`DELETE` on `/api/v1` that matched a route is
  recorded when the response is sent, including refused ones (the status code is stored). The
  action is derived from the route pattern: `POST /series` -> `series.create`,
  `DELETE /series/:id` -> `series.delete` (target `42`), `POST /request/:id/approve` ->
  `request.approve`, any settings page -> `settings.update` (target = section), plus a few
  fixed names (`logout`, `command.run`, `config.import`, `apikey.regenerate`).
- **Service events.** `login.success` and `login.failed` (with the attempted username and the
  address) come from the auth service. Other modules can record their own:
  `audit(ctx).record({ action: 'thing.happened', target, details })` (a no-op when auditing is
  not installed).
- **Not recorded:** reads, connection tests (`.../test`, `.../testall`), Plex PIN polling,
  `/config/validate`, `/vpn/refresh`, update checks, and any route declared with
  `config: { audit: false }`.
- **Details** hold the duration, the query string (without `apikey`) and the request body
  with secrets masked; bodies over 4 KB are reduced to their keys.
- API-key, Basic-without-user and local-bypass callers are stored as `(apikey)`, `(basic)`,
  `(bypass)`.
- **Retention:** `audit.retentionDays` (default 90; 0 keeps everything), enforced daily at
  03:17 by the `AuditCleanup` job. `audit.enabled: false` stops recording.

Browse with `GET /api/v1/audit?page=1&pageSize=50&user=bob&action=settings&from=2026-01-01&to=2026-02-01`
(`action` matches exactly or as a prefix), export the same filter as CSV with
`GET /api/v1/audit/export?...`. Both are admin only. CSV cells that a spreadsheet would treat
as formulas are prefixed with `'`.
