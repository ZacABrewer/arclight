# Site definitions

A *definition* is a YAML file that describes one torrent website: how to log in, how to
turn a search into HTTP requests, and how to turn the response (HTML, XML/RSS or JSON) into
releases. It contains no code. The engine in this directory is Arclight's own
implementation of the Cardigann dialect used by Prowlarr/Jackett catalogues; the normative
description is `docs/spec/indexer-definitions.md` (rule numbers `Sn.m` below refer to it).

```ts
import { createDefinitionIndexer, loadDefinitionCatalogue } from '@arclight/indexers';

const catalogue = await loadDefinitionCatalogue(['/config/indexers']); // bundled + user dir
const indexer = createDefinitionIndexer(catalogue.get('yts')!, {}, { proxy: [{ type: 'flaresolverr', url: 'http://flaresolverr:8191' }] });
const releases = await indexer.search({ kind: 'movie', query: 'The Matrix', year: 1999, categories: [2000] });
const file = await indexer.download(releases[0]!.downloadUrl); // { kind: 'torrent', data } | { kind: 'magnet', magnetUrl }
```

## Files and loading

- `*.yml` / `*.yaml`, UTF-8. The file name (without extension) must equal `id`.
- `builtin/` ships with the package. User directories passed to `loadDefinitionCatalogue`
  override builtin definitions with the same `id`. Broken files are listed in
  `catalogue.errors` (typed `DefinitionError` with a `code` and `path`) and never stop loading.
- `schemaVersion` (alias `schema`) is optional and defaults to `1`. A version newer than the
  engine understands is rejected.
- Structural keys are case-insensitive and ignore `_`/`-` (`allowEmptyInputs` ==
  `allow_empty_inputs`). Keys of user maps (`inputs`, `fields`, `case`, `headers`) are kept
  verbatim.
- A YAML key repeated in one map (two `title:` fields, say) is kept: the second becomes
  `title_2`, which still acts as the `title` field.

## Top level

| key | meaning |
|---|---|
| `id`, `name`, `description`, `language` | identity; `id` is `[a-z0-9._-]+` |
| `type` | `public`, `semi-private` or `private`. Private sites never get magnets built from info hashes |
| `encoding` | response decoding and query percent-encoding (`UTF-8`, `windows-1251`, ...) |
| `links`, `legacylinks` | mirrors (the first is the default); legacy URLs fall back to `links[0]`. See *Mirrors and redirects* |
| `requestDelay` | minimum seconds between requests |
| `followredirect` | follow redirects on the login landing page |
| `testlinktorrent` | download selectors check that a candidate is really a torrent (default true) |
| `timezone` | IANA zone for dates that have no zone (default UTC) |
| `tested` | Arclight marker: `false` until someone confirms it against the live site |
| `requiresFlareSolverr` | Arclight marker: the site is behind Cloudflare. Without a FlareSolverr proxy, `test()` fails at once (`unreachable`, naming FlareSolverr) and a 403/503 is reported the same way |
| `test` | Arclight extension: one search path (same keys as a `search.paths` entry) that `test()` requests instead of the RSS-then-keyword probe; use it for a known-good listing |
| `settings` | user settings (below). Leave it out to get `username` + `password`; use `[]` for none |
| `caps`, `login`, `search`, `download` | see below |

## Mirrors and redirects

- **Link fallback.** When a request to the site link fails with a network error (DNS, refused,
  reset; not a timeout) or an HTTP 5xx, the same path is retried on each other `links` entry in
  order. The first mirror that answers becomes the site link for later requests, and the switch
  is logged (`using link ... (... failed)`). If all fail, the error lists each link and its cause.
  A custom base URL that is not in `links` gets no fallback.
- **Cross-host redirects.** A redirect to another host is followed once per request, even when
  `followredirect` is off, if that host is in `links` or `legacylinks`. Landing on a `links` host
  makes it the site link. A redirect to any other host fails with
  `Redirected to <url>: the site appears to have moved to <host>, ...`. Add the new host to
  `links` if it is a real mirror. Same-host redirects behave as before.

## Settings and templates

Setting types: `text`, `password`, `checkbox`, `select` (with `options`), `multi-select`,
and the help-only `info`, `info_cookie`, `info_flaresolverr`, `info_useragent` and
`info_category_8000`. Each value is available in templates as `.Config.<name>`. A checkbox
gives `"True"` or null; a select gives the option key. `.Config.sitelink` is the base URL in use.

Templates use the form `{{ ... }}`:

- `{{ .Var }}`
- `{{ if X }}..{{ else if Y }}..{{ else }}..{{ end }}`
- `{{ range .Categories }}c{{.}}=1&{{ end }}` and `{{ range $i, $e := .List }}`
- `and`, `or`, `not`, `eq`, `ne`
- `{{ join .Categories "," }}`
- `{{ re_replace .Keywords "\s+" "." }}`

These values count as false: null, a blank string, an empty list. Every other value, `"0"`
included, is true.

Variables:

- **Always:** `.Config.*`, `.Today.Year`, `.True`, `.False`.
- **During a search:** `.Query.*` (`Q`, `Keywords`, `Season`, `Ep`, `Episode`, `IMDBID`,
  `IMDBIDShort`, `TMDBID`, `TVDBID`, `Year`, `Categories`, ...), `.Keywords` (after
  `keywordsfilters`) and `.Categories` (tracker ids).
- **Inside fields:** `.Result.<earlier field>`.
- **During a download:** `.DownloadUri.*`.

Values substituted into a search `path` are percent-encoded (spaces become `%20`). Inputs are
encoded once, when the query string or form body is built.

## Selector blocks

The same shape is used by fields, `selectorinputs`, `error.message`, `rows` and `download.selectors`:

```yaml
selector: "td.name a"        # CSS for HTML/XML; a dotted path for JSON (data.items[0].name, ..parentKey)
attribute: href              # read an attribute instead of the text
text: "{{ .Result.title }}"  # a constant or template instead of a selector
remove: "span.badge"         # delete matching descendants before reading the text
case: {"img[alt=Free]": 0, "*": 1}   # the first matching selector (or JSON literal) wins
optional: true
default: "0"
filters: [{name: replace, args: ["_", " "]}]
```

The HTML engine (`src/html`) supports these selectors:

- type, `#id`, `.class` and attribute selectors (`= ~= |= ^= $= *= !=`, plus the `i` flag)
- the descendant, `>`, `+` and `~` combinators
- `:has()`, `:not()`, `:is()`, `:contains()`, `:icontains()`
- the `:nth-child` and `:nth-of-type` families, `:first-child`, `:last-child`, `:empty`, `:root`
- the jQuery-style `:eq()`, `:lt()`, `:gt()`, `:first` and `:last`

JSON row selectors may end in `:has(path)`, `:not(path)` or `:contains(text)`.

Filters:

- **Query strings:** `querystring`.
- **Regular expressions:** `regexp` (returns capture group 1), `re_replace`.
- **Text edits:** `replace`, `split`, `trim`, `trimprefix`, `trimsuffix`, `prepend`,
  `append`, `tolower`, `toupper`.
- **Encoding:** `urlencode`, `urldecode`, `htmlencode`, `htmldecode`, `base64encode`,
  `base64decode`.
- **Dates:** `dateparse`/`timeparse` (Go layouts such as `2006-01-02 15:04:05`),
  `timeago`/`reltime`, `fuzzytime` (`UK` = day-first). Date filters output ISO-8601 UTC.
- **Cleanup:** `validfilename`, `diacritics`, `jsonjoinarray`, `validate`.
- **Debugging:** `hexdump`, `strdump`.

## caps

`categorymappings` maps each site category id to a standard name from Appendix A of the spec
(`Movies/HD`, `TV/Anime`, ...):

- An entry with a `desc` also creates a custom category: `100000 + id`, or a stable hash for an
  id that is not a number.
- `default: true` entries are searched when the requested categories map to nothing.
- `modes` lists the parameters each search type supports. `search: [q]` is required; the others
  are `tv-search`, `movie-search`, `music-search` and `book-search`.

## login

`method` is one of the following (the default is `form`):

- **`form`** loads `path`, finds `form` (default `form`) and submits every enabled `input` in it
  (checked checkboxes only). Values from `inputs`, `selectorinputs` (scraped from the page) and
  `getselectorinputs` (added to the submit URL) override or add fields. The submit goes to
  `submitpath` or the form's `action`. Cookies set during the redirect chain are kept.
- **`post`** and **`get`** send `inputs` to `path` directly.
- **`cookie`** loads the `cookie` setting (`a=1; b=2`) into the cookie jar.
- **`oneurl`** opens `path` with the `oneurl` input appended to it.

After the login request:

- If an `error` block's selector matches, login fails with that block's message.
- If `test.path` and `test.selector` are set, the engine loads `test.path` and requires the selector
  to match.
- Login runs only when needed. If a later search is redirected, gets an HTTP error, or loses the
  `test.selector` match, the engine logs in again once and retries the search.

## search, rows and fields

```yaml
search:
  paths:                     # each path is requested; results are merged
    - path: "browse.php"
      method: get            # or post
      categories: [1, 2]     # only when these tracker categories are requested ("!" first negates)
      response: {type: html} # html | xml | json (+ noResultsMessage)
  inputs: {q: "{{ .Keywords }}", $raw: "{{ range .Categories }}c{{.}}=1&{{end}}"}
  keywordsfilters: [...]
  rows:
    selector: "table#torrents > tbody > tr"
    after: 1                 # merge the next N rows into this one (two <tr> per release)
    dateheaders: {...}       # date taken from a preceding header row
    attribute: torrents      # JSON: descend into this key ...
    multiple: true           # ... and treat each element as a row
    count: {selector: total} # JSON: zero means no results
    filters: [{name: andmatch}]   # keep only titles that match the keywords
  fields: {...}
```

Fields that set release values:

- `title`, `description`
- `category`, `categorydesc`
- `details`, `comments`, `download`, `magnet`, `infohash`
- `size` (KB/MB/GB/TB in binary units, so `1.5 GiB` works)
- `date`, which accepts any format `fuzzytime` understands
- `seeders`, `leechers`, `grabs`, `files`
- `downloadvolumefactor`, `uploadvolumefactor`, `minimumratio`, `minimumseedtime` (seconds)
- `imdbid`, `tmdbid`, `tvdbid`
- `poster`, `genre`, `year`

Requiredness:

- These fields are optional without being marked: `imdb*`, `tmdbid`, `tvdbid`, `poster`,
  `description` and `genre`.
- Any other field can be made optional with `optional: true` or a `|optional` suffix on its key.
- If a required field fails, that row is skipped.

Any other key (`id`, `quality`, ...) is a scratch value you can reuse as `.Result.<key>`. Relative
URLs are resolved against the URL that was requested. Public sites get a magnet built from the
info hash. A non-interactive search drops releases that have no size, no categories or no link.

## download

When a release link points to a details page, a `download` block extracts the real file:

- `before` makes a preliminary request; its `pathselector` can scrape that request's path from a
  page.
- `selectors` are tried in order. A magnet link is returned as it is. Any other link is downloaded
  and must start like a bencoded torrent.
- `infohash` (`hash` and `title`) builds a magnet from the page.

`download()` returns `{ kind: 'torrent', data }` or `{ kind: 'magnet', magnetUrl }`.

## Not supported

- Captchas: a `login.captcha` block produces a load warning, and login fails if the page actually
  shows a captcha.
- The `simpleCaptcha` helper.
- Pagination beyond one page per path.
- `certificates` and `ratio` are parsed and ignored.

## Full example

```yaml
schemaVersion: 1
id: examplesite
name: ExampleSite
description: "Example private tracker"
language: en-US
type: private
encoding: UTF-8
tested: false
requestDelay: 2
links:
  - https://examplesite.example/
settings:
  - {name: username, type: text, label: Username}
  - {name: password, type: password, label: Password}
  - {name: freeleech, type: checkbox, label: Freeleech only, default: false}
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies HD"}
    - {id: 2, cat: TV/HD, desc: "TV HD"}
    - {id: 3, cat: TV/Anime, desc: "Anime"}
  modes:
    search: [q]
    tv-search: [q, season, ep, imdbid]
    movie-search: [q, imdbid]
login:
  method: form
  path: login.php
  form: "form#loginform"
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  selectorinputs:
    csrf_token: {selector: "input[name=csrf_token]", attribute: value}
  error:
    - selector: "div.alert-danger"
  test:
    path: index.php
    selector: "a[href*='logout']"
search:
  paths:
    - path: browse.php
  inputs:
    $raw: "{{ range .Categories }}cat[]={{.}}&{{end}}"
    search: "{{ if .Query.IMDBID }}{{ .Query.IMDBID }}{{ else }}{{ .Keywords }}{{ end }}"
    freeleech: "{{ if .Config.freeleech }}1{{ end }}"
  keywordsfilters:
    - {name: re_replace, args: ["[^\\w\\s]+", " "]}
  rows:
    selector: "table#torrents > tbody > tr:has(a.dl)"
  fields:
    category:
      selector: "a[href*='cat=']"
      attribute: href
      filters: [{name: querystring, args: cat}]
    title:
      selector: "td.name a"
      remove: "span.tag"
    details:
      selector: "td.name a"
      attribute: href
    download:
      selector: "a.dl"
      attribute: href
    imdbid:
      selector: "a[href*='imdb.com/title/tt']"
      attribute: href
    size:
      selector: "td.size"
    seeders:
      selector: "td.seeders"
    leechers:
      selector: "td.leechers"
    grabs:
      selector: "td.snatched"
      optional: true
      default: "0"
    date:
      selector: "td.added span"
      attribute: title
      filters: [{name: dateparse, args: "2006-01-02 15:04:05"}]
    downloadvolumefactor:
      case: {"img[alt='Freeleech']": 0, "img[alt='Half']": 0.5, "*": 1}
    uploadvolumefactor:
      text: 1
    minimumratio:
      text: 1.0
    minimumseedtime:
      text: 172800
```
