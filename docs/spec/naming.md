# Spec: File and Folder Naming (Organizer)

Behaviour specification for the Arclight `organizer` module's name builder. Derived from
reading the upstream Sonarr and Radarr `Organizer/` code. It is written so that an engineer
can implement it without reading upstream. Rules are numbered; examples are worked by hand
from the rules. "Sonarr" means TV behaviour, "Radarr" means movie behaviour; where they
differ it is marked **[TV]** or **[Movie]**. Unmarked rules apply to both.

Arclight treats TV and movies as one pipeline, so the token engine (section 2) is one
implementation with two token catalogues (sections 5 and 6).

---

## 1. Concepts and configuration

### 1.1 Naming configuration

1.1.1 One naming configuration exists per installation (not per series/movie).

1.1.2 **[TV]** fields and upstream defaults:

| Field | Default |
|---|---|
| rename episodes | **off** |
| replace illegal characters | on |
| colon replacement format | Smart |
| custom colon replacement text | empty |
| multi-episode style | Prefixed Range |
| standard episode format | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` |
| daily episode format | `{Series Title} - {Air-Date} - {Episode Title} {Quality Full}` |
| anime episode format | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` |
| series folder format | `{Series Title}` |
| season folder format | `Season {season}` |
| specials folder format | `Specials` |

1.1.3 **[Movie]** fields and upstream defaults:

| Field | Default |
|---|---|
| rename movies | **off** |
| replace illegal characters | on |
| colon replacement format | Smart |
| movie file format | `{Movie Title} ({Release Year}) {Quality Full}` |
| movie folder format | `{Movie Title} ({Release Year})` |

Movies have no custom colon text and no multi-episode style.

1.1.4 A "format" (pattern) is a string of literal text and `{tokens}`. Literal text is copied
through unchanged (it is never run through illegal-character replacement; validation, 9.x,
is what keeps it safe).

1.1.5 Arclight may ship better defaults than upstream (for example rename on), but the
semantics below must be identical for any given configuration. Keep the upstream default
strings available as a "reset to default" preset.

### 1.2 Entry points

The builder exposes: file name for an episode file or movie file; file path (folder + name +
extension); series folder / movie folder; season folder and season path **[TV]**; "requires
episode title" and "requires absolute number" predicates **[TV]**; and a sample renderer for
previews and validation (section 10). The builder is a pure function of (naming config,
library item, file record, custom-format list, media-info); its only side effect is
re-probing stale media-info (7.9).

---

## 2. The token engine (shared)

### 2.1 Token syntax

2.1.1 A token is written in braces: `{Series Title}`. Inside the braces, in order:
 1. optional **prefix**: any run of the characters space, dot, dash, underscore, `[`, `(`;
 2. the **token name**: one word of letters/digits, or two such words joined by a
    **separator** (a run of space, dot, dash or underscore). Never more than two words;
 3. optional **modifier**: a colon followed by a modifier string (2.5);
 4. optional **suffix**: any run of space, dot, dash, underscore, `)`, `]`.

2.1.2 Examples of well-formed tokens: `{Series Title}`, `{Series.Title}`, `{series_title}`,
`{-Release Group}`, `{[Quality Title]}`, `{Series Title:30}`, `{MediaInfo AudioLanguages:EN+DE}`,
`{season:00}`, `{ Release Group}`.

2.1.3 **[Movie]** additionally allows the prefix to start with extra `{` and the suffix to end
with an extra `}` so that wrapper constructs like `{edition-{Edition Tags}}` and
`{imdb-{ImdbId}}` are parsed as a single token (see 6.4). The modifier may also contain
`|` (language list).

2.1.4 **[TV]** supports brace escaping: `{{` outputs a literal `{`, and `}}` outputs a literal
`}`. **[Movie]** has no escaping (the wrapper syntax of 2.1.3 replaces it).

2.1.5 Anything in braces that does not parse as a token is literal text.

### 2.2 Token lookup

2.2.1 Token names are matched **ignoring case and ignoring every non-alphanumeric
character**. `{Series Title}`, `{series.title}`, `{SERIES_TITLE}`, `{Series-Title}` all hit the
same handler. `{Air Date}`, `{Air-Date}` and `{Air.Date}` are the same token.

2.2.2 A well-formed token whose name has no handler renders as **empty text** (it vanishes).
It is not an error.

2.2.3 A handler may be registered only conditionally (for example `{MediaInfo Video}` only
exists when the file has media-info; `{Edition Tags}` only when the movie file has an
edition). An unregistered token behaves as in 2.2.2.

### 2.3 Rendering one token

For each token match, in this order:

1. Ask the handler for text. The handler receives the prefix, separator, suffix and modifier.
2. **[TV]** If the handler signals "not resolved yet" (used only for episode titles during the
   first length-measuring pass, 4.8) leave the original token text in place.
3. Trim whitespace from the text.
4. **Case rule** (2.4).
5. **Separator rule**: if the token name contained a separator that is not blank
   (dot, dash, underscore), every space inside the value is replaced by that separator.
   A blank (space) separator changes nothing.
6. **Illegal-character cleaning** of the value (section 3).
7. If the cleaned value is not empty or whitespace, wrap it: prefix + value + suffix.
   If it is empty, the whole token **including its prefix and suffix disappears**.
   **[Movie]** wrapper tag (2.1.3) is also emitted before the prefix when non-empty.

2.3.1 Consequence of step 7: prefix/suffix make optional decorations. `{ - Release Group}`
renders ` - GROUP` when a group exists and nothing otherwise; `{[Quality Title]}` renders
`[WEBDL-1080p]` or nothing.

### 2.4 Case rule

2.4.1 Inspect only the letters of the token **name** as written in the pattern:
 - all letters lower-case (`{series title}`) -> value lower-cased;
 - all letters upper-case (`{SERIES TITLE}`) -> value upper-cased;
 - mixed case (normal `{Series Title}`) -> value unchanged.

2.4.3 Example: `{series title}` for "The Wire" -> `the wire`; `{SERIES.TITLE}` -> `THE.WIRE`.

### 2.5 Modifiers (the part after the colon)

The meaning depends on the token family.

2.5.1 **Text tokens (titles, release group, collection, edition tags, original title):**
a signed integer is a **maximum length**.
 - Positive N: if the text is longer than N characters, keep the first N-3 characters, strip
   trailing spaces/dots from the kept part, append an ellipsis.
 - Negative N (written `-N`): if longer than |N|, output an ellipsis followed by the **last**
   |N|-3 characters (leading end cut, trailing spaces/dots stripped).
 - 0, absent, non-numeric, or text not longer than |N|: unchanged.
 - Empty or whitespace-only text always yields empty.

2.5.2 Example: title "Game of Thrones", `{Series Title:10}` -> `Game of...` (7 chars + ellipsis).
`{Series Title:-10}` -> `...Thrones`. `{Series Title:30}` -> unchanged.

2.5.3 The ellipsis produced by truncation is held as a protected placeholder through the
clean-up passes (4.9) and only becomes three literal dots at the very end. This is what
stops dot-trimming and separator-collapsing from eating it. A literal `...` typed in a pattern
is protected the same way (**[TV]**).

2.5.4 **Number tokens** (`season`, `episode`, `absolute`): the modifier is a zero-padding
width written as zeros. `00` = at least two digits, `000` = at least three; no modifier = no
padding. Season 1 with `{season:00}` -> `01`; with `{season}` -> `1`.

2.5.5 **Language tokens** (`MediaInfo AudioLanguages`, etc.): modifier is a language filter
(7.6).

2.5.6 **Custom Formats tokens:** modifier is a filter (7.8). `{Custom Format:Name}` takes a
single format name.

2.5.7 **[Movie]** `{Movie Title}` and `{Movie CleanTitle}`: a modifier made of two-/three-letter
language codes separated by `|` selects a **translated title** (6.2). Such a modifier is not a
length, so no truncation happens (the title is left whole).

### 2.6 Splitting a pattern into path components

2.6.1 Episode/movie **file** formats are split on both `/` and `\`. Empty segments are
dropped. Each segment is rendered independently (its own clean-up, 4.9) and then the segments
are joined with the platform path separator. This lets users have a folder level inside the
file format, e.g. `{Series Title}/Season {season:00}/{Series Title} - S{season:00}E{episode:00}`.

2.6.2 **[Movie]** the same split applies to the movie **folder** format. A segment that
renders empty is dropped.

2.6.3 **[TV]** series folder and season folder formats are rendered as a whole (no splitting
into dropped-if-empty segments). A series folder format containing a slash yields a nested
folder (e.g. a first-letter folder: `{Series TitleFirstCharacter}/{Series Title}`); treat
both slash styles as separators and normalise to one when storing paths.

### 2.7 Reserved device names

2.7.1 After rendering, if a path component **begins with** one of `aux`, `com1`-`com9`, `con`,
`lpt1`-`lpt9`, `nul`, `prn` (any case) **immediately followed by a dot**, that dot is replaced
by an underscore. Example: `Con.Air (1997)` -> `Con_Air (1997)`. Applied to every component
before the extension is appended.

---

## 3. Illegal characters and colons

3.1 Cleaning is applied to **each token value** (step 6 of 2.3), never to the literal text of
the pattern. It is also applied to the "original title" values and, once more, to season-folder
names built from the season format (**[TV]**, 5.12).

3.2 **Colon handling** (first, on the value):

| Replace illegal chars | Colon format | Colon becomes |
|---|---|---|
| off | (ignored) | removed |
| on | Delete | removed |
| on | Dash | `-` |
| on | Space Dash | ` -` (space, dash) |
| on | Space Dash Space | ` - ` |
| on | Smart | a colon followed by a space becomes ` - `; a bare colon becomes `-` |
| on | Custom **[TV only]** | the configured custom text (must not contain colon or any illegal character) |

3.3 **Other illegal characters** (after colons):

| Character | Replace on | Replace off |
|---|---|---|
| `\` | `+` | removed |
| `/` | `+` | removed |
| `<` | removed | removed |
| `>` | removed | removed |
| `?` | `!` | removed |
| `*` | `-` | removed |
| `|` | removed | removed |
| `"` | removed | removed |

3.4 Finally the value has leading spaces and dots removed and trailing spaces removed.

3.5 Examples with Smart (default): `Star Trek: Voyager` -> `Star Trek - Voyager`;
`Mission:Impossible` -> `Mission-Impossible`; `Who? What*` -> `Who! What-`. With Delete:
`Star Trek: Voyager` -> `Star Trek Voyager`. With Space Dash: `Star Trek: Voyager` ->
`Star Trek - Voyager` (colon becomes " -" and the existing space follows). With Dash:
`Star Trek: Voyager` -> `Star Trek- Voyager`. With Space Dash Space: `Star Trek:  Voyager`
-> two spaces collapse later (4.9) -> `Star Trek - Voyager`; with a title like `A: B` ->
`A -  B` -> collapses to `A - B`.

---

## 4. Assembly of a file name

### 4.1 Pre-flight **[TV]**

4.1.1 If "rename episodes" is **off**, the file name is the file's **original title** (8.1) plus
the extension. No pattern is used.

4.1.2 **[Movie]** If "rename movies" is off the result is the original title (8.1, with
fallback to the current file name always allowed). **No extension is added by the builder**
here; the caller appends it.

4.1.3 If renaming is on and the pattern needed for this item is empty/whitespace, raise a
naming-format error ("Standard episode format cannot be empty" / "Daily ..." / "Anime ..." /
"Standard movie format cannot be empty"). Only the pattern relevant to this item type is
checked.

### 4.2 Choosing the pattern **[TV]**

4.2.1 Episodes are sorted by season, then episode number before anything else.

4.2.2 Default pattern = standard format.

4.2.3 If the series type is **Daily** *and the first episode's season is greater than 0*, use
the daily format. (Specials, season 0, of a daily show use the standard format.)

4.2.4 If the series type is **Anime** and (every episode has an absolute number **or** the anime
format does not contain an absolute token), use the anime format. Otherwise the standard format
is used. Rationale: an anime format that depends on absolute numbers must not be used for an
episode that has none.

### 4.3 Order of work per path component

For each slash-separated component:

1. Detect the **season/episode numbering patterns** (4.4) and **absolute patterns** (4.6) and
   replace each with a synthetic token; fill in `{Season}`, `{Episode}`, `{Absolute}`.
2. Protect literal `...`.
3. Refresh media-info if the pattern needs fields the stored media-info is too old for (7.9).
4. Register series/movie, id, episode, file, quality, media-info and custom-format handlers.
5. First rendering pass with episode-title tokens held back (4.8). Trim.
6. Compute the maximum length available for the episode title (4.8).
7. Second pass, now with episode titles.
8. Clean-up (4.9), restore ellipsis, reserved device names (2.7).

Movies use the same steps 3, 4, 5(single pass), 8 without the episode specifics.

### 4.4 Season/episode numbering pattern **[TV]**

4.4.1 The **numbering pattern** is the substring of the format that looks like: optional letter
`S`, a `{season...}` token, an optional single separator character (space, dot, dash,
underscore) followed by the letter `E` or `X` (any case), then an `{episode...}` token.
Examples that match: `S{season:00}E{episode:00}`, `{season}x{episode:00}`,
`s{season:00}.e{episode:00}`, `S{season:00} E{episode:00}`.

4.4.2 Also captured: the run of separator characters **immediately before it if it follows a
closing brace** and the run **immediately after it if a token follows**. Call this the
**surrounding separator**. If the trailing run exists it wins; otherwise the leading run is
used; otherwise it is empty. In the default format ` - ` on both sides, the surrounding
separator is ` - `.

4.4.4 For each numbering pattern, the output is computed from the multi-episode style
(4.5) and substituted for the pattern. The pattern's own surrounding text stays.

4.4.5 The standalone tokens `{season}` and `{episode}` (outside a recognised pattern) still
work: `{Season}` is the first episode's season number; `{Episode}` with several episodes is
`first-last` using the modifier padding for each (`{episode:00}` with episodes 1,2,3 -> `01-03`),
with one episode just the number.

### 4.5 Multi-episode styles **[TV]**

Let the numbering pattern be `S{season:00}E{episode:00}`; "episode separator" is the letter
(with its optional separator char) between season and episode, here `E`; "surrounding
separator" is as 4.4.2. The first episode always renders as the full pattern. Subsequent
episodes add text per style. With episodes 1, 2, 3 of season 1 and padding `00`:

| # | Style | Rule for episodes after the first | Result |
|---|---|---|---|
| 0 | **Extend** | `-` + episode number only | `S01E01-02-03` |
| 1 | **Duplicate** | surrounding separator + the entire numbering pattern again | `S01E01 - S01E02 - S01E03` |
| 2 | **Repeat** | episode separator + episode number | `S01E01E02E03` |
| 3 | **Scene** | `-` + episode separator + episode number | `S01E01-E02-E03` |
| 5 | **Prefixed Range** (default) | only first and last: `-` + episode separator + episode number | `S01E01-E03` |

4.5.1 Range and Prefixed Range with exactly two episodes show both: `S01E01-E02`. With one
episode all styles degrade to the plain pattern `S01E01`.

4.5.4 Episode numbers inside later repetitions use the pattern's own padding. Season is the
**first** episode's season only; episodes from different seasons in one file are not handled
(they would show the first season).

4.5.5 Full file name example, defaults, series "The Series Title's!", episodes 1-3 titled
"Episode Title (1)/(2)/(3)", WEBDL-1080p revision 2:
`The Series Title's! - S01E01-E03 - Episode Title WEBDL-1080p Proper`.
Changing style to Extend: `... - S01E01-02-03 - ...`. To Duplicate:
`The Series Title's! - S01E01 - S01E02 - S01E03 - Episode Title WEBDL-1080p Proper`.

### 4.6 Absolute episode pattern **[TV]**

4.6.1 The absolute pattern is a `{absolute...}` token with the same optional surrounding
separators as 4.4.2. If the surrounding separator is blank-only (e.g. a single space) it is
treated as `-`.

4.6.2 The pattern is only substituted when the series type is **Anime** and **every** episode
in the file has an absolute number. Otherwise the token text (and nothing around it) is
**deleted**, leaving the neighbouring literal text (so the clean-up of 4.9 matters).

4.6.3 Style behaviour with absolute numbers 1, 2, 3 and padding `000`:

| Style | Result |
|---|---|
| Extend | `001-002-003` |
| Duplicate | `001 - 002 - 003` (surrounding separator repeated before each) |
| Repeat | `001-002-003` (the surrounding separator trimmed; `-`.. if it trims to blank, a single space is used) |
| Scene | `001-002-003` |
| Range and Prefixed Range | `001-003` (first and last) |

4.6.4 Example anime format `{Series Title} - S{season:00}E{episode:00} - {absolute:000} -
{Episode Title} {Quality Full}` for a single episode, absolute 1:
`The Series Title's! - S01E01 - 001 - Episode Title (1) WEBDL-1080p v2`  (anime shows
"v2" instead of "Proper", see 7.2).

### 4.7 Air date **[TV]**

4.7.1 `{Air Date}` (any of the equivalent spellings) is the **first** episode's air date as
`YYYY MM DD` (dashes of the stored `YYYY-MM-DD` replaced by spaces), so that the separator
rule (2.3 step 5) turns it into the user's preferred form: `{Air-Date}` -> `2013-10-30`,
`{Air.Date}` -> `2013.10.30`, `{Air Date}` -> `2013 10 30`.

4.7.2 If the episode has no air date: the value is `Unknown`.

4.7.3 Multi-episode daily files use only the first episode's date.

### 4.8 Episode title budget and multi-episode titles **[TV]**

4.8.1 **Single episode:** the title is the stored title with trailing spaces, dots and `?`
removed.

4.8.2 **Several episodes:** each title is trimmed as above, then a trailing multipart marker
is removed: a trailing `(N)`, or `Part N` / `Pt N` / `Pt. N` (with or without a leading
colon/space), where N is digits. Titles are then de-duplicated, preserving order. If the result
would be all blank, the un-stripped titles (de-duplicated) are used instead.

4.8.3 The remaining titles are joined with ` + ` for `{Episode Title}` and with ` and ` for
`{Episode CleanTitle}` (the clean variant also applies the "clean title" transform, 5.2).
Examples: titles "Pilot (1)" and "Pilot (2)" -> `Pilot`. Titles "The Beginning" and
"The End" -> `The Beginning + The End`, clean `The Beginning and The End`.

4.8.4 **Length budget.** All other tokens are rendered first. The space available for the episode
title is: the smaller of the maximum file-name length (255 **bytes**, configurable) and the
remaining total path length (platform limit minus the season-folder path length minus 1);
minus, for the **last** component only, the byte length of the extension; minus the byte length
of everything else in the component (the pattern with episode-title tokens replaced by the
empty string, any ellipsis counted as three dots). All lengths are **UTF-8 bytes**, not
characters.

4.8.6 Fitting rule, with budget B and titles list:
 1. If the joined text fits in B bytes, use it.
 2. Else, with two or more titles, if `first title + ellipsis + last title` fits (first
    title right-trimmed of spaces/dots; ellipsis counts 3 bytes), use that.
 3. Else, with two or more titles, if `first title + ellipsis` fits, use it.
 4. Else, a single title that fits is used as-is.
 5. Else, the first title is cut to B-3 bytes, right-trimmed of spaces/dots, followed by an
    ellipsis.

### 4.9 Clean-up after rendering a component

4.9.1 Trim whitespace at both ends.

4.9.2 **Collapse repeated separators**: any run of the *same* separator character (space, dot,
dash, underscore) of length >= 2 collapses to a single character. `Show  -  Title` -> `Show - Title`.
Runs of different characters are untouched (`- -` stays `- -`).

4.9.3 **Trim trailing separators** (any mix of space, dot, dash, underscore) from the end of the
component. This removes the dangling ` - ` left when a trailing token is empty.

4.9.4 Restore protected ellipses to `...`.

4.9.5 Apply reserved device-name fix (2.7).

### 4.10 Folder name clean-up

4.10.1 Series/movie folder: after token replacement, collapse repeated separators (4.9.2) and
trim spaces and dots from both ends. Unlike files, trailing dashes/underscores are **kept**.
Then device-name fix and ellipsis restore.

4.10.2 **[TV]** Season folder: as above but additionally trims dash and underscore from both
ends. E.g. format `Season {season} - {Season Title}` with no season title -> `Season 1`.

4.10.3 **[Movie]** each folder segment is cleaned this way; empty segments dropped; segments
joined with the path separator.

### 4.11 Paths

4.11.1 **[TV]** season path = series root path; if the series has "season folders" enabled,
append the season folder (season 0 uses the specials format, others the season format; the
folder text is passed through illegal-character cleaning once more, 3.1). File path = season
path + file name + extension.

4.11.2 **[Movie]** file path = movie path + file name + extension. The file name can contain
sub-folder segments (2.6.1).

4.11.3 The extension must be non-empty when building a path (programmer error otherwise).
It is appended **after** the length budget is computed (4.8.4), so a long title leaves room for
it.

---

## 5. [TV] Token catalogue

Notation: "Clean" variants apply the clean-title transform (5.2). "The" variants move a leading
article to the end. All title tokens accept a length modifier (2.5.1).

### 5.1 Series tokens (usable in file, series-folder, season-folder formats)

| Token | Meaning | Example, series "The Series Title's!" (2010) |
|---|---|---|
| `{Series Title}` | Title as stored | `The Series Title's!` |
| `{Series CleanTitle}` | Clean transform | `The Series Title's!` |
| `{Series TitleYear}` | Title + ` (Year)` unless it already ends in `(YYYY)` or year = 0 | `The Series Title's! (2010)` |
| `{Series CleanTitleYear}` | Clean of TitleYear | `The Series Title's! 2010` |
| `{Series TitleWithoutYear}` | Title with a trailing `(YYYY)` removed | `The Series Title's!` |
| `{Series CleanTitleWithoutYear}` | Clean of the above | `The Series Title's!` |
| `{Series TitleThe}` | Leading The/An/A moved to end after a comma | `Series Title's!, The` |
| `{Series CleanTitleThe}` | Clean + article moved | `Series Title's!, The` |
| `{Series TitleTheYear}` | TitleThe + year | `Series Title's!, The (2010)` |
| `{Series CleanTitleTheYear}` | clean + article moved + bare year | `Series Title's!, The 2010` |
| `{Series TitleTheWithoutYear}` | TitleThe without trailing `(YYYY)` | |
| `{Series CleanTitleTheWithoutYear}` | | |
| `{Series TitleFirstCharacter}` | First letter/digit of the **TitleThe** form, upper-case, diacritics removed; if first char is not alphanumeric try the second; else `_` | `S` |
| `{Series Year}` | Year as a number | `2010` |
| `{ImdbId}` | e.g. `tt1234567` or empty | |
| `{TvdbId}` | numeric | |
| `{TvMazeId}` | numeric or empty if unknown (<=0) | |
| `{TmdbId}` | numeric or empty if unknown (<=0) | |

5.1.1 Year handling: the "trailing `(YYYY)`" test is textual. A title already ending in a
parenthesised four-digit year is not given a second year, even if the year differs from the
series year.

5.1.2 `{Series TitleFirstCharacter}` does not honour the length modifier in practice (one
character). The article-moving transform ("The/An/A" at start, followed by a space) keeps any
trailing parenthesised qualifier after the comma: "The Office (US)" -> `Office, The (US)`.

### 5.2 The "clean title" transform

5.2.1 Used by all `Clean*` tokens. In order:
 1. `&` -> `and`;
 2. `/` -> space;
 3. remove these characters when they stand alone between spaces: `, < > / \ ; : ' " | ` ~ ! ? @ $ % ^ * - _ =`;
 4. remove apostrophes/backticks/colons/question marks/commas that are followed by a space,
    the end of the text, or a contraction ending (`s`, `m`, `t`, `ve`, `ll`, `d`, `re` then
    space);
 5. remove all of `( ) [ ] { }`;
 6. strip diacritics (`é` -> `e`).

5.2.2 Examples: `Tom & Jerry` -> `Tom and Jerry`; `The Series Title's!` is unchanged (the
apostrophe is followed by `s!`, not `s` plus whitespace; `!` is removed only when alone between
spaces). `Marvel's Agents of S.H.I.E.L.D.` -> `Marvels Agents of S.H.I.E.L.D.`.
`Amélie (2001)` -> `Amelie 2001`.

### 5.3 Season tokens (season-folder format, also in file formats)

| Token | Meaning |
|---|---|
| `{season}` / `{season:00}` | season number, optional zero padding |
| `{Season Title}` | season name from metadata (e.g. an anime cour name); empty if none |
| `{Season CleanTitle}` | clean transform of it |

### 5.4 Episode tokens

| Token | Meaning |
|---|---|
| `{episode}` / `{episode:00}` | episode number, or `first-last` for multi (4.4.5); normally consumed by the numbering pattern |
| `{absolute}` / `{absolute:000}` | absolute number (anime only, 4.6) |
| `{Episode Title}` | 4.8 |
| `{Episode CleanTitle}` | 4.8 (joined with "and") |
| `{Air Date}` | 4.7 |

### 5.5 File tokens

| Token | Meaning |
|---|---|
| `{Original Title}` | scene name of the release; if none, the original file name (without extension) |
| `{Original Filename}` | the original file name without extension; empty if fallback disallowed |
| `{Release Group}` | stored release group, truncatable. If empty: the product's default text (upstream: the app name) -- but **only if the token has no prefix and no suffix**; with prefix or suffix it renders empty |
| `{Release Hash}` | the release hash (anime CRC32), empty if none |

5.5.1 Original title/filename fallback: the current file name may be used as the fallback source
only when the *component* has no episode identifier (no numbering pattern, no absolute
pattern, no air date), **or** the file is not yet saved (still being imported). Otherwise
`{Original Filename}` is empty and `{Original Title}` is the scene name or empty. This stops
a rename from baking an old name's numbering into a new name that also carries numbering.

### 5.8 Worked example

Series "The Series Title's!" S01E01 "Episode Title (1)", WEBDL-1080p v2, group RlsGrp. Default standard -> `The Series Title's! - S01E01 - Episode Title (1) WEBDL-1080p Proper`. `{Series.Title}.S{season:00}E{episode:00}.{Episode.Title}.{Quality.Full}-{Release Group}` -> `The.Series.Title's!.S01E01.Episode.Title.(1).WEBDL-1080p.Proper-RlsGrp`. `{series title} - s{season:00}e{episode:00}` -> `the series title's! - s01e01`. `{Series Title} {[Quality Title]}{-Release Group}` -> `The Series Title's! [WEBDL-1080p]-RlsGrp`. `{Series TitleYear} - {season}x{episode:00}` -> `The Series Title's! (2010) - 1x01`.

---

## 6. [Movie] Token catalogue

### 6.1 Movie tokens

| Token | Meaning | Example, "The Movie: Title" (2010), original "The Original Movie Title", collection "The Movie Collection", cert R |
|---|---|---|
| `{Movie Title}` | Title (or translation, 6.2) | `The Movie - Title` (colon cleaned) |
| `{Movie CleanTitle}` | Clean transform | `The Movie Title` |
| `{Movie TitleThe}` | Article moved | `Movie - Title, The` |
| `{Movie CleanTitleThe}` | | `Movie Title, The` |
| `{Movie TitleFirstCharacter}` | first alphanumeric of TitleThe form | `M` |
| `{Movie OriginalTitle}` | metadata original-language title; empty if none | `The Original Movie Title` |
| `{Movie CleanOriginalTitle}` | | |
| `{Movie Certification}` | e.g. `R`, `PG-13`; empty if none | `R` |
| `{Movie Collection}` | collection name or empty | `The Movie Collection` |
| `{Movie CollectionThe}` | article moved | `Movie Collection, The` |
| `{Movie CleanCollectionThe}` | clean + article moved | |
| `{Release Year}` | four-digit year, empty if year = 0 | `2010` |
| `{ImdbId}` | `tt...` or empty | |
| `{TmdbId}` | number | |

6.1.1 `{Movie TitleThe}` and `{Movie CleanTitleThe}` always use the **primary** title, not
translations (even if a language modifier is present).

6.1.2 Movies have no `{... TitleYear}` tokens; compose with `({Release Year})`.

6.1.3 Truncation (2.5.1) applies to every title/collection token except TitleFirstCharacter.
Null/missing metadata strings are treated as empty.

### 6.2 Translated titles

6.2.1 `{Movie Title:de}` / `{Movie Title:de|fr}`: for each listed ISO language code in order,
find the first one that maps to a known language; look for a translation of the movie in that
language; if found use it, otherwise fall back to the primary title. The first *recognised*
code decides (later codes are used only if earlier ones are unrecognised). The translation list
is read from stored metadata; if the movie has none stored, it is fetched from the translation
store.

### 6.3 Edition tag

6.3.1 `{Edition Tags}` is registered only when the movie **file** has an edition string.
It renders the edition normalised: lower-case, then Title Case, then ordinal numbers and
millimetre sizes keep lower-case suffixes (`40th`, `35mm`), then the words IMAX, 3D, SDR, HDR, DV
are upper-case. Truncation modifier applies.

6.3.2 Example: stored edition `Ultimate extended edition` -> `Ultimate Extended Edition`;
`imax 70mm cut` -> `IMAX 70mm Cut`.

### 6.4 Tag wrappers

6.4.1 A movie pattern may use `{edition-{Edition Tags}}` and `{imdb-{ImdbId}}` /
`{imdbid-{ImdbId}}` (and the same for tmdb) to produce Plex/Jellyfin-style tags. The outer
braces and the `edition-`/`imdb-` text are emitted **only when the inner token renders non-empty**;
otherwise the whole construct disappears.

6.4.2 Example: `{Movie Title} ({Release Year}) {edition-{Edition Tags}} {imdb-{ImdbId}}` for a
file with edition "Director's Cut" and IMDb `tt0123456` -> `The Movie - Title (2010)
{edition-Director's Cut} {imdb-tt0123456}`. Without edition: `The Movie - Title (2010)
{imdb-tt0123456}`.

### 6.5 Movie file tokens

| Token | Meaning |
|---|---|
| `{Original Title}` | scene name, else (if fallback allowed) the current file name |
| `{Original Filename}` | current file name without extension (if fallback allowed) |
| `{Release Group}` | as 5.5 (default text only without prefix/suffix) |

6.5.1 Fallback rule differs from TV: **the file-name fallback is allowed only when the pattern
contains exactly one token** (the common `{Original Title}` alone). With more than one token
in the pattern `{Original Filename}` is empty and `{Original Title}` is the scene name or
empty.

6.5.2 With renaming switched off, the original title is used with fallback always allowed.

### 6.6 Movie folder format restrictions

6.6.1 The movie folder format may not use any file-derived token: Original Title/Filename,
Release Group, Edition Tags, any Quality token, any MediaInfo token. Validation (9.4)
rejects these ("deprecated tokens derived from file properties"). The folder must still contain
a movie title token.

### 6.7 Examples

Movie "The Movie: Title" (2010), Bluray-1080p, group EVOLVE. Default file format -> `The Movie - Title (2010) Bluray-1080p`; folder -> `The Movie - Title (2010)`; folder `{Movie CollectionThe}/{Movie Title} ({Release Year})` -> `Movie Collection, The/The Movie - Title (2010)`; file `{Movie.Title}.{Release.Year}.{Quality.Title}.{MediaInfo.VideoCodec}` -> `The.Movie.-.Title.2010.Bluray-1080p.x264`; default file format with year 0 -> `The Movie - Title () Bluray-1080p`.

6.8 A token that renders empty removes only itself and its own prefix/suffix; literal characters around it (such as the `()` in `({Release Year})`) stay. Do not extend the prefix/suffix alphabet of 2.1.1; avoid year-0 items.

---

## 7. Shared file tokens

### 7.1 Quality tokens

7.1.1 Four tokens, available to both media types:

| Token | Value |
|---|---|
| `{Quality Title}` | display name of the file's quality, e.g. `WEBDL-1080p`, `Bluray-1080p`, `HDTV-720p`, `DVD`, `Bluray-2160p Remux` |
| `{Quality Proper}` | revision text (7.2) or empty |
| `{Quality Real}` | `REAL` if the revision's "real" counter > 0, else empty |
| `{Quality Full}` | quality title, proper, real joined by single spaces: `WEBDL-1080p Proper REAL`; empty parts leave extra spaces that clean-up removes |

7.1.2 The quality title is the **quality definition's title** (user-editable), not the enum
name.

7.2 **Proper text:** if the revision *version* > 1: **[TV]** anime series -> `v` + version (`v2`,
`v3`), every other series type -> `Proper`; **[Movie]** always `Proper`. Version 1 -> empty.

7.3 **[Movie]** if the file has no quality at all, all four tokens render empty.

7.3.1 Examples (TV, non-anime): Bluray-1080p v1 -> Full `Bluray-1080p`; WEBDL-1080p v2 -> `WEBDL-1080p Proper`;
HDTV-720p v2 real 1 -> `HDTV-720p Proper REAL`; anime WEBDL-1080p v3 -> `WEBDL-1080p v3`.

### 7.4 Media-info availability

7.4.1 All `{MediaInfo ...}` tokens are registered only when the file has media-info. Without
media-info they render empty (2.2.3) -- so `{MediaInfo Simple}` disappears. Media-info is a
per-file record of video codec, bit depth, HDR format, audio codec/channels/languages,
subtitle languages, and (movies) multi-view count.

### 7.5 Media-info tokens

| Token | Value | Fallback |
|---|---|---|
| `{MediaInfo Video}`, `{MediaInfo VideoCodec}` | friendly video codec (7.7) | empty |
| `{MediaInfo VideoBitDepth}` | bit depth number | `8` when bit depth is missing/zero |
| `{MediaInfo VideoDynamicRange}` | `HDR` if any HDR format is present | empty for SDR |
| `{MediaInfo VideoDynamicRangeType}` | `DV`, `DV HDR10`, `DV HDR10Plus`, `DV HLG`, `DV SDR`, `HDR10`, `HDR10Plus`, `HLG`, `PQ`, `HDR` (unknown HDR) | empty for SDR |
| `{MediaInfo Audio}`, `{MediaInfo AudioCodec}` | friendly audio codec of the **primary** audio stream (7.7) | empty |
| `{MediaInfo AudioChannels}` | channel layout with one decimal: `5.1`, `2.0`, `7.1` | empty if zero |
| `{MediaInfo AudioLanguages}` | `[DE+FR]` form (7.6), **empty if the only language is English** | empty |
| `{MediaInfo AudioLanguagesAll}` | same but English-only is shown `[EN]` | empty |
| `{MediaInfo SubtitleLanguages}` | `[EN+DE]` | empty |
| `{MediaInfo SubtitleLanguagesAll}` | identical to the above | empty |
| `{MediaInfo Simple}` | `{video} {audio}` | |
| `{MediaInfo Full}` | `{video} {audio}[audio langs] [subtitle langs]` (audio langs omitted if English-only; the language part uses the token's modifier) | |
| `{MediaInfo 3D}` **[Movie]** | `3D` if the video has more than one view, else empty | |

7.5.1 Channels: parse the first `d.d` shape at the start of the channel-position string
(`5.1`, `2.0`, `7.1`); if that is absent or zero use the raw channel count as a number with one
decimal (6 -> `6.0`).

7.5.2 Example: German DTS 5.1 with English + German subs, h264 video whose scene name contains
"x264": `{MediaInfo Full}` -> `x264 DTS [DE] [EN+DE]`. Same with English-only audio:
`x264 DTS [EN+DE]` -> after clean-up `x264 DTS [EN+DE]`.

### 7.6 Language list rules

7.6.1 Input is the list of language strings from media-info. Drop blanks and `und`.

7.6.2 Normalise each: lower-case; map the bibliographic ISO 639-2/B codes to their
terminology equivalents (alb->sqi, arm->hye, baq->eus, bur->mya, chi->zho, cze->ces, dut->nld,
fre->fra, geo->kat, ger->deu, gre->ell, gsw->deu, ice->isl, mac->mkd, mao->mri, may->msa,
per->fas, rum->ron, slo->slk, tib->bod, wel->cym); convert to the upper-case two-letter code
(`eng` -> `EN`, `ger`/`deu` -> `DE`). If a code cannot be resolved it is left as the trimmed
original text.

7.6.3 De-duplicate (first occurrence wins).

7.6.4 **Filter modifier**:
 - none: all languages;
 - `EN+DE` (list joined by `+`): keep only those listed that are present, in the **filter's
   order**;
 - `-EN` or `-EN-DE` (leading dash, items separated by dash): keep everything except those.
 - A modifier that **ends with `+`** (`EN+`) means "and others": if anything was filtered out,
   append `--` to the result (`[EN+--]`).

7.6.5 If the "skip English only" flag applies (AudioLanguages, MediaInfo Full audio part) and
the filtered result is exactly `EN`, return empty.

7.6.6 Join with `+`. Non-empty results are wrapped in square brackets (all callers use
brackets).

7.6.7 Examples: audio [eng, ger, ger] -> `[EN+DE]`; AudioLanguages with only eng -> empty,
AudioLanguagesAll -> `[EN]`; `{MediaInfo AudioLanguages:DE}` -> `[DE]`; `:-DE` -> `[EN]` -> but
English-only skip applies -> empty; `{MediaInfo SubtitleLanguages:EN+}` with subs en+de+fr ->
`[EN+--]`.

### 7.7 Friendly codec names

Video (from format id, codec id, and the scene name):

| Source | Output |
|---|---|
| codec id `x264` | `x264` |
| format h264 | scene name contains `AVC` -> `AVC`; else contains `x264` -> `x264`; else `h264` |
| codec id `x265` | `x265` |
| format hevc | scene contains `HEVC` -> `HEVC`; `x265` -> `x265`; else `h265` |
| codec id `x266` / format vvc | `x266` / scene contains `VVC` -> `VVC`, `x266`, else `h266` |
| mpeg2video | `MPEG2` |
| mpeg1video | `MPEG` |
| mpeg4 / msmpeg4 | codec id xvid -> `XviD`; div3/dx50/divx -> `DivX`; else empty |
| vc1 | `VC1` |
| av1 | `AV1` |
| vp6 / vp7 / vp8 / vp9 | `VP6`, `VP7`, `VP8`, `VP9` |
| wmv1-3 | `WMV` |
| qtrle, rpza, rv10-40, cinepak, rawvideo, msvideo1 | empty |
| anything else | the raw format string |

Audio (primary stream; format id, profile, codec id):

| Source | Output |
|---|---|
| codec id `thd+` or truehd with Atmos profile | `TrueHD Atmos`; plain truehd -> `TrueHD` |
| flac | `FLAC` |
| dts | profile DTS:X (and DTS-HD MA + DTS:X variants) -> `DTS-X`; DTS-HD MA -> `DTS-HD MA`; DTS-ES -> `DTS-ES`; DTS-HD HRA -> `DTS-HD HRA`; DTS Express -> `DTS Express`; DTS 96/24 -> `DTS 96/24`; else `DTS` |
| codec id `ec+3` or eac3 with Atmos profile | `EAC3 Atmos`; plain eac3 -> `EAC3` |
| ac3 | `AC3` |
| aac | codec id AAC/MPEG4/LC/SBR or profile HE-AAC -> `HE-AAC`; xHE-AAC -> `xHE-AAC`; else `AAC` |
| mp3 / mp2 / opus / vorbis | `MP3` / `MP2` / `Opus` / `Vorbis` |
| pcm_* and adpcm_* | `PCM` |
| wmav1, wmav2, wmapro | `WMA` |
| anything else | raw format string |

7.7.1 The scene-name match for video codecs is case-insensitive, on the scene name without its
extension. When no scene name exists the last candidate in the list is the default (`h264`,
`h265`, `h266`).

### 7.8 Custom-format tokens

7.8.1 `{Custom Formats}`: the names of all custom formats the file matches **that have
"include when renaming" enabled**, joined by single spaces, in the stored order.
7.8.2 Modifier filter: comma-separated names keep only those; a leading dash with a comma list
excludes those. Names are case-sensitive exact matches.
7.8.3 `{Custom Format:Name}`: that single format's name if it matches *and* is included when
renaming, else empty. Without a modifier it is empty.
7.8.4 The custom-format list is normally computed from the file's current attributes; callers
that already have it may pass it in.
7.8.5 Example: matches "Surround Sound", "x264" both included: `{Custom Formats}` ->
`Surround Sound x264`; `{Custom Formats:x264}` -> `x264`; `{Custom Formats:-x264}` ->
`Surround Sound`; `{Custom Format:x264}` -> `x264`.

### 7.9 Refreshing stale media-info

7.9.1 Stored media-info carries a schema revision. The two dynamic-range tokens need a minimum
revision (HDR: 5; HDR type: 11 for TV, 13 for movies upstream). If the pattern contains one of
those tokens, the item has a path, and the file's media-info revision is below the minimum,
media-info is re-read from the file before rendering. Arclight should implement the same
idea in any form (re-probe when stored data predates a field the pattern needs); the revision
numbers are internal to upstream.

---

## 8. Original titles and the "rename off" behaviour

8.1 `Original Title` = scene name if present (cleaned per section 3, i.e. illegal characters
removed/replaced), otherwise the original file name without extension (cleaned), subject to the
fallback rules in 5.5.1 / 6.5.1.

8.2 `Original Filename` = file name without extension from the stored relative path, or from the
full path if no relative path; empty when fallback is not allowed.

8.3 Rename-off result **[TV]**: original title + extension (fallback allowed). Rename-off
result **[Movie]**: original title (no extension).

---

## 9. Validation of formats (settings and API)

Validation runs when saving naming settings; each rule yields a message on the specific field.

9.1 Every format: must not be empty; must not contain characters illegal in paths (on the
host OS; at minimum control characters and NUL, plus `<>|"` on Windows). Slashes are allowed in
file formats and series/movie folder formats (they create levels) but should be flagged as
"cannot be inside a season folder format" for the **[TV]** season and specials formats since
those are not split.

9.2 **[TV]** Standard episode format must contain a season+episode numbering pattern, **or**
both a `{season}` and an `{episode}` token, **or** an Original Title/Filename token. Message:
"Must contain season and episode numbers OR Original Title".

9.3 **[TV]** Daily format: all of the above **or** an Air Date token. Message: "Must contain Air
Date OR Season and Episode OR Original Title".
Anime format: the standard alternatives **or** an absolute token. Message: "Must contain
Absolute Episode number OR Season and Episode OR Original Title".

9.4 **[TV]** Series folder: must contain a series title token (any of the Series Title variants,
clean/the/year variants allowed; optional length modifier digits). Message: "Must contain series
title". Season folder: must contain a `{season}` token. Message: "Must contain season number".
Specials folder: non-empty, no illegal characters, and not matching the season-folder
exclusion pattern (upstream message "Matches excluded subfolder pattern").
Custom colon replacement: must not contain colon or any of `\ / < > ? * | "`.

9.5 **[Movie]** File format: valid when it has a Movie Title or Original Title-family token
**and** a Release Year token, but only if it has no Original Title/Filename token; **or** when
it has an Original Title/Filename token. Message: "Must contain either movie title and release
year OR Original Title/Filename". Folder format: must contain a movie title token (title, clean
title, original title, with optional The/Clean); must **not** contain file-derived tokens
(6.6.1); message "Must not contain deprecated tokens derived from file properties".

9.6 **Round-trip validation (sample test), TV only.** Render each format against fixed sample data
(10.x) and parse the produced name with the release-name parser. The format fails with
"Produces invalid file names" if: the parser cannot parse it at all; or the parsed season
and set of episode numbers do not equal the sample's (standard); or for daily: parsed as daily and
air date differs, else falls back to season/episode comparison; or for anime: absolute numbers
parsed but first does not equal the sample's first absolute number, else season/episode check.
Names containing a path separator are parsed as paths.

---

## 10. Sample data (for preview and round-trip validation)

10.1 **[TV]** series "The Series Title's!", year 2010. Single sample S01E01 "Episode Title (1)",
air date 2013-10-30, absolute 1; multi sample S01E01-E03 titled "Episode Title (1)/(2)/(3)",
absolute 1-3. File: WEBDL-1080p revision 2, group `RlsGrp`, scene name
`The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE`, h264 10-bit HLG video, German DTS 5.1
audio, English+German subtitles; custom formats "Surround Sound" and "x264" (both included in
names). Anime samples use a `[RlsGroup] ...` scene name with Japanese audio.

10.2 **[Movie]** movie "The Movie: Title", year 2010, original title "The Original Movie
Title", collection "The Movie Collection", certification R; file Bluray-1080p revision 2, group
`EVOLVE`, edition "Ultimate extended edition", scene name
`The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE`.

10.3 Default standard format on the multi sample: `The Series Title's! - S01E01-E03 - Episode
Title WEBDL-1080p Proper`. Daily default: `The Series Title's! - 2013-10-30 - Episode Title (1)
WEBDL-1080p Proper`. Folders: `The Series Title's!`, `Season 1`, `Specials`,
`The Movie - Title (2010)`.

---

## 11. Additional worked examples (composite)

All TV examples use the sample series/file unless stated; defaults: Smart colons, Prefixed
Range, replace-illegal on.

| # | Format | Input | Output |
|---|---|---|---|
| 1 | default standard | S02E05 "The Fall", quality HDTV-720p v1 | `The Series Title's! - S02E05 - The Fall HDTV-720p` |
| 2 | default standard | S01E01-02 titles "Pilot (1)", "Pilot (2)" | `The Series Title's! - S01E01-E02 - Pilot WEBDL-1080p Proper` |
| 3 | default standard | S01E01-02 titles "Alpha", "Beta" | `... - S01E01-E02 - Alpha + Beta WEBDL-1080p Proper` |
| 4 | `{Series Title} - S{season:00}E{episode:00}` | title "CSI: Miami" | `CSI - Miami - S01E01` |
| 5 | same, colon Delete | "CSI: Miami" | `CSI Miami - S01E01` |
| 7 | `{Series Title}` season folder `Season {season:00}` | season 3 | `Season 03` |
| 9 | series folder `{Series TitleYear}` | "Fargo" (2014) | `Fargo (2014)` |
| 11 | series folder `{Series TitleTheYear}` | "The Office" (2005) | `Office, The (2005)` |
| 12 | series folder `{Series CleanTitle}` | "Marvel's Agents of S.H.I.E.L.D." | `Marvels Agents of S.H.I.E.L.D.` |
| 13 | `{Series Title:12}` | "Breaking Bad Extra" | `Breaking...` (trailing space trimmed) |
| 15 | `{Series Title} S{season:00}E{episode:00}` + Duplicate style, 2 eps | | `The Series Title's! S01E01 S01E02` (no trailing run, so the leading single space is the separator) |
| 16 | Anime, abs 12-13, `{Series Title} - {absolute:000} - {Episode Title}`, Prefixed Range | | `The Series Title's! - 012-013 - Title` (Range style shows first and last) |
| 18 | Movie default | "Amélie" (2001), WEBDL-1080p | `Amélie (2001) WEBDL-1080p` (diacritics kept in non-clean tokens) |
| 19 | Movie `{Movie CleanTitle} ({Release Year})` | "Amélie" | `Amelie (2001)` |
| 20 | Movie folder `{Movie Title} ({Release Year})`, year 0 | "Unreleased" | `Unreleased ()` (literal parentheses remain; callers should avoid year 0) |
| 21 | Movie `{Movie Title:de}` | translation "Die fabelhafte Welt der Amélie" exists | German title used |
| 22 | Movie `{Movie Title} ({Release Year}) {edition-{Edition Tags}}` no edition | | `Amélie (2001)` |
| 23 | Movie file `{Original Title}`, scene name present | | scene name (cleaned) |

---

## 12. Undetermined or unverified

 - Exact behaviour of series-folder formats that contain slashes on Linux (upstream does not
   split them; nested folder results depend on later path joining). Arclight should split on
   both slash styles.
 - The platform path limit values quoted come from reading the limit detection (Linux 4096,
   Windows 259 or 4096 when long paths are enabled, name 255) and may need review in Docker.
 - Clean-title examples were derived by hand; verify against fixtures.
 - Section 6.8 describes corner cases derived by reading; the upstream
   UI help text and any extra tokens that exist only in the web layer were not read.
 - The "Radarr" media-info formatter takes a single media-info record rather than a primary
   audio stream; assumed to be equivalent (same mappings).
 - Whether Radarr's `Custom` colon option exists in its UI: it does not in the shared enum read
   here, so it is marked TV-only.
