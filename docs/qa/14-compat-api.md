# Compatibility API (Sonarr/Radarr v3)

This checklist covers the Sonarr/Radarr-shaped API at `/api/v3` that lets Overseerr, Jellyseerr, Prowlarr, nzb360, LunaSea, Recyclarr and Notifiarr talk to Arclight, plus the public probes and the on/off switch.
Prerequisites: Arclight running with at least one series, one movie and one root folder; your API key from Settings -> Security -> "API key" (click Show, then Copy); `curl` available.
Test environments: Native (http://localhost:17878), Docker (http://<host>:7878) and NAS. In the commands below replace `BASE` with your address and `KEY` with your API key.
The compat settings have no screen; they are changed via API with `/api/v1/settings/compat`.

## Switch, probes and headers

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-01 | Run `curl -s BASE/api/v1/settings/compat -H "X-Api-Key: KEY"` (via API). | JSON with `enabled` true, `instanceName` "Arclight" and `advertisedVersion` "4.0.4.0" (defaults). | |
| CMP-02 | Run `curl -s BASE/api` (no key). | `{"current":"v3","deprecated":[]}` | |
| CMP-03 | Run `curl -s BASE/ping` (no key). | `{"status":"OK"}` | |
| CMP-04 | Run `curl -s BASE/initialize.json` (no key). | JSON containing `apiRoot` "/api/v3", `apiVersion` "v3", `appName` "Arclight", `instanceName`, `version`, `branch` and `urlBase`. Your API key does NOT appear in it. | |
| CMP-05 | Run `curl -s BASE/initialize.js` (no key). | JavaScript text starting `window.Sonarr = {` and ending with `window.Radarr = window.Sonarr;`. No API key inside. | |
| CMP-06 | Run `curl -si BASE/api/v3/system/status -H "X-Api-Key: KEY"` and read the headers. | HTTP 200 and a header `X-Application-Version`. Body shows `appName` "Arclight", `instanceName`, `version`, `isDocker` and `osName`. | |
| CMP-07 | Run `curl -s -o /dev/null -w "%{http_code}" BASE/api/v3/system/status` (no key). | `401`. | |
| CMP-08 | Run the same with `?apikey=KEY` added to the URL: `curl -s -o /dev/null -w "%{http_code}" "BASE/api/v3/system/status?apikey=KEY"`. | `200`. | |
| CMP-09 | Run `curl -s -o /dev/null -w "%{http_code}" BASE/api/v3/system/status -H "X-Api-Key: wrongkey"`. | `401`. | |

## Reading data

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-10 | Run `curl -s BASE/api/v3/series -H "X-Api-Key: KEY"`. | JSON array. Each item has `title`, `id`, `tvdbId`, `monitored`, `path`, `seasons` and `statistics`. Count matches Library -> TV. | |
| CMP-11 | Run `curl -s BASE/api/v3/series/1 -H "X-Api-Key: KEY"` (use a real id from CMP-10). | One series object. An id that does not exist returns 404 with `{"message":...}`. | |
| CMP-12 | Run `curl -s "BASE/api/v3/series/lookup?term=severance" -H "X-Api-Key: KEY"`. | Array of lookup results with titles and years. `tvdbId` can be 0 when only TMDB data is known. | |
| CMP-13 | Run `curl -s BASE/api/v3/movie -H "X-Api-Key: KEY"`. | JSON array. Each item has `title`, `tmdbId`, `monitored`, `path`, `hasFile`, `minimumAvailability`. Count matches Library -> Movies. | |
| CMP-14 | Run `curl -s "BASE/api/v3/movie/lookup/tmdb?tmdbId=438631" -H "X-Api-Key: KEY"`. | One movie result (Dune, 2021) or a clear not-found message. | |
| CMP-15 | Run `curl -s "BASE/api/v3/episode?seriesId=1" -H "X-Api-Key: KEY"`. | Array of episodes with `seasonNumber`, `episodeNumber`, `monitored`, `hasFile`. | |
| CMP-16 | Run `curl -s BASE/api/v3/queue -H "X-Api-Key: KEY"` while a download is active. | Paged object with `page`, `pageSize`, `totalRecords` and `records`. Each record has `title`, `status`, `size`, `sizeleft`, `protocol`, `downloadClient`. A multi-episode download shows one record per episode. | |
| CMP-17 | Run `curl -s BASE/api/v3/queue/status -H "X-Api-Key: KEY"`. | JSON with `totalCount`, `errors`, `warnings` that agree with the Queue page subtitle. | |
| CMP-18 | Run `curl -s BASE/api/v3/rootfolder -H "X-Api-Key: KEY"`. | Array listing every root folder (TV and movie), each with a `mediaType` field. | |
| CMP-19 | Run `curl -s BASE/api/v3/qualityprofile -H "X-Api-Key: KEY"`, then `.../tag`, `.../languageprofile`. | Profiles match Settings -> Profiles. `languageprofile` shows one profile named "Any". | |
| CMP-20 | Run `curl -s BASE/api/v3/health -H "X-Api-Key: KEY"` and `.../diskspace`. | Health entries match System -> Health. Diskspace lists the drives. | |
| CMP-21 | Run `curl -s BASE/api/v3/system/backup -H "X-Api-Key: KEY"` and `.../update`. | Both return `[]` (expected: not supported). | |

## Commands and indexers

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-22 | Run `curl -s -X POST BASE/api/v3/command -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"name\":\"SeriesSearch\",\"seriesId\":1}"`. | JSON with an `id`, `name` "SeriesSearch" and a state such as "queued" or "started". Activity or System -> Tasks shows the search. | |
| CMP-23 | Run `curl -s BASE/api/v3/command/ID -H "X-Api-Key: KEY"` using the id from CMP-22. | The command with state "completed" after a short time. | |
| CMP-24 | Run `curl -s -X POST BASE/api/v3/command -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"name\":\"MoviesSearch\",\"movieIds\":[1]}"`. | A command is created and the movie is searched. | |
| CMP-25 | Run the same POST with `{"name":"RssSync"}`, then with `{"name":"RefreshSeries"}`. | Both accepted, each returns an id. | |
| CMP-26 | Run the same POST with `{"name":"NoSuchCommand"}`. | HTTP 400 (unknown command names are refused). | |
| CMP-27 | Run `curl -s BASE/api/v3/indexer -H "X-Api-Key: KEY"`. | Array that matches Settings -> Indexers. | |
| CMP-28 | Run `curl -s -X POST BASE/api/v3/indexer -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"name\":\"Compat test\",\"implementation\":\"Torznab\",\"enableRss\":true,\"enableAutomaticSearch\":true,\"enableInteractiveSearch\":true,\"fields\":[{\"name\":\"baseUrl\",\"value\":\"http://localhost:9117/api/v2.0/indexers/test/results/torznab/\"},{\"name\":\"apiKey\",\"value\":\"abc\"}]}"`. | HTTP 201 and the new indexer appears in Settings -> Indexers (as a Torznab indexer). Delete it afterwards. | |
| CMP-29 | Repeat CMP-28 with `"implementation":"Cardigann"`. | HTTP 400 mentioning that only Torznab and Newznab are supported. Nothing is created. | |
| CMP-30 | Repeat CMP-28 with an empty `baseUrl` value. | HTTP 400 with the message "'Base Url' must not be empty." | |

## Apps that use the API

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-31 | Overseerr or Jellyseerr: Settings -> Services -> add Sonarr. Hostname = Arclight host, Port = 7878 (Docker/NAS) or 17878 (Native), tick nothing for SSL, API key = KEY, URL base empty. Click "Test". | Test succeeds and lists Arclight's quality profiles and root folders. Add Radarr the same way. | |
| CMP-32 | In Overseerr/Jellyseerr request a series that is not in Arclight. | Series appears in Arclight under Library -> TV and a search starts (if requested to search). | |
| CMP-33 | Request a movie in Overseerr/Jellyseerr. | Movie appears in Library -> Movies. | |
| CMP-34 | Prowlarr: Settings -> Apps -> add Sonarr. Prowlarr server = Prowlarr's own URL, Sonarr server = Arclight URL, API key = KEY. Click "Test", then "Save". | Test succeeds. | |
| CMP-35 | In Prowlarr click "Sync App Indexers". | Prowlarr's indexers (Torznab/Newznab) appear in Arclight's Settings -> Indexers. Run it twice; no duplicates appear. | |
| CMP-36 | nzb360 or LunaSea: add a Sonarr/Radarr instance with host `http://<host>:7878`, API key = KEY. | Connection test passes; series, movies, calendar and queue load. | |
| CMP-37 | Recyclarr: put Arclight URL and KEY in `recyclarr.yml` as a Sonarr instance and run `recyclarr sync`. | Reads succeed. Custom format and delay profile writes are refused (read-only in compat); see Known gaps. | |
| CMP-38 | Notifiarr: add a Sonarr/Radarr instance with Arclight URL and KEY. | Instance is accepted and shows status and queue. | |

## Known gaps (expected behaviour)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-39 | Run `curl -s -o /dev/null -w "%{http_code}" BASE/signalr/messages/negotiate -H "X-Api-Key: KEY"`. | Not supported: 404. Apps fall back to polling. This is expected. | |
| CMP-40 | Run `curl -s -X POST BASE/api/v3/customformat -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"name\":\"x\"}"`. | Rejected (custom formats, delay profiles, release profiles, download clients, notifications, import lists and config/* are read-only through compat). Expected, not a defect. | |

## Disabling the API

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CMP-41 | Disable: run `curl -s -X PUT BASE/api/v1/settings/compat -H "X-Api-Key: KEY" -H "Content-Type: application/json" -d "{\"enabled\":false,\"instanceName\":\"Arclight\",\"advertisedVersion\":\"4.0.4.0\"}"`. | JSON echoing `enabled` false. | |
| CMP-42 | Run `curl -s -i BASE/api/v3/system/status -H "X-Api-Key: KEY"`, then CMP-02 to CMP-05. | Every one returns HTTP 404 with `{"message":"NotFound"}`, even with a valid key. The native web app at BASE keeps working. | |
| CMP-43 | Re-enable with the same PUT but `"enabled":true`, then repeat CMP-02 and CMP-06. | Probes and status answer again. | |
| CMP-44 | Set `advertisedVersion` to `"abc"` with the PUT. | HTTP 400 (must look like 4.0.4.0). Setting it to `"4.0.4.0"` again succeeds. | |
| CMP-45 | Set `instanceName` to "Arclight QA" with the PUT, then run CMP-04. | `instanceName` in initialize.json and in /system/status shows "Arclight QA". Put it back to "Arclight" afterwards. | |
