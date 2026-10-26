# Spec: YAML indexer definitions, proxies, limits, backoff, stats (Phase 2)

Status: draft 1. Derived from reading Prowlarr (`NzbDrone.Core/Indexers/Definitions/Cardigann`,
`IndexerProxies`, `IndexerStats`, `ThingiProvider/Status`, `Applications`, `Indexers/*`). Clean room:
this document describes behaviour in our own words; all snippets are written for this spec.
The upstream checkout contains no definition `.yml` files (the catalogue lives in a separate
repository fetched at runtime) and only one Cardigann test fixture (template expansion), so the
examples here are authored, and fixtures to build are listed in the Appendices.

Audience: a TypeScript engineer implementing `packages/indexers` (definition engine) and
`apps/api/src/modules/indexers` (registry, proxies, limits, stats) without reading upstream.

Conventions: "MUST/SHOULD/MAY" are normative. Rules are numbered `Sn.m` (section n, rule m) so
code comments and tests can cite them. "Upstream" = Prowlarr behaviour. "MT" = a deliberate
Media-Tron decision that differs from or extends upstream; every MT item is listed again in
section 20 (Open questions) if it is a judgement call.

Compatibility goal: a definition written for the Cardigann ecosystem (same YAML dialect that
Prowlarr and Jackett catalogues use) SHOULD load and behave the same. MT extensions are
additive and optional (marked `[MT]`).

---

## 1. Big picture

1. A *definition* is a YAML file describing one website: how to log in, how to turn a search
   (keywords, categories, IDs) into HTTP requests, and how to turn each response page/JSON/XML
   into a list of releases. It contains no code; all dynamic behaviour is expressed through
   templates (section 4), selectors (section 5) and filters (section 6).
2. An *indexer instance* = definition id + user settings (credentials, cookie, base URL choice,
   toggles) + operational config (priority, tags, limits, proxy tags, enabled flags). Many
   instances may use the same definition.
3. The engine is a pure library (`packages/indexers/src/cardigann/*`). It receives an HTTP
   transport interface (so proxies, cookies, rate limiting are injected), a clock, and returns
   typed `Release[]`. It never touches the database.
4. Pipeline per search: build query variables -> pick search paths -> expand templates -> issue
   requests (login first if needed) -> parse each response with rows+fields -> post-process
   (magnet/hash, flags, dedupe, drop invalid) -> return to the registry which applies category
   filtering, age/size filters, limits, stats and failure bookkeeping.
5. Pipeline per grab: release `download` link -> optional download block (pre-fetch page,
   extract real link) -> fetch bytes -> validate it is a torrent -> hand to download client.
6. All definition processing MUST be deterministic given (definition, settings, query,
   response bytes, clock). That is what makes fixture-driven tests possible.

---

## 2. Definition file: top-level keys

Files are UTF-8 YAML, extension `.yml`. File name without extension is the *file key*; `id`
inside the file SHOULD equal it (upstream identifies instances by file key; we use `id`, and
load fails if they differ).

```yaml
id: examplesite                 # required, [a-z0-9-]+, stable forever
name: ExampleSite               # required, display name
description: "Example private tracker for TV and movies"
language: en-US                 # BCP-47-ish; informational
type: private                   # public | semi-private | private
encoding: UTF-8                 # optional, default UTF-8
followredirect: false           # optional, default false
requestDelay: 2                 # optional, seconds (float)
testlinktorrent: true           # optional, default true (see S11)
links:                          # required, >=1; first is the default site URL
  - https://examplesite.example/
legacylinks:                    # optional, old URLs migrated to links[0]
  - https://old.examplesite.example/
certificates: []                # optional; see S2.9
settings: [...]                 # S3
caps: {...}                     # S7
login: {...}                    # S8, optional (public sites omit)
ratio: {...}                    # optional, see S2.10
search: {...}                   # S9, required
download: {...}                 # S11, optional
```

Rules:

S2.1  Key matching: top-level and nested keys are matched case-insensitively after removing
      `_` and `-` (`allowEmptyInputs`, `allowemptyinputs`, `allow_empty_inputs` are the same).
      Unknown keys are ignored but reported as warnings by the loader (never silently
      swallowed in `validate`). Upstream ignores unknown keys.
S2.2  `id`, `name`, `links`, `caps`, `search` are required. Missing any -> definition is rejected
      with a typed `DefinitionError{code:'missing_key', path}`; the registry lists it as
      "broken" rather than crashing startup.
S2.3  `type`: `public` = no account needed; `semi-private` = registration optional/limited;
      `private` = account required. Any other value is treated as `semi-private` (upstream).
      Effects: (a) magnets MUST NOT be synthesised from an info hash for `private` (the tracker
      passkey is part of the .torrent announce URL; a hash-only magnet would leak into DHT and
      bypass the tracker); (b) UI privacy badge; (c) default seeding-rule warnings.
S2.4  `encoding`: any label supported by `TextDecoder` (UTF-8, windows-1251, ISO-8859-1,
      Shift_JIS, GBK, ...). Used to (1) decode response bytes when the HTTP charset header is
      absent or wrong, (2) percent-encode query strings and form bodies (`%E9` for latin-1
      "e-acute", not `%C3%A9`), (3) the `urlencode`/`urldecode` filters. If `encoding` is
      absent, use UTF-8. Unknown label -> definition rejected.
S2.5  `followredirect` (top level) applies to the login landing request only (the GET that
      fetches the login form). Search paths have their own `followredirect`; the download
      step always follows redirects (S11). Default for requests without the flag: do NOT
      follow redirects automatically; a 3xx on a search request is interpreted as a lost
      session (S13.6).
S2.6  `requestDelay`: minimum seconds between two requests to this site. Effective delay is
      `max(globalIndexerDelay (default 2 s), requestDelay)`; a definition can only slow us
      down, never speed up beyond the global default. See S15.
S2.7  `links`: ordered list of mirror URLs, each ending in `/` by convention (the loader MUST
      normalise to a trailing slash). The user may choose any of them or type a custom one
      (stored in instance setting `baseUrl`). If `baseUrl` is empty or equals a `legacylinks`
      entry the default `links[0]` is used and the instance is rewritten.
S2.8  `settings` omitted entirely -> default to two settings: `username` (text) and `password`
      (password). `settings: []` means "no settings at all" (public site).
S2.9  `certificates`: list of certificate fingerprints that the site is known to use with an
      otherwise untrusted chain. Upstream parses and ignores it. MT: parse, ignore, warn
      once; do not implement pinning or TLS bypass in v1.
S2.10 `ratio`: a selector block plus `path` used by Jackett to show the account ratio.
      Upstream parses and never uses it. MT: parse and ignore.
S2.11 `search.path` (single string) is sugar for `search.paths: [{path: <it>, inheritinputs: true}]`
      and is appended after any explicit `paths`. After normalisation `paths` is never empty;
      empty -> `DefinitionError`.
S2.12 `login.method` omitted while a `login` block exists -> `form`.
S2.13 Definition versioning `[MT]`: optional top-level `schema: 1`. Absence = 1. Reserved for
      future breaking changes; loader rejects `schema` greater than it understands.
S2.14 Definitions are loaded from (a) a bundled directory shipped in the image, (b) a user
      directory `/config/indexers/` (user overrides bundled when `id` matches). Hot reload on
      file change is NOT required; an explicit "reload definitions" API call is.
      The upstream remote catalogue download is out of scope for v1 (see Open questions).

---

## 3. `settings`

Each element describes one user-editable field of the instance.

```yaml
settings:
  - name: username
    type: text
    label: Username
  - name: password
    type: password
    label: Password
  - name: freeleech
    type: checkbox
    label: Search freeleech only
    default: false
  - name: sort
    type: select
    label: Sort requested from site
    default: created
    options:
      created: created
      seeders: seeders
      size: size
  - name: info_cookie
    type: info_cookie
    label: How to get the cookie
    default: "Log in with a browser, copy the Cookie header from dev tools."
```

Keys: `name` (id, used as `.Config.<name>`), `type`, `label`, `default` (string; for checkbox
`"true"/"false"` or YAML bool), `defaults` (list, only meaningful for multi-select; upstream
parses and never uses it), `options` (map option-key -> option label; select only).

Types:

| type | stores | template value | notes |
|---|---|---|---|
| `text` | string | the string, or `null` if never set and no default | |
| `password` | string | same | MUST be masked in UI, logs, API reads (write-only), exports |
| `checkbox` | boolean | `"True"` when checked, `null` when unchecked | see S4 truthiness |
| `select` | option key | the selected option **key** | see S3.3 |
| `info` | nothing | not a variable | read-only text; `default` holds the help text; may contain simple HTML links |
| `info_cookie` | nothing | not a variable | help for cookie login; UI may show a cookie helper |
| `info_flaresolverr` | nothing | not a variable | UI hint "this site needs a FlareSolverr proxy tag" |
| `info_useragent` | nothing | not a variable | UI hint "set the same User-Agent as the browser that produced the cookie" |
| `info_category_8000` | nothing | not a variable | UI hint "this site's uncategorised items map to Other (8000)" |
| `cardigannCaptcha` | transient string | not a variable | auto-added when `login.captcha` exists; label "CAPTCHA"; value only used for one login attempt, never persisted |

Rules:

S3.1  Any other `type` value -> `DefinitionError{code:'unsupported_setting_type'}` at load
      (upstream throws at first use). Accept the `info*` family case-sensitively as listed.
S3.2  Resolution: `value = instance.settings[name] ?? default`. For `checkbox`, string values
      `"true"`/`"false"` (any case) are coerced to booleans; a default absent means false.
S3.3  Select: upstream stores the selected *index* into the options sorted by key (ordinal
      string order) and has the default resolved by position. That is an upstream storage
      quirk that makes saved values break if keys are added. MT: store the option **key**.
      Importer for any Prowlarr-exported config converts index -> key by sorting keys
      ordinally. If the saved key no longer exists, fall back to `default`, then to the first
      key in file order.
S3.4  Conventional names with special handling: `cookie` (raw `Cookie:` header text, used by
      `login.method: cookie`), `username`, `password`, `apikey`, `rsskey`, `passkey`. Settings
      named `apikey`/`rsskey`/`passkey`/`password` and every `password`-type field MUST be
      excluded from debug logging of config values.
S3.5  Config variables are pre-computed once per request build into the template context under
      the names `.Config.<name>`. A name that is not declared in `settings` is not available;
      referencing it is a *load-time* template error (see S4.9), not a silent blank.
S3.6  `.Config.sitelink` is always available: the resolved base URL (S2.7), with trailing slash.
S3.7  Validation of instance settings: required settings are those of type `text`/`password`
      with no `default`, EXCEPT when the field is only used under a login method that the
      user has not chosen. Simplification for v1: `text`/`password` are required iff the
      definition has a `login` block whose method is not `cookie`, in which case
      `username`+`password` required; for `cookie` method, `cookie` is required. Public
      definitions have no required settings. The registry refuses to enable an instance whose
      settings are invalid (also used by app-sync filtering upstream).
S3.8  Per-instance extras outside the definition (not in YAML): see S15 (query/grab limits),
      S16, seeding rules (S10.9), `preferMagnetUrl` flag. These live in the instance row, not
      in `settings`.

---

## 4. Template language

A small Go-template-inspired language used inside many string values: paths, input values,
`text:` selectors, `default:` values, filter arguments of some filters (`append`, `prepend`,
`replace` second arg, `re_replace` second arg), header values, `selector` strings.

Syntax elements, all inside `{{ ... }}`:

| form | meaning |
|---|---|
| `{{ .Var }}` | substitute variable; null/missing-optional -> empty string |
| `{{ if .Var }}A{{ else }}B{{ end }}` | truthy test; `else` optional in MT |
| `{{ if eq .A "lit" }}..` / `ne` | equality / inequality of two operands |
| `{{ if and .A .B }}` / `or` | boolean combinators |
| `{{ range .List }}pre{{.}}post{{end}}` | iterate a list variable; `{{.}}` = element |
| `{{ range $i, $e := .List }}[{{$i}}]{{.}}{{end}}` | iterate with zero-based index |
| `{{ join .List "," }}` | join list with a literal separator |
| `{{ re_replace .Var "pattern" "repl" }}` | regex replace on a variable |

Truthiness (S4.1): a value is *false* if it is null/missing, an empty or whitespace-only
string, or an empty list. Everything else is true. The literal `"0"` and `"false"` are
**true** (they are non-empty strings). Checkbox settings produce `"True"` or `null`, so they
behave as expected.

Built-in constants: `.True` = `"True"`, `.False` = null, `.Today.Year` = current four-digit year
(local server year; MT: UTC year).

Variable names are dotted paths. The context is a flat map keyed by the full dotted name
(`.Query.Keywords` is a key, not a nested lookup), which keeps the engine tiny.

### 4.1 Variables available

Always:
`.Config.<setting>`, `.Config.sitelink`, `.True`, `.False`, `.Today.Year`.

During **search** (all `.Query.*` keys always exist; unused ones are null):

| variable | content |
|---|---|
| `.Query.Type` | `search`, `tvsearch`, `movie`, `music`, `book` |
| `.Query.Q` | the raw free-text term from the caller |
| `.Query.Keywords` | space-joined tokens: Q, then Series/Movie (unused, null in practice), Year, then Episode |
| `.Keywords` | `.Query.Keywords` after `keywordsfilters` (S9.4); this is what definitions normally use |
| `.Query.Categories` | list of *Torznab* category ids requested (ints rendered as strings) |
| `.Categories` | list of **tracker** category ids after mapping (S7.6) and per-path narrowing (S9.7) |
| `.Query.Limit`, `.Query.Offset` | page size / offset or null |
| `.Query.Extended`, `.Query.APIKey` | always null (kept for catalogue compatibility) |
| `.Query.Season`, `.Query.Ep`, `.Query.Episode` | TV: season number; episode number; formatted episode string such as `S01E02` or `2024.05.17` for daily |
| `.Query.Series`, `.Query.Movie` | always null (title is delivered in Q) |
| `.Query.Year`, `.Query.Genre` | movie/tv/music/book |
| `.Query.IMDBID` | full `tt0000000` form; `.Query.IMDBIDShort` digits only |
| `.Query.TMDBID`, `.Query.TVDBID`, `.Query.TVRageID`, `.Query.TVMazeID`, `.Query.TraktID`, `.Query.DoubanID` | numeric string or null |
| `.Query.Album`, `.Query.Artist`, `.Query.Label`, `.Query.Track` | music |
| `.Query.Author`, `.Query.Title`, `.Query.Publisher` | book |

During **result parsing**: everything above for that request, plus `.Result.<fieldname>` =
the already-computed value of each *earlier* field of the current row (S10.2).

During **download**: `.DownloadUri.AbsoluteUri`, `.DownloadUri.AbsolutePath`,
`.DownloadUri.Scheme`, `.DownloadUri.Host`, `.DownloadUri.Port`, `.DownloadUri.PathAndQuery`,
`.DownloadUri.Query` (raw `?a=b`), and `.DownloadUri.Query.<param>` for each query parameter
(first value wins when repeated).

Rules:

S4.2  Evaluation is textual and left-to-right in this order: (1) `re_replace` and `join`
      expressions, (2) `and/or/eq/ne` functions (innermost first so they can nest, each result
      replaced by `.True`/`.False`/the chosen operand), (3) `if/else/end`, (4) `range`,
      (5) plain `{{ .Var }}`. An engineer MAY implement a real parser/AST instead, provided
      the observable results in the Appendix D fixtures match. A real parser is recommended;
      the staged-replace approach upstream has ordering bugs (e.g. variables inside `if` bodies
      are only substituted after the `if` is resolved, which is fine, but nested `if` is
      unsupported).
S4.3  `and`: returns the first operand that is falsy, otherwise the last operand.
      `or`: returns the first operand that is truthy, otherwise the last operand.
      Used as a condition both work as expected; used as a value, they pass operand values
      through. Operands are variables (`.X` or `(.X)`); string literals in quotes are ignored
      by `and`/`or` and only meaningful for `eq`/`ne`.
S4.4  `eq`/`ne` take exactly two operands (variable or quoted literal); compare as strings
      (null equals null; null != ""). Result `.True` / `.False`.
      Example: `{{ if and (eq .Config.mode "hd") .Config.freeleech }}x{{ else }}y{{ end }}`.
S4.5  `range` over `.Categories` and `.Query.Categories` is the only common use. Index
      variables use the `$name` form and are replaced inside the body as `{{$name}}`.
S4.6  `re_replace` first operand MUST be a variable, the pattern and replacement are
      double-quoted literals. The regex dialect is ECMAScript with the `u` flag; definitions
      written for .NET regexes that use only common syntax (classes, groups, quantifiers,
      lazy quantifiers, `\d \w \s`, anchors, alternation) work unchanged. Replacement tokens
      `$1`, `${name}` are supported (translate to JS `$1`, `$<name>`). Unsupported constructs
      (atomic groups, possessive quantifiers, inline modifiers other than `(?i)` at the very
      start) -> `DefinitionError` at load, not a silent mismatch.
S4.7  URL encoding inside **path** templates: when a template is expanded for `search.paths[].path`
      every substituted variable value is percent-encoded with the definition's `encoding`
      and then `+` is rewritten to `%20` (spaces in path segments must be `%20`). This applies
      to values only, not to the literal text of the template.
      Inputs (query/form pairs) are NOT pre-encoded by the template engine; they are encoded
      once when the query string / form body is serialised (S9.9).
      Exception: the special `$raw` input (S9.8) is expanded with value-encoding on.
S4.8  Header templates (`headers:` blocks) use the plain engine, values trimmed.
S4.9  *Load-time validation*: walk every template string, parse it, and verify that all
      variable names are in the known set (S4.1 plus declared `.Config.*`, plus `.Result.*`
      names that are fields declared earlier in the same `fields` map). Unknown -> warning
      `unknown_variable` (error in strict/CI mode). At runtime an unresolved variable renders
      as empty string (never throws; upstream throws a key-not-found error, which is worse
      for users).
S4.10 Templates only run when the string contains `{{`; other strings pass through untouched
      (fast path).
S4.11 No template function other than those listed exists. `{{ now }}`, pipelines (`|`), custom
      functions and arithmetic are NOT supported; definitions needing them use filters.

Illustrative examples:

```
path: "browse.php?{{ range .Categories }}c{{.}}=1&{{end}}q={{ .Keywords }}"
# Categories ["5","7"], Keywords "my show s01e02"  ->
#   browse.php?c5=1&c7=1&q=my%20show%20s01e02          (values encoded, literal text kept)

text: "{{ if .Config.freeleech }}1{{ else }}0{{ end }}"          # checkbox on -> 1
default: "{{ or .Config.region .Config.sitelink }}"
```

---

## 5. Selectors

A *selector block* extracts a string from a context node (an HTML element, an XML element,
or a JSON value). The same YAML shape is used in `rows`, every `fields` entry, `selectorinputs`,
`getselectorinputs`, `error.message`, `rows.count`, `rows.dateheaders`, `ratio`.

```yaml
selector: "td.name a"        # where to look (string, templated)
attribute: href              # optional: take this attribute instead of text content
text: "constant {{ .Config.x }}"   # optional: constant text (skips selector entirely)
case:                        # optional: map selector -> value (first match wins)
  "img[alt=Freeleech]": 0
  "*": 1
remove: "span.hidden, i"     # optional: delete matching descendants before reading text
default: "unknown"           # optional: value used when optional and nothing found
optional: true               # optional: missing -> no error
filters:                     # optional: list of filters applied in order (S6)
  - name: replace
    args: ["_", " "]
```

### 5.1 Common semantics

S5.1  Evaluation order inside one block:
      1. If `text` is present: result = template(`text`); go to step 6.
      2. Resolve the `selector` (template-expanded first) against the context node
         (HTML/XML: S5.2; JSON: S5.4). If absent, the context node itself is the target.
         No match -> `required`: error `SelectorNoMatch`; `optional`: result = null, go to 7.
      3. Apply `remove` (HTML/XML only): delete every descendant of the target matching it.
      4. If `case` is present: S5.3. Else if `attribute` present: take that attribute (missing
         attribute -> same required/optional handling as step 2). Else take the target's text
         content (HTML/XML) or the value rendered as string (JSON).
      5. Trim whitespace of the extracted string (not applied to `text`).
      6. Apply `filters` in order.
      7. If the result is null/blank and the block is optional and has `default`, result =
         template(`default`) (upstream applies `default` only inside field parsing; MT applies
         it to every optional block so behaviour is uniform).
S5.2  HTML selectors are CSS selectors (level 3 plus `:has()`, `:not()`, `:contains()`-style
      text matching as supported by the chosen library, `:nth-child`, `:nth-of-type`,
      `:first-child`, `:last-child`, `:eq(n)` NOT supported; use `:nth-child`). Commas for
      unions are allowed. A selector starting with `:root` means "start from the document
      root regardless of context" (needed in `selectorinputs`). The selector may match the
      context node itself: try `context.matches(sel)` first, then `context.querySelector(sel)`.
      First match in document order is used.
S5.3  `case`: iterate entries in file order. HTML/XML: key is a CSS selector; the entry
      matches if the target matches it or contains a descendant that does. JSON: key is a
      literal compared to the extracted value as a string; key `*` matches anything. The
      mapped value is template-expanded. No entry matches -> required: error; optional: null.
S5.4  JSON selectors (used when the search response type is `json`):
      - Syntax is a dotted path: `data.items`, `torrent.size`, `files[0].name`. A leading `.`
        or `$.` is ignored. Wildcards (`[*]`) and recursive descent (`..key`) are supported.
        Array index and negative index (`[-1]`) are supported.
      - An empty selector means the context node itself (used when a row is a bare scalar).
      - If a field selector starts with `..` the context becomes the **row root** rather than
        the current sub-row (relevant when `rows.attribute`/`multiple` descend, S9.12).
      - Value to string: strings as-is; numbers via JS `String` of their JSON text (no
        exponent for integers up to 2^53); booleans `true`/`false` lowercase; null -> null
        (treated as missing). Arrays -> elements joined with `,` (no spaces); objects -> JSON
        text.
      - A filter suffix syntax on the **rows** selector (only): `path:has(sub)`, `path:not(sub)`,
        `path:contains(text)` keep rows where the sub-path exists / does not exist / the row's
        JSON text contains the literal. Multiple suffixes chain with AND. `sub` itself may carry
        suffixes. Unknown suffix -> logged error, ignored.
S5.5  XML selectors use the same CSS engine on an XML-parsed document (case-sensitive element
      names, namespaces ignored: write `item`, not `ns|item`). Attribute and text semantics as
      HTML. There is no XPath requirement.
S5.6  `attribute` on HTML returns the raw attribute value (entities already decoded by the
      parser). Relative URLs are NOT resolved here; resolution happens in field post-processing
      for `download`, `details`, `comments`, `poster` (S10.3).
S5.7  Text content: concatenation of all descendant text nodes in document order, no added
      separators. (`<td>a<b>b</b></td>` -> `ab`.) Definitions use `remove` and `replace`
      filters to fix spacing; do not "improve" by inserting spaces.
S5.8  HTML parsing MUST be tolerant (HTML5 spec parser, e.g. `parse5`/`htmlparser2` +
      `css-select`; see section 19). Non-breaking spaces are NOT normalised automatically;
      the `trim` filter removes ASCII whitespace only; `re_replace` with `\s` matches U+00A0
      in JS, which is the intended way.
S5.9  Required selector failures inside a row make that **field** fail; consequence depends
      on whether the field is required (S10.1).

---

## 6. Filters

A `filters` list is applied sequentially; each takes the current string and returns a string.
Syntax: `{name: <filter>, args: <scalar | list>}`. `args` strings of `append`, `prepend`,
`replace` (2nd arg) and `re_replace` (2nd arg) are template-expanded with the current context.
Unknown filter name -> error logged (`unsupported_filter`), filter skipped (upstream); MT:
also fail definition validation in strict mode. Filters never see null: if the input is null
the chain is skipped and the result stays null (an optional field that is missing).

| filter | args | semantics | example |
|---|---|---|---|
| `querystring` | param name | take the value of query param `param` from a URL string; text after the first `?` and before `#` is parsed; first value; missing param -> empty string; no `?` -> error | `/dl.php?id=42&k=x` + `id` -> `42` |
| `regexp` | pattern | first match; **return capture group 1**; no match -> empty string. Pattern without a capture group returns empty (authoring error; warn at load) | `(\d+) files` on `12 files` -> `12` |
| `re_replace` | [pattern, replacement] | global regex replace | `["[^a-z0-9]+", "."]` |
| `replace` | [from, to] | literal global replace (not regex); `to` templated | `["_", " "]` |
| `split` | [separator, index] | split on the first character of `separator` only; index may be negative (from end); out of range -> error (field fails) | `[",", -1]` on `a,b,c` -> `c` |
| `trim` | optional charset | no arg: trim whitespace. With arg: trim **only the first character of the arg** from both ends, repeatedly | `trim: "."` on `..x..` -> `x` |
| `trimprefix` | string | remove leading literal once if present `[MT]` (not in upstream filter list; common in other dialects) | |
| `trimsuffix` | string | remove trailing literal once `[MT]` | |
| `prepend` | string | prefix (templated) | `prepend: "{{ .Config.sitelink }}"` |
| `append` | string | suffix (templated) | |
| `tolower` / `toupper` | - | invariant-culture case change | |
| `urlencode` / `urldecode` | - | percent-encode / decode using the definition `encoding`; `urlencode` encodes space as `+` (form style), decode treats `+` as space | |
| `htmlencode` / `htmldecode` | - | entity encode/decode of `& < > " '` and numeric/named entities on decode | |
| `base64encode` / `base64decode` | - | **URL-safe** base64 (`-`/`_`, unpadded on encode; decoder accepts padded/unpadded and standard alphabet), UTF-8 bytes | |
| `dateparse` / `timeparse` | Go layout string | parse with a Go reference-time layout (S6.2); output is a normalised timestamp string (S6.1); on parse failure log at debug and leave the value **unchanged** | `dateparse: "2006-01-02 15:04:05"` |
| `timeago` / `reltime` | - | parse "2 hours 1 day ago", "now" (S6.3) | |
| `fuzzytime` | - | best-effort parse of many human formats (S6.4) | |
| `validfilename` | - | replace characters illegal in file names (`\ / : * ? " < > |` and control chars) with `_`; do not trim dots | |
| `diacritics` | `replace` | Unicode NFD, strip combining marks, NFC. Any other arg -> error. Characters with no decomposition (e.g. `D with stroke`) are left | `Dvorak with accents` |
| `jsonjoinarray` | [json path, separator] | input is JSON **object text**; select path (array) and join elements' string forms with separator | `["$.tags", ", "]` |
| `validate` | allowed-list string | tokenise both the arg and the value on `, space / ) ( . ; [ ] " | :` (case-insensitive); keep only value tokens that appear in the arg; output joined with `, ` (arg order is irrelevant, value order kept after intersect) | |
| `hexdump` | - | debug: logs each char with its hex code; value unchanged | |
| `strdump` | optional tag | debug: logs the value with `\r \n NBSP` escaped; value unchanged | |

S6.1  *Normalised timestamp string.* Upstream round-trips dates through an RFC-1123 string with
      numeric offset (`Tue, 05 Mar 2024 14:03:00 +00:00`). MT: filters `dateparse`, `timeago`,
      `fuzzytime` output an **ISO-8601 UTC string** (`2024-03-05T14:03:00Z`) and the `date`
      field accepts either form, a Unix timestamp, or anything `fuzzytime` accepts. Both
      representations MUST be accepted as input by `date` so imported definitions work.
S6.2  *Go layouts.* Layouts are written with Go's reference time `Mon Jan 2 15:04:05 MST 2006`.
      Required token support (case-sensitive; longest token first):
      `2006` 4-digit year, `06` 2-digit year, `January`/`Jan` month name full/abbr, `01` month
      zero-padded, `1` month, `Monday`/`Mon` weekday names (parsed and ignored), `02` day
      zero-padded, `2` day, `_2` day space-padded, `15` hour 24h, `03` hour 12h padded, `3` hour
      12h, `04` minute padded, `4` minute, `05` second padded, `5` second, `PM`/`pm` meridiem,
      `.000`/`.999` fractional seconds (any count), `Z07:00` / `-07:00` / `-0700` / `-07` numeric
      zone (`Z` accepted as UTC for the `Z` variants), `MST` zone abbreviation (accept `UTC`,
      `GMT`, `Z`; other abbreviations: treat as unspecified zone). Literal characters match
      themselves. Month and weekday names are English, case-insensitive on parse.
      Examples: `02 Jan 2006 15:04` parses `05 Mar 2024 14:03`; `2006-01-02T15:04:05Z07:00`.
S6.3  *Zone rule (MT).* A parsed date with no zone information is interpreted in the
      definition-level `timezone` `[MT]` (IANA name, optional top-level key, default `UTC`).
      Upstream interprets it in the server's local zone, which makes results depend on the
      Docker `TZ`; we explicitly do not. All stored/API dates are ISO-8601 UTC.
S6.4  *timeago.* Lower-case; if it contains `now` -> current time. Remove commas and the
      words `ago` and `and`. Then repeatedly read `<number><unit>` pairs (number may be
      fractional; unit is the run of non-digit non-space characters after it). Unit
      recognition by substring/equality: `sec`|`s` seconds; `min`|`m` minutes; `hour`|`hr`|`h`
      hours; `day`|`d` days; `week`|`wk`|`w` weeks; `month`|`mo` = 30 days; `year`|`y` = 365
      days. Unknown unit -> error (field fails; for `date` this means the date is missing).
      Result = now minus the summed duration. Note `m` = minutes, so months must be spelled
      `mo`/`month`. Examples: `2 hours 1 day ago`, `1.5h`, `3 weeks ago`, `just now`.
S6.5  *fuzzytime / `date` field fallback.* Try, in order: (1) the normalised formats of S6.1;
      (2) all digits -> Unix seconds (13 digits -> milliseconds `[MT]`); (3) contains `now`;
      (4) contains `ago` -> timeago; (5) `today`/`yesterday`/`tomorrow` optionally followed by
      `at` and a time, date = UTC midnight of that day + the time (time defaults to 00:00);
      (6) `<weekday> at <time>` -> most recent such weekday (today counts) at that time;
      (7) missing year: `MM-DD <rest>` or `D Mon HH:MM` -> current year inserted;
      (8) general date/time recogniser: ISO-8601 with/without `T`, `YYYY-MM-DD HH:mm[:ss]`,
      `DD Mon YYYY`, `Mon DD, YYYY`, `Mon DD YYYY HH:mm`, RFC 2822, numeric `A/B/YYYY` or
      `A-B-YYYY`. Numeric day/month order is **month first (US)** unless the filter arg or
      definition says `UK`; upstream default is US as well. 12-hour clocks with AM/PM
      accepted. Total failure -> error.
S6.6  Filters operate on strings; numeric parsing is the job of the field type (S10.4).

---

## 7. `caps`: capabilities and category mapping

```yaml
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies HD"}
    - {id: 2, cat: TV/SD,     desc: "TV SD", default: true}
    - {id: "anime", cat: TV/Anime, desc: "Anime"}
    - {id: 99, cat: Other,    desc: "Misc"}
  categories:            # legacy 1:1 form: tracker id -> Torznab category name
    7: Books/EBook
  modes:
    search: [q]
    tv-search: [q, season, ep, tvdbid, imdbid]
    movie-search: [q, imdbid, tmdbid]
    music-search: [q, album, artist]
    book-search: [q, title, author]
  allowrawsearch: false
```

### 7.1 Search modes

S7.1  `modes` is required and MUST contain `search` with exactly `[q]`. Other keys:
      `tv-search`, `movie-search`, `music-search`, `book-search`; any other key -> load error.
      Each is a list of parameter names; duplicates or unknown names -> load error.
S7.2  Allowed parameters (case-insensitive):
      - tv-search: `q season ep imdbid tvdbid rid tvmazeid traktid tmdbid doubanid genre year`
        (`rid` = TVRage).
      - movie-search: `q imdbid tmdbid imdbtitle imdbyear traktid genre doubanid year`.
      - music-search: `q album artist label year genre track`.
      - book-search: `q title author publisher genre year`.
S7.3  Meaning: the registry only sends a typed search to an instance if it advertises that
      mode and the specific ID parameter. If a caller has `tvdbId` but the site only lists
      `q`, the registry falls back to a title-keyword search (the caller already has the
      series title). If a site lists `imdbid` the engine puts the ID in `.Query.IMDBID` and
      the definition's `inputs` decide whether to use it.
S7.4  `allowrawsearch`: true means free-text queries may contain site-native operators and
      should not be sanitised by the caller. Default false. Surfaced in capabilities only.
S7.5  Limits `[MT]`: optional `caps.limits: {default: 100, max: 100}` (page size advertised on
      Torznab output). Upstream hard-codes 100/100.

### 7.2 Category mapping

S7.6  Each `categorymappings` entry: `id` (tracker's category id; string or number, kept as
      string; compared case-insensitively), `cat` (a Torznab category *name* from Appendix A,
      e.g. `TV/HD`; may be omitted for custom-only), `desc` (tracker's label), `default`
      (boolean). `cat` that is not a known name -> entry skipped with an error (upstream);
      MT: load warning, entry skipped.
S7.7  The legacy `categories` map (`id: name`) is equivalent to mappings without `desc`.
S7.8  *Custom categories.* If an entry has `desc`, a second mapping is created from the same
      tracker id to a **custom Torznab id** `100000 + n`:
      - tracker id numeric -> `n` = that number; so tracker cat 12 -> Torznab 100012.
      - tracker id non-numeric -> `n` = a stable 16-bit hash (0..65535) of the id string
        (upstream: first two bytes of SHA-1, read little-endian). Stability matters because
        external apps persist the id. Collisions are possible and accepted.
      The custom category's display name is `desc`. Custom ids (>= 100000) are never expanded
      into parent/child groups and are excluded from the "standard" capability list.
S7.9  *Category tree.* Mapped standard categories are arranged as parent (x000) with children
      (x010...). Custom ids are shown as children of the parent whose thousand-block they
      belong to when the id is in 1001..9999 (not applicable to the 100000+ range, which are
      top-level entries). A child automatically creates its parent entry in the advertised tree.
S7.10 *Query category expansion.* Requested Torznab ids expand: a parent id (x000) also
      includes all child ids known to this indexer's tree; a child stays itself; a custom id
      (>=100000) stays itself. Optionally (flag `mapChildrenCatsToParent`, off by default) a
      child also adds its parent.
S7.11 *Torznab -> tracker (request side).* `trackerIds = distinct(mapping.trackerId for each
      mapping whose torznabId is in the expanded request)`, preserving mapping order. If the
      result is empty, use the tracker ids of all mappings with `default: true`. If still
      empty, `.Categories` is the empty list (many sites then search all).
S7.12 *Tracker -> Torznab (response side).* A row's `category` field value is matched against
      mapping tracker ids case-insensitively and exactly; **every** matching mapping
      contributes its Torznab id (so one tracker cat usually yields a standard id and a custom
      id). `categorydesc` matches against `desc` the same way.
S7.13 *Unsupported check.* `supportedCategories(requested)` returns the subset of requested ids
      present in the tree (parents or children); the registry skips an indexer when none are
      supported (so a movie search never hits a books-only site).
S7.14 Standard category names are fixed (Appendix A). Matching of `cat:` names is exact and
      case-sensitive (`TV/HD`, not `tv/hd`).

---

## 8. `login`

Optional. Absent = anonymous access. Shape:

```yaml
login:
  method: form              # form | post | cookie | get | oneurl  (none: omit the block)
  path: login.php
  submitpath: takelogin.php         # form only: overrides the form's action
  form: "form#login"                # form only: CSS selector, default "form"
  selectors: false                  # form only: treat input keys as CSS selectors
  cookies: ["theme=dark"]           # extra cookies sent on the login requests
  headers: {User-Agent: ["Mozilla/5.0 ..."]}
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  selectorinputs:                   # form only: values scraped from the login page
    csrf_token: {selector: "input[name=csrf]", attribute: value}
  getselectorinputs:                # form only: same, but appended to the submit URL query
    ts: {selector: "input[name=ts]", attribute: value, optional: true}
  error:
    - selector: "div.error"
      message: {selector: "div.error span"}   # optional nicer message
  test:
    path: index.php
    selector: "a[href^='logout']"
  captcha:
    type: image
    selector: "img#captcha"
    input: captcha_code
```

### 8.1 General rules

S8.1  Login is lazy: it runs (a) when the user presses Test/Save, (b) when a request finds
      itself unauthenticated (S13.6), never at startup. Concurrency: at most one login in
      flight per instance; concurrent requests await it.
S8.2  After a successful login the cookie jar (name -> value) is persisted with an expiry of
      now + 30 days (upstream constant) in the instance status; at request time cookies past
      expiry are discarded.
S8.3  Login-time requests respect rate limiting (S15) and the same proxies as searches (S14).
      The `Referer` header is set to the site base URL (or to the login page URL for the form
      submission). Custom `headers` come from `login.headers`; if absent, `search.headers`
      are used. Header values are lists in YAML; only the first element is used.
S8.4  `login.inputs` values are template-expanded using base variables only (`.Config.*`).
S8.5  `error` blocks: after the login response arrives (HTML), each block's `selector` is
      tested; the first that matches aborts login with `LoginFailed("Error: <text>")` where
      text is the matched element's text, or the result of `message` (a selector block run
      against the document root) when present; text is trimmed. Blocks are checked in order.
      Additionally a 401 status always aborts with an auth error.
S8.6  `test` block: used only to decide *whether a search response means "logged out"*
      (S13.6): if `test.selector` is set, the response is HTML (content type contains
      `text/html`, or is unknown), and the selector matches **zero** elements -> logged out.
      `test.path` is not used by upstream during searches. MT: `test.path` is used by the
      "Test indexer" action (S12) to fetch a page when no search is possible.
S8.7  Login failures raise `IndexerAuthError` (distinct from transport errors) so the registry
      can show "invalid credentials" and apply backoff (S16). Passwords MUST NOT appear in
      error text or logs.

### 8.2 Methods

S8.8  `method: cookie`. No HTTP at login time. The persisted cookie jar is replaced by the
      parsed value of setting `cookie` (a `Cookie:` header string, `a=1; b=2`, parsed on `;`,
      first `=` splits name/value, names trimmed). The user is responsible for refreshing it.
      Jar expiry set to now + 30 days; when the site redirects to a login page the jar is
      cleared and the indexer reports "session expired, update cookie". Because there is no
      password flow, a cookie setting is the only required setting (S3.7).

S8.9  `method: post`. Single request, no form discovery.
      1. Build form pairs from `inputs` (templated).
      2. Clear existing jar. Start the jar with `login.cookies` if present.
      3. `POST {path}` (relative to site base) with `application/x-www-form-urlencoded` body
         encoded in the definition encoding, automatic redirects ON, HTTP errors tolerated
         (no throw on 4xx/5xx other than 401).
      4. Store cookies from the final response chain; run `error` blocks; persist.

S8.10 `method: get`. Same as `post` but pairs go into the query string of the GET to `path`
      (appended with `?`), no initial cookies, redirects per HTTP client default. Cookies
      from the response are stored.

S8.11 `method: oneurl`. The single input named `oneurl` (templated; typically a passkey/token)
      is appended directly to `path` (no `?`, no `=`): `GET path + oneurl`. Cookies stored;
      `error` blocks run. Use case: sites that log in via a URL like `/auth/<token>`.

S8.12 `method: form` (default). Emulates a browser form submit.
      1. *Landing:* GET `path` (follow redirects only if top-level `followredirect: true`),
         sending `login.cookies` if any; keep cookies and the parsed DOM. If called because a
         search found the session expired, this GET is performed first (the DOM is not
         cached across logins).
      2. *Find form:* `form` selector (default first `form`). Missing -> config error
         "No form found on <url> using form selector <sel>".
      3. *Collect fields:* every `input` inside the form that has a `name`, is not
         `disabled`, and, if checkbox/radio, is checked, contributes `name -> value attr`
         (empty string if no value). (Inputs of other kinds -- `select`, `textarea` -- are not
         auto-collected; put them in `inputs`.)
      4. *Override with inputs:* for each `login.inputs` entry set `pairs[key] = template(value)`;
         if `login.selectors: true` the **key** is a CSS selector located in the landing DOM
         and the pair name is that element's `name` attribute (missing element -> config error).
      5. *selectorinputs:* for each, evaluate the selector block against the landing document;
         required unless `optional`; if value is null+optional, skip; set `pairs[key]`.
      6. *getselectorinputs:* same evaluation, but results go to a query string that is
         appended to the submit URL (`?k=v&...`).
      7. *Submit URL:* `submitpath` if given, else the form's `action` attribute, resolved
         against the landing URL, plus the query from step 6.
      8. *Built-in simple-captcha helper:* if the landing page contains a `script` whose `src`
         contains `simpleCaptcha`, GET `<site>/simpleCaptcha.php?numImages=1`, parse JSON,
         set `captchaSelection` = `images[0].hash` and `submitme` = `X`. (Legacy helper kept
         for catalogue sites that use it.)
      9. *Captcha:* S8.3 below.
      10. *Submit:* POST. If the form `enctype` is `multipart/form-data`, send a multipart
         body with a generated boundary and every pair as a plain text part; otherwise
         urlencoded in the definition encoding. Redirects ON. `Referer` = landing URL.
      11. Store cookies from the response, run `error` blocks, persist.
      Because landing cookies (CSRF/session) are part of the jar, step 10 MUST send them.

### 8.3 Captchas

S8.13 `captcha.type`: only `image` is implemented upstream; any other value is
      `NotImplemented`. MT: same; unknown type -> definition warning, login proceeds without
      captcha handling.
S8.14 Interactive flow (Test/Save in the UI): during the landing request, if `captcha.selector`
      matches an element (typically `img`), fetch its `src` (resolved against the login URL,
      same cookies, `Referer` = login URL), and return `{contentType, imageBytes}` to the UI
      with the updated cookie jar held server-side for the following submit. The user types the
      text, which arrives as the transient setting `CAPTCHA`; at submit, it is placed in the
      form pair named by `captcha.input` (or, with `selectors: true`, the `name` of the element
      matched by `captcha.input`).
S8.15 Unattended flow (automatic re-login during a search): if the landing page shows a
      captcha, login aborts with `LoginFailed("captcha required during automatic login")`; the
      indexer is marked failed (backoff) and the UI shows "needs manual login". The engine
      never calls external captcha-solving services.
S8.16 The old key `captcha.image` is invalid ("use selector"); loader error.

### 8.4 When is login needed (`isLoggedOut`)

S8.17 `isLoggedOut(response)` is true when any of: (a) definition has no `login` -> always
      false; (b) response is a redirect (3xx) -- also log a hint if the redirect goes to
      another host that starts differently from the site host ("site moved? try URL X");
      (c) HTTP status >= 400 (any HTTP error); (d) `login.test.selector` evaluates to zero
      matches on an HTML response. All other cases are logged-in.

---

## 9. `search`

```yaml
search:
  paths:
    - path: "api/v1/search"
      method: get
      response: {type: json, noResultsMessage: ""}
      categories: [1, 2]         # use this path only when these tracker cats are involved
      followredirect: false
      inheritinputs: true
      inputs: {page: "{{ .Query.Offset }}"}
      queryseparator: "&"
  headers:
    Accept: ["application/json"]
  keywordsfilters:
    - {name: re_replace, args: ["[^\\w ]+", " "]}
    - {name: trim}
  allowEmptyInputs: false
  inputs:
    q: "{{ .Keywords }}"
    cat: "{{ join .Categories \",\" }}"
  preprocessingfilters: []
  error:
    - {selector: "div.error"}
  rows:
    selector: "data.items"
    ...
  fields:
    ...
```

### 9.1 Paths

S9.1  `paths` is a list; **every** path produces one request per search (after the category
      test below), executed in order; the union of their results is returned. (Sites often
      split into a "torrents" and a "requests" page, or movies and TV pages.)
S9.2  Path entry keys: `path` (relative or absolute URL; templated, see S4.7), `method`
      (`get` default | `post`, case-insensitive), `inputs` (map), `inheritinputs` (default
      true), `categories` (list of tracker ids), `followredirect` (default false),
      `response` (`type` and `noResultsMessage`), `queryseparator` (default `&`).
S9.3  `response.type`: `html` (default, anything unrecognised), `json`, `xml`. This selects
      the parser for **this** path's response (S9.10-S9.13).
S9.4  `keywordsfilters`: filters (S6) applied to `.Query.Keywords` to produce `.Keywords`.
      Typical use: strip punctuation, collapse spaces, URL-encode for sites that need
      pre-encoded terms. Empty list = identity.
S9.5  `headers`: custom headers for search requests; map name -> list of templated values; only
      the first element is used (upstream limitation; MT accepts and joins others with `, `
      `[MT]`).
S9.6  `allowEmptyInputs` (default false): when false, any input whose expanded value is empty or
      whitespace-only is **omitted** from the request. When true, it is sent as `key=`.
S9.7  *Category narrowing per path.* If a path lists `categories` and the request has at least
      one mapped tracker category (`.Categories` non-empty):
      - If the intersection of path categories and request categories is empty -> **skip this
        path** (and for later paths `.Categories` is recalculated from the original request
        list).
      - If non-empty, `.Categories` for this path's templates becomes the intersection.
      - A path whose first category entry is the literal `!` is a *negation*: it runs only when
        the intersection is **empty** and `.Categories` becomes request minus listed.
      If the request has no mapped categories (`.Categories` empty), every path runs.
S9.8  *Inputs.* Effective input list = `search.inputs` (if `inheritinputs`) then
      `path.inputs`, in file order; duplicate keys are kept as repeated pairs (not replaced).
      Special key `$raw`: its value is template-expanded **with value encoding on**, then split
      on `&`; each piece is split on the first `=` into key/value and appended as a pair
      (empty keys dropped). Use it when the site wants a pre-baked query fragment, e.g. the
      categories repeated as `c1=1&c2=1`.
S9.9  *Request construction.*
      - URL = resolve(expanded path, site base). Resolution rules in S10.3.
      - GET: pairs appended after `?` (or `&` if path already has `?`), joined with
        `queryseparator`, keys and values percent-encoded in the definition encoding; space as
        `+`... except path segments (already `%20`).
      - POST: pairs sent as `application/x-www-form-urlencoded` in the body (same encoding),
        URL has no appended query.
      - Duplicate GET URLs across paths (identical final URL) are issued once.
      - Redirects: not followed unless `followredirect: true`.
      - Common headers: instance user agent (S13.2), `Accept-Encoding: gzip, deflate`, custom
        headers, cookies from jar. No `Referer` unless the definition sets it.
S9.10 `preprocessingfilters`: filters applied to the **raw response text** before HTML/XML
      parsing (e.g. strip a broken comment, fix an unclosed tag). Not applied to JSON.
S9.11 `error` (search-level): reserved. Upstream parses and ignores. MT: if a block's selector
      matches the HTML response, the page is treated as a site error: `IndexerError(text)`
      and failure is recorded `[MT]`.
S9.12 *Row extraction* for `type: json`:
      1. If `noResultsMessage` is set and non-empty and the raw body contains it -> zero
         results. If it is set but empty and the body is empty/whitespace -> zero results.
      2. Parse JSON; failure -> `IndexerParseError("Error Parsing Json Response")`.
      3. If `rows.count` is present, evaluate it as a JSON selector; if it parses to an integer
         < 1 -> zero results. Failure evaluating `count` is ignored.
      4. Evaluate `rows.selector` (template-expanded) as a JSON path to an **array**; apply
         `:has/:not/:contains` filters (S5.4). Not an array / path missing -> if
         `rows.missingAttributeEqualsNoResults` then zero results else
         `IndexerParseError("Error Parsing Rows Selector")`.
      5. For each row: if `rows.attribute` is set, descend to that sub-path (missing ->
         skip row when `missingAttributeEqualsNoResults`, else error). If `rows.multiple` is
         true, the descended value is an object whose **values** are each treated as a row
         (map-of-rows form); otherwise the descended value itself is the row.
      6. Each field's selector runs against that row; a selector beginning with `..` runs
         against the *outer* row (before `attribute`/`multiple` descent).
S9.13 *Row extraction* for `type: html` / `xml`:
      1. Optional `preprocessingfilters` on raw text (S9.10).
      2. Parse; `rows.selector` (template-expanded) via `querySelectorAll` on the document.
      3. `rows.after: N` (default 0): *merge* — each logical row consists of the matched row
         plus the next N matched siblings; the children of the following N rows are moved into
         the first row and the N rows are removed from the list. (Sites with two `<tr>` per
         release.) If fewer than N rows remain, the logical row is incomplete and processing of
         that row fails.
      4. `rows.remove`: not applied at row level (it is a normal selector-block key and acts
         inside `rows` as per S5.1 step 3 only if the engine chooses; upstream ignores it at
         row level. MT: ignored).
      5. A per-row failure is logged and that row is skipped; other rows continue (HTML); for
         JSON a failing **required** field aborts the whole response with a parse error
         (upstream asymmetry; MT: skip the row in both cases and count `rowsSkipped` for
         diagnostics `[MT]`).
S9.14 `rows.dateheaders` (HTML only): if after parsing fields the release has no publish date,
      search backwards for a *date header row*: starting at the previous sibling element of the
      row (or, if none, the parent's previous sibling), run `dateheaders` selector on each
      candidate walking further back until one yields a value; parse that with the `date`
      rules (S6.5). If none found and `dateheaders.optional` is not true -> row fails ("no date
      header row").
S9.15 `rows.filters`: row-level filters. Only two names are defined: `andmatch` and `strdump`.
      `andmatch` means: after parsing, the registry post-filters the result list by the
      query (S10.10). `strdump` logs the row. Unknown names -> logged error, ignored.
S9.16 Pagination: not supported by the engine. Each path yields one page (the site's own page
      size). The registry treats the first response size as the page size and does not issue
      further pages (upstream sets page size 1 so the "is page full?" logic never loops).
      Definitions that need more use `.Query.Offset`/`.Query.Limit` in inputs; the registry
      MAY issue extra pages in interactive deep search `[MT]` (Open questions).
S9.17 Empty search (RSS mode): when no keywords/ids/categories, `.Keywords` is empty, `inputs`
      collapse via S9.6, and the site returns its latest releases. The "Test" action uses this
      (or the keyword `test` if the site has no RSS mode, which is known from whether a
      keyword-less query returns data; v1: always try empty first, then `test`).

---

## 10. Fields and release mapping

`fields` is an **ordered** map: field key -> selector block. Evaluate strictly in file order.
(Upstream allows the same key twice, e.g. several `title` entries to build a title; YAML maps
cannot, so authors use suffix modifiers: `title_1`, or `title|append`. See below.)

### 10.1 Key syntax and requiredness

A key is `name` or `name|modifier|modifier`. `name` is the *field name*; text after `|` are
*modifiers*. Suffix style for duplicates: because YAML maps cannot repeat a key, authors use
unique keys such as `title_phase1` `[MT]`: any key matching `<fieldname>_<anything>` where
`<fieldname>` is a known field name behaves as that field if it is not itself a known field.
(Upstream allowed repeated keys through a custom list type; imported definitions that rely on
that need the loader to read the YAML as an ordered list of pairs -- the loader MUST use a
YAML parser that preserves duplicate keys, or pre-process them into `title`, `title|1`,
`title|2`.)

S10.1 *Required vs optional.* A field is **optional** if any of: its selector block has
      `optional: true`; it has the modifier `optional`; its name is one of the "implicitly
      optional" set: `imdb imdbid tmdbid rageid tvdbid tvmazeid traktid doubanid poster banner
      description genre`. All others are **required**.
      - Required field with a failing selector -> the whole row is invalid (HTML: row
        skipped; see S9.13).
      - Optional field failing or yielding blank -> use `default` (templated) if non-blank,
        else the field is simply absent (its `.Result.<name>` is null, no error).
S10.2 *Results chain.* After each field computes its final string value (post-filters and
      post-processing in S10.3), it is stored as `.Result.<name>` so later fields can use
      `{{ .Result.title }}` in `text:`, `default:` or filter args. A failed optional field
      stores null. Modifiers are not part of the variable name.
S10.3 *Per-field post-processing.* `name` determines what the value does to the release. All
      strings are first trimmed. Relative URLs are resolved against the **search request URL**
      (the actual URL called), not the site base, so a response from `/api/v2/search` resolves
      `dl.php?id=1` to `/api/v2/dl.php?id=1`; absolute URLs and root-relative (`/x`) behave per
      RFC 3986.

| field | effect on the release | notes |
|---|---|---|
| `category` | map tracker id -> Torznab ids (S7.12), union into `categories` | modifier `noappend` replaces instead of unioning (deprecated; warn "use default") |
| `categorydesc` | map by desc (S7.12), same union | |
| `title` | `title` = value; modifier `append` -> concatenate onto existing title | required for a valid release |
| `description` | `description` (modifier `append` concatenates) | optional implicitly |
| `details` | `infoUrl` = resolved absolute URL | page of the release |
| `comments` | `commentUrl` = resolved absolute URL (set once; first wins) | |
| `download` | if value starts with `magnet:` -> `magnetUrl`; else `downloadUrl` = resolved absolute URL. In both cases `guid` = that URL. Empty value -> `downloadUrl` = null (release later dropped if no link at all) | |
| `magnet` | `magnetUrl` = value | |
| `infohash` | `infoHash` = value | |
| `size` | bytes via S10.4 | |
| `date` | `publishDate` via S6.5 | |
| `seeders` | integer; values >= 5,000,000 are treated as 0 (sites emitting garbage); `peers` += seeders | |
| `leechers` | integer with the same cap; `peers` += leechers | |
| `grabs` | integer (snatched/completed count) | |
| `files` | integer file count | |
| `downloadvolumefactor` | decimal (0 = freeleech, 0.5 = half, 1 normal) | |
| `uploadvolumefactor` | decimal (0 = neutral, 1 normal, 2 double) | |
| `minimumratio` | decimal; tracker-mandated seed ratio | |
| `minimumseedtime` | integer **seconds** | |
| `imdb`, `imdbid` | integer; digits are extracted from strings like `tt0133093` -> 133093 | |
| `tmdbid`, `tvdbid`, `rageid`, `tvmazeid`, `traktid`, `doubanid` | integer; first run of digits in the string | missing digits -> 0 |
| `poster` | `posterUrl` resolved absolute (blank ignored) | optional |
| `banner` | optional, stored `bannerUrl` `[MT]` | |
| `genre` | split on `, space / ) ( . ; [ ] " | :`, drop empties, `_` -> space, union into `genres` | |
| `year` | integer | |
| `author`, `booktitle`, `publisher`, `artist`, `album`, `label`, `track` | string metadata | |
| anything else | stored only as `.Result.<name>` (a scratch variable); no effect on the release | useful for temp values |

S10.4 *Numbers.* All numeric parsing is lenient and locale-neutral:
      - **Integers**: keep only digits, `.`, `,` (everything else is discarded: spaces, letters,
        `-`, `+`). Separators are thousands separators -> removed (`1,234` and `1.234` both
        1234; `1.234,5` is passed through and rejected as invalid integer -> field fails).
        Empty result -> 0.
      - **Decimals**: keep digits, `.`, `,`; comma becomes dot; if several dots, the **last** is
        the decimal point and the earlier ones are removed (`1.234.5` -> 1234.5); empty -> 0.
      - **Extracted ids** (`imdb`, etc.): the first contiguous run of digits; none -> 0.
      - **Sizes**: letters in the string select the unit (after dropping the letter `i`, so
        `GiB` = `GB`), case-insensitive, **binary** multiples (1 KB = 1024 B): contains `kb`,
        `mb`, `gb`, `tb` respectively; otherwise bytes. The number part uses the decimal rule
        (so `1,5 GB` = 1.5 GB, `1.234,56 MB` = 1234.56 MB). Result truncated to integer bytes.
        Examples: `1.5 GB` -> 1610612736, `700 MiB` -> 734003200, `123456` -> 123456,
        `12 KB` -> 12288. `B`, `Bytes` -> unit absent -> bytes.
S10.5 *Post-row release finalisation* (after all fields for a row):
      1. If `magnetUrl` is null, `infoHash` is non-blank, and definition `type` is not
         `private`: synthesise a magnet from the hash, display name = title, plus a built-in
         list of public tracker announce URLs (maintained list in code, overridable in
         config `[MT]`). Hash accepted as 40 hex or 32 base32 chars `[MT]`; invalid -> no magnet.
      2. If `magnetUrl` exists and `infoHash` is blank: extract the hash from the `xt=urn:btih:`
         parameter (lower-case hex output `[MT]`; upstream keeps the source casing).
      3. If `description` starts with the word `Internal`, add flag `internal`.
      4. `guid` missing -> `downloadUrl`, else `magnetUrl`, else `infoUrl`.
S10.6 *Indexer-level cleanup* (applies to every release regardless of source):
      - Set `indexerId`, `indexer` (name), `protocol` (Cardigann definitions are always
        `torrent`), `indexerPrivacy`, `indexerPriority`.
      - Flags: `downloadvolumefactor == 0` -> `freeleech`; `== 0.5` -> `halfleech`;
        `uploadvolumefactor == 0` -> `neutralleech`; `== 2` -> `doubleupload`.
      - **Deduplicate by `guid`** (keep first).
S10.7 *Validity gate* (non-interactive searches only): a release is dropped (with a warning
      naming the indexer and title) if `title` is blank, `size` is null, or `categories` is
      empty. For interactive (user-initiated) searches only the title check applies, so the
      user can see broken rows and understand the definition problem.
S10.8 *Link requirement*: a release with neither `downloadUrl`, `magnetUrl` nor `infoHash` is
      un-grabbable; keep it for display in interactive search but never auto-grab `[MT]`.
S10.9 *Seeding rules.* A torrent release carries effective seed rules computed as:
      instance override (`seedRatio`, `seedTime` minutes, `packSeedTime` minutes) if set,
      else the tracker-provided `minimumratio`/`minimumseedtime` from the row if present,
      else none (the download client defaults apply). Instance settings
      `appMinimumSeeders` (min seeders accepted by decision engine) and `preferMagnetUrl`
      (use `magnetUrl` over `downloadUrl` when both exist) are per-instance, not per-definition.
      Defaults for `downloadVolumeFactor` and `uploadVolumeFactor` when absent: **1.0** (MT;
      upstream leaves null and downstream treats null as 1).
S10.10 *Query re-filter (`andmatch`)*. When `rows.filters` contains `andmatch`, after parsing
      and only for keyword (not RSS, not ID) searches, drop releases whose title and
      description do not contain enough query terms: split the search term on non-word
      characters, discard single-character terms and the stop words `and`, `the`, `an`, `of`;
      with more than one remaining term, require at least **two** of them to appear
      (case-insensitive substring); with exactly one term require it. Used for sites whose own
      search is OR-based.
S10.11 *Category re-filter at the registry.* After the engine returns, the registry drops
       releases that have categories but none intersect the expanded requested categories
       (releases with **no** categories are kept at this stage; they were already dropped by
       S10.7 unless interactive). Then optional filters from the caller: `minAge`/`maxAge`
       days (against `publishDate`), `minSize`/`maxSize` bytes.
S10.12 *Release record (TypeScript).* Output of the engine (field names for the shared Zod
       contract; all optional unless stated):

```ts
interface IndexerRelease {
  guid: string;                 // required after cleanup
  title: string;                // required
  description?: string;
  size?: number;                // bytes; required for non-interactive
  downloadUrl?: string;         // absolute
  magnetUrl?: string;
  infoHash?: string;            // lower-case hex
  infoUrl?: string;             // details page
  commentUrl?: string;
  posterUrl?: string;
  publishDate: string;          // ISO-8601 UTC; if unknown: the retrieval time? NO: null, see S10.13
  categories: Array<{id: number; name?: string}>;   // Torznab ids
  genres?: string[];
  seeders?: number; leechers?: number; peers?: number;
  grabs?: number; files?: number;
  downloadVolumeFactor: number; uploadVolumeFactor: number;       // default 1
  minimumRatio?: number; minimumSeedTimeSeconds?: number;
  imdbId?: number; tmdbId?: number; tvdbId?: number; tvRageId?: number;
  tvMazeId?: number; traktId?: number; doubanId?: number; year?: number;
  author?: string; bookTitle?: string; publisher?: string;
  artist?: string; album?: string; label?: string; track?: string;
  flags: Array<'freeleech'|'halfleech'|'neutralleech'|'doubleupload'|'internal'|'scene'|'exclusive'>;
  protocol: 'torrent';          // 'usenet' only for Newznab-type indexers
  indexerId: number; indexer: string; indexerPriority: number;
  indexerPrivacy: 'public'|'semi-private'|'private';
}
```

S10.13 Missing `date`: upstream leaves the .NET minimum date (year 0001), which sorts last and
       shows an absurd age. MT: `publishDate` = null in the engine; the registry substitutes
       the retrieval time for RSS ordering but marks `dateEstimated: true`, and the decision
       engine MUST NOT treat estimated dates as real publish dates for age-based rules.
S10.14 Language/subtitle/resolution metadata: not extracted by definitions (upstream has no
       such fields in the Cardigann parser). The release-name parser (Phase 1) derives them
       from `title`.
S10.15 Usenet: Cardigann definitions are torrent-only. Usenet indexers are Newznab (Phase 1).

Worked example (HTML):

```yaml
search:
  paths:
    - path: "browse.php"
      inputs: {}
  inputs:
    search: "{{ .Keywords }}"
    "c[]": "{{ join .Categories \",\" }}"
  keywordsfilters:
    - {name: re_replace, args: ["[._-]+", " "]}
  rows:
    selector: "table#torrents > tbody > tr:has(td.name)"
  fields:
    category:
      selector: "td.cat a"
      attribute: href
      filters: [{name: querystring, args: cat}]
    title:      {selector: "td.name a"}
    details:    {selector: "td.name a", attribute: href}
    download:   {selector: "a.dl", attribute: href}
    size:       {selector: "td.size"}
    seeders:    {selector: "td.seed"}
    leechers:   {selector: "td.leech"}
    grabs:      {selector: "td.done", optional: true}
    date:
      selector: "td.added"
      filters: [{name: dateparse, args: "2006-01-02 15:04:05"}]
    downloadvolumefactor:
      case: {"img[alt=Free]": 0, "*": 1}
    uploadvolumefactor: {text: 1}
```

Note `case` with `*` under HTML: the `*` CSS selector matches any element, so it acts as a
catch-all there too.

---

## 11. `download` block

```yaml
download:
  method: get                     # get (default) | post
  headers: {Referer: ["{{ .DownloadUri.AbsoluteUri }}"]}
  before:                         # optional pre-request
    path: "ajax/token.php"
    method: post
    inputs: {id: "{{ .DownloadUri.Query.id }}"}
    queryseparator: "&"
    pathselector: {selector: "a.next", attribute: href}   # alt to path: scrape it from the page
  selectors:                      # extract the real link from the details/link page
    - selector: "a.dl-torrent"
      attribute: href
      usebeforeresponse: false
      filters: []
    - selector: "a[href^='magnet:']"
      attribute: href
  infohash:                       # alternative: build a magnet from page data
    hash:  {selector: "td.hash"}
    title: {selector: "h1"}
    usebeforeresponse: true
```
testlinktorrent at top level controls verification (below).

S11.1 *When it runs.* At grab time, for a release whose `downloadUrl` came from a definition
      with a `download` block. The registry calls `engine.download(link)`; the engine returns
      a final request (URL, method, headers, cookies) that the transport executes. Magnet
      links never go through this (return as is).
S11.2 *Without a block*: GET the link with cookies and custom headers (`download.headers` else
      `search.headers`), redirects ON.
S11.3 *Order of operations.*
      1. Build base request: GET `link`, jar cookies, headers, definition encoding, redirects ON.
      2. `before`: if `pathselector` present, fetch the base request, evaluate the selector
         block against its HTML and use the result as `before.path`. Then issue the `before`
         request (path templated with `.DownloadUri.*`, inputs as query for GET or form for
         POST, `Referer` = the original link). Keep its response as `beforeResponse`.
      3. `method: post` sets the **final** download request's method.
      4. If `infohash` present: take `beforeResponse` when `infohash.usebeforeresponse` and a
         before response exists, else fetch the base link; evaluate `hash` and `title`
         selectors (selector blocks with `selector`, `attribute`, `filters`); both required.
         Build a magnet and return it as the final request (scheme `magnet`). Any failure is
         logged and falls through to the plain link (upstream falls through to the last step).
      5. Else if `selectors` present: for each selector **in order**: get the page (the
         `beforeResponse` if `usebeforeresponse` and available, else fetch the base link),
         evaluate it; no match -> next selector. Resolve the value against the original link.
         If it is a `magnet:` URL -> return it. Else if `testlinktorrent` (default true):
         fetch the candidate; if the body is non-empty and its first byte is not `d` (a valid
         bencoded torrent starts with `d`), consider the candidate invalid and try the next
         selector. First valid candidate wins and becomes the final request (GET/POST per
         step 3). All selectors fail -> `DownloadError("Download selectors didn't match for
         <link>")`.
      6. Else final request = base link with the method of step 3.
S11.4 The final download response MUST be validated by the registry/transport: (a) follow up to
      **5** redirects manually (a redirect to `magnet:` switches to magnet handling);
      (b) a response whose content type is HTML is an error ("Site responded with html
      content"), commonly meaning the session expired; (c) `404` -> `ReleaseUnavailable`;
      (d) `429` -> grab-limit error, no auto-retry; (e) the bytes MUST parse as a bencoded
      dictionary (`d...e` containing `info`) -> else error.
S11.5 Selectors in `download` use the single-node selector shape (`selector`, `attribute`,
      `filters`) and only HTML pages are supported. Without `attribute`, the element text is
      the value. A missing attribute is an error for that selector (next selector tried).
S11.6 Each download request is subject to the site's rate limit (S15) and proxies (S14), plus
      grab limits (S15.3).
S11.7 Download time failures other than 404/429/HTML should record an indexer failure (S16);
      404/429 and unavailable releases do not escalate.

---

## 12. Test block and "Test indexer" action

S12.1 Action `test(instance)` performs: validate settings (S3.7) -> login if needed (a failure
      here returns the login error text) -> run an RSS-style (keyword-less) search for the
      lowest-numbered supported mode; if the definition cannot do keyword-less search, search
      for `test`. Outcomes:
      - transport/auth/parse exception -> failure with message (credentials hint for auth).
      - request returned zero rows -> **failure** with message "Query successful, but no
        results were returned ... check category/freeleech settings" (upstream treats empty as
        failure; this is intentional so broken selectors are noticed).
      - rows > 0 -> success. On success: reset failure status (S16.8).
S12.2 `test` also serves "Request limit reached" as a *warning*, not failure (we reached the
      site; limit is the site's own).
S12.3 CloudFlare challenge during test -> failure "Cloudflare protection detected; a
      FlareSolverr proxy may be required" (S14.5).
S12.4 The test result includes diagnostics: request URL (cookies/keys redacted), HTTP status,
      elapsed ms, number of rows matched, number of rows skipped and the first row-level error.

---

## 13. Request execution details

S13.1 *Transport interface* (injected into the engine):

```ts
interface HttpTransport {
  request(req: {
    url: string; method: 'GET'|'POST'; headers: Record<string,string>;
    cookies?: Record<string,string>; body?: Uint8Array|string; contentType?: string;
    followRedirects: boolean; timeoutMs: number; encoding: string;
    rateKey: string; rateIntervalMs: number; indexerId: number;
  }): Promise<{ status: number; headers: Record<string,string>; body: Uint8Array;
                finalUrl: string; redirectUrl?: string; cookies: Record<string,string>;
                elapsedMs: number }>;
}
```
      The *real* implementation composes: proxy selection (S14) -> rate limiter (S15) -> retry
      -> `undici`/`fetch` -> cookie capture. Engine tests use a fake that replays fixtures.
S13.2 *User agent.* Default UA string is a current desktop-browser UA configured globally
      (setting `indexers.userAgent`); sites that bind session cookies to UA must therefore get a
      stable UA per instance. With FlareSolverr the solved UA overrides the default for that
      host (S14.6). The UA MUST be stable across a process lifetime and persisted per host.
S13.3 *Timeout:* 100 s default for search requests (global setting), 15 s default for login/
      auth requests. The engine passes `timeoutMs`; the transport enforces it
      (`AbortSignal.timeout`). Timeout = transport failure (S16).
S13.4 *Decoding:* decode the body with, in priority, the definition `encoding`... when the
      server's `Content-Type` charset conflicts, the definition wins `[MT]` (sites commonly
      mislabel). JSON is always UTF-8.
S13.5 *Compression:* send `Accept-Encoding: gzip, deflate, br`; handled by the HTTP stack.
S13.6 *Search request lifecycle:*
      1. Attach persisted cookies (if expired -> none).
      2. Execute via transport, with **retry**: up to 2 retries on 5xx or 408 with exponential
         backoff, base = the site's rate delay, with random jitter.
      3. If `isLoggedOut(response)` (S8.17): perform login (S8), replace cookies on the request
         and replay it **once**. Do not loop.
      4. If the response looks like a Cloudflare/DDoS-Guard challenge (S14.5): fail with
         `CloudflareChallenge` (when no FlareSolverr proxy is configured; with one the proxy
         layer already solved it).
      5. HTTP errors: 429 -> `TooManyRequests` (honour `Retry-After`, seconds or HTTP-date);
         5xx -> `HttpServerError`. Other 4xx are passed to the parser only when the definition
         expects them (it does not; they raise).
      6. On any response (even error) merge `Set-Cookie`s into the jar, persist for 30 days.
      7. Parser pre-checks: a redirect is an error: if `Location` contains `login` (case-
         insens.) -> clear cookie jar and fail with "session expired or killed; recheck cookie/
         credentials"; other redirect -> "Redirected to X". Status other than 200 -> error.
S13.7 Cookie jar scope: per instance, name -> value only (no domain/path/expiry attributes);
      sent on every request to the site. This simplification is adequate for the catalogue
      and avoids a cookie-parsing dependency; a cookie set for another host is still sent to
      the site host (acceptable because all requests are to that site).
S13.8 Concurrency: requests for one instance are serialised by the rate limiter; different
      instances run in parallel (global concurrency cap `indexers.maxParallel`, default 8).
S13.9 Caching `[MT]`: identical (instance, URL) search responses may be cached for 60 s to
      absorb bursts (a series search fan-out); stats mark these `cached=1`.
S13.10 Referer: default none for searches; login/download rules as stated. Origin header is
       never added.
S13.11 Logging: request URLs MUST have query keys named `apikey`, `rsskey`, `passkey`, `key`,
       `token`, `pass`, `password`, `torrent_pass` masked. Response bodies are logged only at
       trace level and only when `indexers.logResponses` is on.

---

## 14. Indexer proxies

A *proxy* is a reusable network egress/solver definition attached to indexer instances by
**tags**. Types: `http`, `socks4`, `socks5`, `flaresolverr`.

### 14.1 Config

| type | settings |
|---|---|
| http | `host`, `port` (both required), `username?`, `password?` |
| socks4 | `host`, `port` (required), `username?` (userid), `password?` |
| socks5 | `host`, `port`, `username?`, `password?` |
| flaresolverr | `host` (URL, default `http://localhost:8191/`), `requestTimeout` seconds (1..180, default 60) |

All proxies have `name`, `tags: number[]`. Validation: host non-empty; ports 1..65535;
flaresolverr timeout 1..180.

### 14.2 Selection

S14.1 For each outgoing request of an instance, selected proxies = all configured proxies whose
      tag set **intersects** the instance's tags. Instances without tags use no proxy.
S14.2 At most **one FlareSolverr** and at most **one plain proxy** (http/socks) are applied; if
      several of a kind match, the first by id wins (upstream: first encountered).
S14.3 Order: pre-request hooks run in this order: plain proxy first, then FlareSolverr;
      post-response hooks run in the same order.
S14.4 An instance that is being tested before it is saved (no id) with no tags falls back to
      the first FlareSolverr proxy if one exists, so users can test Cloudflare-protected
      sites during setup. Saved instances need explicit tags.

### 14.3 HTTP / SOCKS

S14.5 The proxy is set on the request (`undici ProxyAgent` for http(s); `socks-proxy-agent`
      style dispatcher for socks4/5 -- new dependency; justify in the PR). Credentials go in
      proxy auth. DNS resolution for socks5 SHOULD be remote (`socks5h` semantics) so the
      site name does not leak locally; socks4 cannot do remote DNS (4a is optional).
S14.6 Proxy failures (connect refused, auth failed) surface as transport failures of the
      indexer (S16, connection-failure class). A "Test proxy" action fetches a known neutral
      URL (configured, default the project's own health endpoint or a public IP-echo; no
      upstream host) through the proxy; 400 is a failure, other statuses are fine.

### 14.4 FlareSolverr

FlareSolverr is a separate service (`/v1` JSON API) that drives a real browser to pass
Cloudflare/DDoS-Guard challenges and returns cookies + the browser's user agent.

S14.7 *Detection (when to involve FlareSolverr).* Upstream strategy: **try the original request
      first** (HTTP errors suppressed), then inspect. A response is a *challenge* when all
      hold: the `Server` header (case-insens.) is `cloudflare`, `cloudflare-nginx` or
      `ddos-guard`; the status is 503 or 403; and the body contains one of the known challenge
      markers: page title "Just a moment...", "Access denied", "Attention Required! |
      Cloudflare", "DDOS-GUARD" (case-insens.), or the entire body is the text
      `error code: 1020`. A second heuristic exists for some old custom setups: header
      `Vary: Accept-Encoding,User-Agent`, no `Content-Encoding`, and body mentions "ddos".
      Treat markers as data in a config list so they can be updated without a code change.
S14.8 *Solve.* POST `{flaresolverrHost}/v1` (trailing slash on host trimmed), JSON body:
      - `cmd`: `request.get` for GET; `request.post` for POST.
      - `url`: the full original URL.
      - `maxTimeout`: `requestTimeout * 1000` (ms).
      - `proxy`: `{url, username?, password?}` when an application-wide outbound proxy is set;
        MT: also pass the instance's selected plain proxy here, since otherwise the solver
        connects directly and gets a different IP than later requests, invalidating the
        clearance cookie.
      - For POST only: `postData` = the urlencoded body string, `headers.ContentType`. Only
        `application/x-www-form-urlencoded` POST is supported; multipart and others ->
        `FlareSolverrError("Unsupported POST Content-Type")`.
      HTTP timeout for this call = `requestTimeout + 5` seconds. Response HTTP status other than
      200 or 500 -> error (FlareSolverr signals solver failures with 500 + `status:"error"`).
S14.9 *Parse solution.* Response JSON: `{status, message, startTimestamp, endTimestamp,
      version, solution:{url,status,response,headers,cookies[{name,value,domain,path,expires,
      httpOnly,secure,sameSite}],userAgent}}`. If `solution.cookies` is missing or empty ->
      `FlareSolverrError("Empty cookies returned by FlareSolverr")`.
S14.10 *Retry with clearance.* Copy `solution.cookies` into the request's cookies (replacing
       same-named), set the `User-Agent` header to `solution.userAgent`, cache that user agent
       per **host** in memory, and **replay the original request ourselves** (we do not use
       the HTML FlareSolverr fetched, so POST bodies, encoding and binary downloads behave
       identically). Return this replay's response.
S14.11 *Reuse.* On later requests to the same host, if a cached UA exists and the request has no
       explicit UA, inject it (the clearance cookie is bound to that UA; mismatches re-trigger
       the challenge). The cookies were merged into the normal jar after the replay (S13.6
       step 6) and thus persist 30 days, which is why a second request does not re-solve.
S14.12 *Sessions.* Upstream does **not** use FlareSolverr sessions: every solve is stateless
       (`sessions.create` is never called) and cookies are carried by our jar. MT: keep this
       model in v1. (A later option is to create a named session per instance to keep one
       browser tab warm; see Open questions.)
S14.13 *Test.* `test(flaresolverr)` POSTs a `request.get` for a harmless URL to `/v1` and
       requires HTTP 200 and parseable JSON; otherwise failure with the exception text.
S14.14 *Failure semantics.* FlareSolverr errors count as indexer failures (S16). A solved page
       that still looks like a challenge on replay -> failure `CloudflareChallenge`.
S14.15 FlareSolverr also runs login POSTs (`application/x-www-form-urlencoded` only). Login
       forms with multipart enctype through FlareSolverr fail upstream; MT: same, with a clear
       message.
S14.16 Security: proxy passwords are write-only in the API; never logged; FlareSolverr's
       returned cookies may contain site session data -> same treatment as cookie jars
       (encrypted at rest if the DB supports it; at minimum excluded from logs and exports).

---

## 15. Rate limiting and limits

### 15.1 Spacing between requests

S15.1 Key = **hostname** of the request URL (not instance id): two instances for the same
      site, or a login and a search, share the budget.
S15.2 Algorithm (token-slot, serialised): maintain `nextSlot[host]`. For a request with
      interval `I`: `slot = max(now, nextSlot[host])`; `nextSlot[host] = slot + I`;
      `sleep(slot - now)`; then send. First request on an idle host goes out immediately.
      Updates must be atomic (single-threaded event loop with synchronous updates suffices).
      The interval for a request = max(global default 2 s, definition `requestDelay`, any
      instance override `[MT]`).
S15.3 Applies to: search requests, login requests (including captcha image, simpleCaptcha),
      download page fetches, the "test link" fetches inside download, and the final download.
      Does NOT apply to FlareSolverr's own `/v1` call (different host) but the replay request
      is rate-limited like any other.
S15.4 Retries (S13.6) re-enter the limiter so the retry also waits.

### 15.2 Query and grab limits (per-instance quotas)

Instance settings (advanced, optional): `queryLimit` (int > 0), `grabLimit` (int > 0),
`limitsUnit` (`day` default | `hour`).

S15.5 *Window.* `day` = trailing 24 h; `hour` = trailing 1 h. A rolling window, **not**
      calendar boundaries.
S15.6 *Counts come from stats events (S17):* queries = `indexer_query` + `indexer_rss`
      events in the window for that instance, **regardless of success** (a failed request
      still burned a request at sites that count attempts). Grabs = `release_grabbed` events.
S15.7 `atQueryLimit(instance)`: `queryLimit` set and `count >= queryLimit`. The registry
      checks it just before dispatching a search to the instance; if true, returns no results
      for it (and notes it in the search diagnostics as `skipped: query_limit`).
      Same for `atGrabLimit` before a grab (the grab then fails with
      `GrabLimitReached(retryAfter)`).
S15.8 `retryAfter` (seconds) when at limit: find the Nth most recent event in the window (N =
      limit; i.e. the oldest event that must expire to bring the count below the limit); result
      = that event's time + window - now (min 0). Exposed in API errors and on the UI.
S15.9 Limits do not by themselves mark the indexer failed or alter backoff. They are
      advertised on the Torznab-facing capabilities/limits `[MT]` only if we later expose
      Torznab.
S15.10 Site-side limits: HTTP 429 (or an "API limit reached" body for dedicated clients) is a
       *backoff* event (S16.4), not a quota.

---

## 16. Indexer status, failure and backoff

State per instance (table `indexer_status`): `initialFailure`, `mostRecentFailure`,
`escalationLevel` (0..9), `disabledTill`, `cookies` (name->value), `cookiesExpiration`,
`lastRssSyncRelease` (cursor, see S16.9).

Escalation table (seconds), indexed by level:

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| disable for | 0 | 1 min | 5 min | 15 min | 30 min | 1 h | 3 h | 6 h | 12 h | 24 h |

S16.1 `isDisabled` = `disabledTill != null && disabledTill > now` (UTC). The registry excludes
      disabled instances from automatic and interactive searches; the UI shows a red badge
      and the remaining time; an explicit "Test" ignores the disabled state.
S16.2 *recordFailure(minimumBackoff = 0, escalate = true):*
      1. `now = utc()`; set `mostRecentFailure = now`.
      2. If `level == 0`: `initialFailure = now`, `level = 1`, `escalate = false` (the first
         failure only sets level 1, it does not also escalate).
      3. `inStartupGrace = process start + 15 min > now`; `inFailureGrace = initialFailure +
         gracePeriod > now` where gracePeriod = **0** for indexers (so never true) and 5 min
         for applications/other kinds.
      4. If `escalate && !inFailureGrace && !inStartupGrace`: `level = min(9, level + 1)`.
      5. If `minimumBackoff > 0`: while `level < 9` and `period(level) < minimumBackoff`:
         `level++`.
      6. If `!inFailureGrace || minimumBackoff > 0`: `disabledTill = now + period(level)`.
      7. If `inStartupGrace && minimumBackoff == 0 && disabledTill != null`: cap `disabledTill`
         at `now + period(2)` (5 min) so a freshly booted app doesn't punish a site for
         start-up network noise.
      8. Persist; publish `indexer_status_changed`.
S16.3 *recordConnectionFailure*: same as recordFailure with `escalate = false`: DNS failure and
      "connection refused" (host unreachable) set `disabledTill` from the *current* level but do
      not increase it. Rationale: our own network being down should not move every indexer up
      the table. Classification: DNS resolution failure and TCP connect failure only; timeouts
      and TLS errors are ordinary failures.
S16.4 *429 / request limit:* `recordFailure(minimumBackoff = Retry-After)`, where Retry-After
      is parsed from the header; if absent or zero -> **1 hour**. Escalates the level until
      its period >= that value.
S16.5 *What counts as a failure (search):* transport errors (timeout, TLS, HTTP stack), HTTP 5xx
      after retries, 429, auth failures (bad credentials / session cannot be re-established),
      login captcha required, parse errors (`IndexerParseError`), unexpected redirects, Cloudflare
      challenge, FlareSolverr errors. A **successful HTTP exchange with zero results is a
      success** (not a failure).
S16.6 *recordSuccess:* if `level == 0` nothing. Else `level -= 1` and `disabledTill = null`
      (note: it clears the disable immediately and only steps down one level, so a flapping
      indexer decays slowly). Called after a search completes without exceptions.
S16.7 Grab-time failures: unexpected exceptions in download (not 404 / not 429 / not HTML-session
      expiry which maps to auth) call `recordFailure`.
S16.8 *Reset:* successful manual Test sets `level = 0`, clears `disabledTill`, `initialFailure`,
      `mostRecentFailure` `[MT]` (upstream only clears via successive successes or deleting the
      indexer). Deleting an instance deletes its status row.
S16.9 *RSS cursor.* `lastRssSyncRelease` stores `{guid, publishDate}` of the newest release seen
      in the last RSS sync; the next RSS sync stops processing once it encounters it. (Used by
      the Phase 1 RSS job; engine does not use it.)
S16.10 Cookie persistence lives in the same status row (S8.2). Clearing cookies on
       "session expired" (S13.6.7) also updates this row.
S16.11 Time handling: all timestamps stored UTC ISO-8601. `disabledTill` comparisons use the
       injected clock to allow deterministic tests.
S16.12 Fixture: failures at t0, t0+2s, ... with startup grace off, no minimum backoff ->
       levels 1,2,3... and disabled for 60 s, 300 s, 900 s... A success then yields level n-1 and
       an enabled indexer. With a 429 and `Retry-After: 7200` from level 0: level becomes 1 on
       the first-failure rule, then raised while period < 7200: levels 2..6 give 300, 900,
       1800, 3600, 10800 -> stops at level 6 (3 h). Result disabled 3 h.
S16.13 Health: a periodic check (15 min) turns every instance with `disabledTill > now` into a
       warning-level health item, and every instance whose definition is missing or broken into
       an error item ("definition removed or invalid").

---

## 17. Per-indexer statistics

Stats are derived from an append-only event log (the same `history` table the Phase 1 history
module needs). Event types and fields:

| event | when | data |
|---|---|---|
| `indexer_query` | any interactive/automatic keyword/ID search request completed or failed | `query` (human string), `queryType`, `categories`, `source` (caller: app/user agent string or module name), `host` (caller host; for in-process use the module name), `elapsedMs`, `cached` (0/1), `limit`, `offset`, `successful` |
| `indexer_rss` | RSS (keyword-less, latest) fetch | same |
| `indexer_auth` | each login attempt | `successful`, `elapsedMs` |
| `release_grabbed` | download of release bytes attempted | `successful`, `elapsedMs`, `title`, `guid`, `source`, `host`, `size` |
| `indexer_caps` | capabilities fetch (Torznab/Newznab) | `successful` |

S17.1 One event per HTTP-level operation: a keyword search that issues 2 search paths writes
      **two** query events (one per request). Auth events do not count as queries.
S17.2 `successful` = false when the request threw (S16.5 classes). Zero results = successful.
S17.3 `elapsedMs` = wall time of the HTTP exchange excluding rate-limit sleeping (measure after
      the slot is acquired). Cached hits (S13.9) record `cached: 1` and elapsed 0.
S17.4 *Aggregates* for a time window `[start, end]` and set of indexer ids (computed on demand
      in SQL, no precomputed tables in v1):
      - `numberOfQueries`, `numberOfFailedQueries` (query events).
      - `numberOfRssQueries`, `numberOfFailedRssQueries`.
      - `numberOfAuthQueries`, `numberOfFailedAuthQueries`.
      - `numberOfGrabs`, `numberOfFailedGrabs`.
      - `averageResponseTime` = mean `elapsedMs` over query+rss events where `elapsedMs > 0`
        and `cached != 1`; 0 if none (integer, truncated).
      - `averageGrabResponseTime` = same over `release_grabbed` events.
S17.5 *Per-caller breakdowns*: group non-auth events by `source` and by `host`, counting
      queries (query+rss) and grabs. In MT these identify which module/profile generated load
      (e.g. `rss-sync`, `series-search`, `interactive`, `request-auto-search`), which is what
      "user agent / host" meant when the \*arrs were external clients.
S17.6 Events for instances that no longer exist are ignored in aggregates (but retained until
      retention).
S17.7 *Retention.* A daily job deletes events older than `history.cleanupDays` (default **30**;
      `0` = keep forever). This bounds both the stats window and the quota windows (S15.5
      windows are shorter than any sane retention). Stats UI presets: 24 h, 7 d, 30 d.
S17.8 API: `GET /api/v1/indexers/stats?start&end&indexerIds=` -> `{indexers:[...], sources:[...],
      hosts:[...]}`; response shapes live in `packages/shared/src/indexers.ts`.
S17.9 Privacy: `query` text may contain what the user searched; stats API requires auth like
      the rest of the API; exports and support bundles redact it.

---

## 18. Application sync (concept) and why Media-Tron drops it

### 18.1 What Prowlarr does

Prowlarr is a *separate* service that holds indexers once and **pushes** them into each
external \*arr app (Sonarr, Radarr, Lidarr, Readarr, Whisparr, Mylar, LazyLibrarian) as
Torznab/Newznab indexers that point back at Prowlarr's own proxy endpoint. Pieces:

- **Application** entity: name, implementation (the target app kind), `prowlarrUrl` (how the
  app reaches Prowlarr), `baseUrl` + `apiKey` of the app, optional basic-auth credentials,
  **sync level**, **tags**, **sync categories**, app-specific toggles.
- **Sync levels:** `Disabled` (nothing happens); `AddOnly` (new indexers are added to the app
  and removed when deleted in Prowlarr, but later edits in Prowlarr are **not** pushed; the
  user may tweak settings in the app); `FullSync` (every change in Prowlarr -- name, priority,
  categories, seed rules, URL, key -- is pushed and **overwrites** remote edits; indexers no
  longer handled are removed remotely).
- **Tag scoping:** if an application has tags, only indexers sharing at least one tag are
  synced to it; with no tags it receives all valid indexers. Indexers with invalid settings are
  never synced.
- **Category scoping:** each app has `syncCategories` (and, for Sonarr, `animeSyncCategories`).
  An indexer is synced only if its capabilities support at least one of them; the pushed
  category list is `supportedCategories(syncCategories)`. Defaults: Sonarr TV 5000, 5010,
  5020, 5030, 5040, 5045, 5050, 5090 and anime 5070; Radarr 2000..2090 (2000, 2010, 2020,
  2030, 2040, 2045, 2050, 2060, 2070, 2080, 2090); Lidarr 3000, 3010, 3030, 3040, 3050, 3060;
  Readarr 3030, 7000..7060; Whisparr 6000, 6010..6090 subset.
- **What is pushed per indexer:** name `"<indexer> (Prowlarr)"`; implementation Torznab or
  Newznab per protocol; `baseUrl = <prowlarrUrl>/<indexerId>/`; `apiPath = /api`; the
  Prowlarr API key; categories; (torrents) `minimumSeeders` (from the indexer's
  `appMinimumSeeders` else the app-sync *profile*), seed ratio, seed time, season-pack seed
  time (falls back to seed time); app toggles: RSS / automatic search / interactive search
  enabled (from the *app sync profile* and the indexer enabled flag); `priority`.
- **App sync profile** (shared object): `enableRss`, `enableAutomaticSearch`,
  `enableInteractiveSearch`, `minimumSeeders`. Each indexer references one.
- **Mapping table** `AppIndexerMap(appId, indexerId, remoteIndexerId, remoteIndexerName)`
  tracks which remote indexer corresponds to which local one. During a sync Prowlarr lists the
  remote app's indexers that point at it and reconciles: unknown remote rows are adopted into
  the map; local indexers without a map entry are added (if enabled and handled); with a map
  entry and FullSync they are updated; with `removeRemote` (full command) map entries whose
  local indexer no longer exists are deleted remotely.
- **Triggers:** indexer added/updated/deleted/bulk-updated; application added/updated; API key
  changed (force full update); manual "Sync App Indexers" command (with optional force); also
  periodic.
- **Failure handling:** per-application status with the same escalation table (S16) but a
  5-minute initial-failure grace; connection failures do not escalate; 429 backs off for at
  least the `Retry-After` or an hour.
- **Torznab proxying:** each \*arr app talks to Prowlarr's `/{id}/api` Torznab-compatible
  endpoint; Prowlarr translates the app's request into the definition's search and returns
  Torznab XML, also masquerading downloads through `/{id}/download`.

### 18.2 What Media-Tron does instead

S18.1 There are no external applications to sync. The indexer **registry** is an in-process
      service; the `releases` module (RSS sync, automatic search, interactive search, requests
      auto-search) calls `registry.search({mediaType, query, categories, purpose})` directly
      and receives `IndexerRelease[]`. No Torznab encoding/decoding, no API keys between
      components, no mapping table, no `(Prowlarr)` suffix, no push, no sync levels, no sync
      failure status.
S18.2 The **parts of app sync that carry real behaviour are preserved** as per-instance /
      per-purpose configuration:
      - *Media-type category scoping*: each instance declares which Torznab categories it will be
        used for per media type (movies: 2000 tree; TV: 5000 tree except 5070; anime:
        5070; ...), defaulting to the Sonarr/Radarr defaults above intersected with what the
        definition supports. Searches for a media type only use instances that support at
        least one of its categories (S7.13). Stored in `indexer_instance.mediaCategories`.
      - *Purpose toggles*: `enableRss`, `enableAutomaticSearch`, `enableInteractiveSearch` per
        instance (replacing the app sync profile; one global default profile plus per-instance
        override).
      - *Priority* (1..50, default 25, lower = preferred) is passed to the decision engine.
      - *Seeding rules* and `minimumSeeders` as per S10.9.
      - *Tags*: instance tags still scope proxies (S14). They MAY additionally scope which
        library items an indexer serves (series/movie tags) `[MT]`: if an item has tags, only
        indexers sharing a tag are used; items without tags use all.
S18.3 Sync-level semantics collapse to nothing: the registry is always "full sync", by
      construction.
S18.4 Optional interoperability, **not** in Phase 2: expose a Torznab endpoint
      (`/api/v1/torznab/{indexerId}/api`) so third-party tools can use our indexers, and
      import indexers from an external Prowlarr/Jackett. Marked Open question.
S18.5 Migration helper `[MT]` (later): read an existing Prowlarr API to import its indexer
      instances (definition file key, settings, tags, priority, app profile flags) so a user's
      private-tracker credentials do not have to be re-entered.

---

## 19. Implementation notes for Media-Tron

Suggested layout:

```
packages/indexers/src/
  cardigann/
    schema.ts          Zod schema for the YAML after normalisation (S2); error codes
    load.ts            YAML -> normalised Definition (case-insensitive keys, duplicate-key
                       preservation for fields, defaults, search.path sugar, login.method default)
    validate.ts        load-time static checks incl. template variable and filter validation
    template.ts        parse + evaluate templates (S4); AST based; pure
    filters.ts         filter registry (S6); each filter = (value, args, ctx) => string
    dates.ts           Go layout parser, timeago, fuzzytime (S6.2-6.5); injected clock
    numbers.ts         lenient number + size parsing (S10.4)
    selectors.ts       html/xml (css) + json path selector evaluation (S5)
    categories.ts      CategoryMap: tracker<->torznab, custom ids, tree, expansion (S7)
    caps.ts            search modes validation (S7.1-7.2)
    login.ts           login methods and captcha (S8)
    request.ts         search request builder: queries -> requests (S9)
    parse.ts           response -> rows -> fields -> raw release (S9, S10)
    download.ts        download block resolver (S11)
    engine.ts          CardigannIndexer: login-if-needed, search, test, download façade
  torznab/ newznab/    Phase 1 clients
  transport/
    http.ts            fetch/undici wrapper: encoding, cookies, redirects
    rate-limit.ts      host slot limiter (S15.2)
    proxy.ts           selection + http/socks agents (S14.1-S14.6)
    flaresolverr.ts    client + detection (S14.7-S14.15)
  categories-standard.ts  the Torznab category table (Appendix A)
  index.ts

apps/api/src/modules/indexers/
  schema.ts        tables: indexer_instance, indexer_status, indexer_proxy, (history events live in history)
  service.ts       registry: enable/disable, search fan-out, filters, limits, status writes
  status.ts        escalation (S16), pure functions + persistence adapter
  stats.ts         aggregates (S17)
  limits.ts        query/grab quotas (S15.5-S15.8)
  routes.ts        /api/v1/indexers, /indexer-proxies, /indexer-definitions, /indexers/stats
  jobs.ts          health check, history cleanup, status decay
```

Recommended libraries (all would need a justification line in the commit, per CONVENTIONS):
`yaml` (supports YAML 1.2, preserves duplicate keys with `uniqueKeys:false`, parsed to
`Document`), `css-select` + `htmlparser2` or `linkedom` (need `:has`, `:not`, `matches`), a JSON
path implementation (write a ~100 line evaluator for the subset in S5.4 rather than depend on
a full JSONPath library), `undici` (ProxyAgent), `socks` agent. Avoid heavy browsers or DOM
shims (jsdom) -- speed matters when parsing 100 rows x 20 fields per search.

Design decisions:

S19.1 Engine functions are pure given a `Transport` and `Clock`; the DB-backed parts (cookie
      store, status, stats) are passed in as interfaces (`CookieStore`, `StatusSink`).
S19.2 Compile definitions once: parse templates, filters, CSS selectors into an immutable
      `CompiledDefinition`; cache by `(id, mtime)`.
S19.3 Errors are typed: `DefinitionError`, `LoginFailed` (IndexerAuthError), `TransportError`,
      `TooManyRequests`, `CloudflareChallenge`, `FlareSolverrError`, `ParseError`,
      `GrabLimitReached`, `ReleaseUnavailable`. The registry maps each to a status action in
      one place (S16.5).
S19.4 Never log/emit secrets (S3.4, S13.11, S14.16). Store credentials encrypted with a key
      from `/config` if available; at minimum never return them from GET endpoints.
S19.5 Search fan-out uses `Promise.allSettled` with per-indexer timeout; one slow site never
      blocks others; results merged, then sorted by the decision engine, not by the registry.
S19.6 Test the engine with **recorded-response fixtures** under `packages/indexers/fixtures/`:
      one definition + one `*.html`/`*.json` response + expected `releases.json` per case.
      See Appendix C for the minimum set.
S19.7 Dropped / not ported from upstream:
      - the remote definition catalogue download + SHA-based "outdated definition" health
        check (replace later by a signed bundle, Open questions);
      - the `*arr` application sync stack (S18) and Torznab server;
      - Jackett-compat flags that are no-ops (`certificates`, `ratio`, `Query.Extended/APIKey`
        variables, `search.error` as upstream ignores it) -- parse, warn, ignore;
      - `multipart` login via FlareSolverr (unsupported upstream);
      - the staged-regex template evaluator (use a real parser);
      - select-by-index storage (S3.3);
      - local-time date interpretation (S6.3);
      - the odd "Peers = seeders + leechers" double-count when both modifiers appear twice
        (S10.3 note: recompute `peers = seeders + leechers` after row parse instead).
S19.8 Performance targets: parse 100 rows in < 50 ms; template compile once; no per-row regex
      construction (cache compiled `RegExp` by pattern+flags).
S19.9 Where to put new definitions: `packages/indexers/definitions/*.yml` (bundled). Start with a
      small set (4-6): one public HTML site, one public JSON-API site, one private form-login
      site (using a fabricated fixture, not a real tracker), one cookie-login site, one
      FlareSolverr-needed site. Real-site definitions are added by users or later phases.
S19.10 Security: the engine fetches URLs derived from site HTML (details, download links); the
       transport MUST refuse requests to link-local / loopback / private ranges unless the
       definition's own `links` host is in that range or `indexers.allowPrivateNetworks` is on,
       to stop a malicious definition/site from probing the user's LAN (SSRF). Definitions are
       treated as untrusted input: no file access, no code, bounded regex execution
       (timeout/size cap; recommend `re2`-style linear engine or guard with length limits), YAML
       aliases/anchors limited (billion-laughs cap).

---

## 20. Open questions

1. **Remote catalogue.** Upstream downloads a versioned definition package from a hosted
   catalogue and checks "outdated definition" via hashes. Do we host/consume anything? Proposal
   for Phase 2: bundled + user dir only; evaluate a signed community bundle later.
2. **Definition licensing/compatibility.** The Cardigann/Jackett/Prowlarr definition catalogue
   has its own licence; before bundling real site definitions, confirm terms (we may ship
   only our own authored definitions plus the loader).
3. **Duplicate YAML keys** (repeated `title`, `category`). Must we guarantee import of existing
   catalogue files unchanged? That forces a duplicate-preserving parser (S10.1).
4. **Default timezone** for zone-less dates: UTC (proposed) vs. a per-instance setting. Many
   sites show local time of the server; a `timezone:` key `[MT]` is proposed but unproven.
5. **FlareSolverr sessions.** Worth adopting named sessions to reduce solve latency/load?
   Upstream is stateless. Also unknown: whether to forward instance proxies to FlareSolverr
   (S14.8 proposes yes).
6. **Cookie jar fidelity.** Name->value only (S13.7) vs. full RFC 6265 jar with domain/path/
   expiry. Some sites set cookies on subdomains.
7. **Pagination.** Engine returns one page per path. Do we need multi-page deep search for
   interactive search? Impact on rate limits and `limits.max`.
8. **Escalation after reset on test** (S16.8) and **per-failure-class tuning** (e.g. 5xx vs.
   auth). Upstream treats them uniformly except connection failures and 429.
9. **Query limit counting.** Count failed queries against the quota (S15.6, as upstream)? Some
   sites count only successful requests.
10. **Category mapping defaults per media type** (S18.2) vs. letting users pick per instance;
    how anime is routed (5070 only vs. also 5000 tree).
11. **`andmatch` heuristic** (S10.10) is a crude two-term rule; maybe replace with the Phase 1
    parser's title matching for all indexers instead of per-definition.
12. **Torznab server / Prowlarr import** (S18.4-S18.5) -- scope and phase.
13. **Regex dialect**: JS (ECMAScript) vs .NET differences (lookbehind variable length,
    atomic groups, named group syntax). We chose to reject unsupported constructs at load;
    need a sample of real-world definitions to size the gap.
14. **Seeding-rule precedence** (S10.9): instance override beats tracker-provided minimums?
    A hit-and-run rule violation is costly on private trackers, so perhaps the larger of the
    two should win.
15. **Release `date` fallback** (S10.13) behaviour in RSS dedupe cursors.
16. **Undetermined from upstream reading:** the exact HTTP stack defaults (global request
    timeout value, default User-Agent string, TLS validation toggles, cookie jar internals) live
    in the common HTTP library and were not fully traced; values in S13.2-S13.3 are
    recommendations, not verified upstream constants. The "indexer disabled by status" check
    lives in the factory (`GetBlockedProviders`) as described; the exact UI health strings
    were not reviewed.

---

## Appendix A. Standard Torznab categories

Parent (x000) with children. Names are the strings used in `cat:`.

| id | name | id | name |
|---|---|---|---|
| 0 | Other | 10 / 20 | Other/Misc, Other/Hashed |
| 1000 | Console | 1010 NDS, 1020 PSP, 1030 Wii, 1040 XBox, 1050 XBox 360, 1060 Wiiware, 1070 XBox 360 DLC, 1080 PS3, 1090 Other, 1110 3DS, 1120 PS Vita, 1130 WiiU, 1140 XBox One, 1180 PS4 | `Console/<x>` |
| 2000 | Movies | 2010 Foreign, 2020 Other, 2030 SD, 2040 HD, 2045 UHD, 2050 BluRay, 2060 3D, 2070 DVD, 2080 WEB-DL, 2090 x265 | `Movies/<x>` |
| 3000 | Audio | 3010 MP3, 3020 Video, 3030 Audiobook, 3040 Lossless, 3050 Other, 3060 Foreign | `Audio/<x>` |
| 4000 | PC | 4010 0day, 4020 ISO, 4030 Mac, 4040 Mobile-Other, 4050 Games, 4060 Mobile-iOS, 4070 Mobile-Android | `PC/<x>` |
| 5000 | TV | 5010 WEB-DL, 5020 Foreign, 5030 SD, 5040 HD, 5045 UHD, 5050 Other, 5060 Sport, 5070 Anime, 5080 Documentary, 5090 x265 | `TV/<x>` |
| 6000 | XXX | 6010 DVD, 6020 WMV, 6030 XviD, 6040 x264, 6045 UHD, 6050 Pack, 6060 ImageSet, 6070 Other, 6080 SD, 6090 WEB-DL | `XXX/<x>` |
| 7000 | Books | 7010 Mags, 7020 EBook, 7030 Comics, 7040 Technical, 7050 Other, 7060 Foreign | `Books/<x>` |
| 8000 | Other | 8010 Misc, 8020 Hashed | `Other/<x>` |

Note the real names contain these exact spellings (`Console/XBox 360`, `Console/PS Vita`,
`PC/Mobile-iOS`, `TV/WEB-DL`, `Movies/BluRay`, `Movies/x265`). Parent names are bare (`TV`).

## Appendix B. Compact complete example (JSON API site, public)

```yaml
id: demoapi
name: DemoAPI
description: Fictional public JSON tracker used in tests
language: en-US
type: public
encoding: UTF-8
links: ["https://demoapi.example/"]
caps:
  categorymappings:
    - {id: 205, cat: Movies/HD, desc: "HD Movies"}
    - {id: 208, cat: TV/HD,     desc: "HD TV", default: true}
    - {id: 209, cat: TV/Anime,  desc: "Anime"}
  modes:
    search: [q]
    tv-search: [q, season, ep, imdbid]
    movie-search: [q, imdbid]
settings:
  - {name: sort, type: select, label: Sort, default: seeds, options: {seeds: Seeders, added: Date}}
search:
  paths:
    - path: "api/q.php"
      response: {type: json, noResultsMessage: "No results"}
  inputs:
    q: "{{ if .Query.IMDBID }}{{ .Query.IMDBID }}{{ else }}{{ .Keywords }}{{ end }}"
    cat: "{{ join .Categories \",\" }}"
    sort: "{{ .Config.sort }}"
  keywordsfilters:
    - {name: re_replace, args: ["[^\\w ]+", " "]}
    - {name: trim}
  rows: {selector: "results"}
  fields:
    category: {selector: cat}
    title: {selector: name}
    details: {selector: id, filters: [{name: prepend, args: "d.php?id="}]}
    download:
      selector: hash
      filters: [{name: prepend, args: "magnet:?xt=urn:btih:"}]
    infohash: {selector: hash}
    size: {selector: size}                    # bytes as number
    seeders: {selector: seeders}
    leechers: {selector: leechers}
    date: {selector: added}                   # unix seconds
    imdb: {selector: imdb, optional: true}
    downloadvolumefactor: {text: 1}
    uploadvolumefactor: {text: 1}
```

With keywords `my show s01e02`, categories `5040` this issues (conceptually):
`GET https://demoapi.example/api/q.php?q=my+show+s01e02&cat=208&sort=seeds`.
A 200 body `[]`-less `{"results":[...]}` yields rows; body `No results` yields zero results.
(A bare `[...]` top-level array would use `rows: {selector: ""}`... which is not a valid row
selector; authors wrap with `$` -> the empty selector rule S5.4 means "root".)

## Appendix C. Minimum fixture set

1. Template evaluation: `range` with and without index; `join`; `re_replace`; `if/else`
   truthiness of `.True`, `.False`, empty string, `"0"`; `and/or/eq/ne` nesting; `.Today.Year`;
   missing variable renders empty; value encoding in paths.
2. Number/size: `"1,234"` -> 1234; `"1.234"` int -> 1234; `"1.234,5"` decimal -> 1234.5;
   `"1.5 GB"`; `"700 MiB"`; `"12 kb"`; `"-"` -> 0; `" 4 "` -> 4; seeders `9999999` -> 0.
3. Dates: Go layouts (`2006-01-02 15:04:05`, `02 Jan 2006`, `Jan 2, 2006 3:04 PM`, with
   `Z07:00`); timeago (`2 hours 1 day ago`, `1.5h`, `3 weeks`, `now`); fuzzytime (`today at
   14:05`, `yesterday`, `Saturday at 14:22`, `05-17 10:30`, `17 May 10:30`, Unix seconds).
4. Category mapping: parent expansion, custom id numeric (`12 -> 100012`) and hashed (stable
   across runs), unmapped default categories, per-path narrowing and `!` negation.
5. HTML rows with `after: 1`; `dateheaders`; `case` selectors; `remove`; optional fields;
   `title|append`; relative link resolution against the search URL.
6. JSON rows: `:has`, `:not`, `attribute`+`multiple`, `..` row-root selectors, `count` zero,
   `noResultsMessage`.
7. Login: form with hidden CSRF input + `selectorinputs`; `post`; `cookie`; `get`; `oneurl`;
   error block; simpleCaptcha script; multipart enctype; relogin on redirect, replay once.
8. Download: `selectors` fallback order with a bad-first-link (first byte not `d`),
   `before.pathselector`, `infohash`, HTML-instead-of-torrent error, 404, redirect to magnet.
9. Backoff: the S16.12 sequences with fake clock; startup-grace capping; 429 with Retry-After;
   connection failure not escalating; success decay.
10. Proxy: selection by tag (single plain + single FlareSolverr, order), FlareSolverr request
    body shape for GET and urlencoded POST, challenge detection table, empty-cookie error.
11. Rate limiter: three parallel requests on one host with `I = 2 s` leave at 0, 2, 4 s; two
    hosts independent; `requestDelay` greater than default wins.
12. Limits: query/grab windows (hour vs day), `retryAfter` calculation with the Nth oldest event.

## Appendix D. Template fixtures (data)

| template | context | expected |
|---|---|---|
| `{{ range .Categories}}&c[]={{.}}{{end}}` | Categories = [tv, movies] | `&c[]=tv&c[]=movies` |
| `{{ range $i, $e := .Categories}}&c[{{$i}}]={{.}}{{end}}` | same | `&c[0]=tv&c[1]=movies` |
| `{{ join .Categories ", " }}` | same | `tv, movies` |
| `{{ re_replace .Query.Keywords "[^a-zA-Z0-9]+" "%" }}` | Keywords = `abc def` | `abc%def` |
| `{{ if .False }}0{{else}}1{{end}}` | | `1` |
| `{{ if .True }}0{{else}}1{{end}}` | | `0` |
| `{{ .Today.Year }}` | | current year |
| `{{ if and (eq .Config.mode "hd") .Config.fl }}A{{else}}B{{end}}` | mode=hd, fl=True | `A` |
| `{{ if or .Config.a .Config.b }}X{{else}}Y{{end}}` | a=null, b="" | `Y` |
