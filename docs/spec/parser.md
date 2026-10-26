# Parser behaviour spec

Derived solely from the fixtures in `packages/parser/fixtures/**/*.json` (about 2,930 cases), the output
types in `packages/parser/src/types.ts` and the quality vocabulary in `packages/shared/src/quality.ts`.
Fixtures are behavioural truth. Where a fixture only asserts "contains", this spec says so. Section 10 lists
fixtures that cannot all hold.

Conventions used below:

- `->` means "parses to". `s` = seasons, `e` = episodes, `abs` = absoluteEpisodes.
- Examples are verbatim fixture inputs. Rule numbers are stable: `R<section>.<n>`.
- "Separator" means any of `.`, `_`, ` `, and (context permitting) `-`.
- Fixture quality names appear in two spellings: the shared vocabulary (`WEBDL-720p`) and, in
  `series/hashed.json` only, compact (`WEBDL720p`, `HDTV720p`, `Bluray1080p`, `DVD`). Both denote the same
  quality (see C1).

## 0. Output model

| Field | Type | Notes |
|---|---|---|
| `releaseTitle` | string | input after extension stripping and website-prefix removal, original separators kept |
| `quality` | `{quality, revision, detectionSource}` | see section 4 |
| `languages` | string[] | default `["Unknown"]` (section 5) |
| `releaseGroup` | string or null | section 6 |
| `releaseHash` | string | 8-hex CRC from `[]`/`()`; empty string when absent in anime fixtures (C7) |
| `series` | object or null | title, titleInfo, seasons, episodes, absoluteEpisodes, airDate, fullSeason, isPartialSeason, isMultiSeason, isSeasonExtra, isSplitEpisode, isMiniSeries, seasonPart, special, releaseVersion, subGroup |
| `movie` | object or null | title, titleWithoutYear, year (0 if none), edition, imdbId, tmdbId |

Additional fixture-visible outputs: `specialAbsoluteEpisodes` (decimal recap numbers), `dailyPart`,
`isSeasonTitle`, `allTitles` (alternative titles), `languageTags`, `subtitleLanguage`, `subtitleTitle`.

Media type hint: `series` forces series parsing, `movie` forces movie parsing, `auto` tries series structure
first (season/episode/date present) and otherwise movie (title + year).

---

## 1. Input preparation

**R1.1 Extension stripping.** A trailing known media/NZB extension is removed from `releaseTitle`
(`.mkv .avi .mp4 .m4v .ts .nzb .xvid .divx .webm .m2ts .iso`). `Series.S01E02.Chained.Title.mkv` ->
releaseTitle `Series.S01E02.Chained.Title`. The extension is not part of any group:
`...x264-archivist.mkv` -> group `archivist`. A trailing `.nzb` and trailing `_` are also stripped
(scene-check: `Some.Movie.2..2013...-Pate_` -> sceneTitle without `_`).
`.webm` alone gives no quality (Unknown); `.xvid`/`.divx` give SDTV.

**R1.2 Website prefixes.** A leading `[ www.Site.com ]`, `www.Site.com -`, `【... www.X.com】`, or
`www.5MovieRulz.tc -` is removed: `[ www.Torrenting.com ] - Series.2012.S02E17` -> title `Series 2012`.
Chinese pack prefix `【高清剧集网发布 www.DDHDTV.com】Series Towards You[...]` is removed and does not become
the group (the trailing `-SeeWEB` does).

**R1.3 Request/tracker tags.** Leading Usenet request tags are dropped:
`[scnzbefnet][509103] 2.Developers.Series...` -> title `2 Developers Series`. Trailing `(S:285/L:11)`
seed/leech counters are ignored (quality `WEBDL-1080p` for `...WEB.H264-ALLDAYiN (S:285/L:11)`).

**R1.4 Hash tags.** `[8 hex]` or `(8 hex)` near the end is `releaseHash` and never the group or title:
`[SubsPlease] Anime Title - 01 (1080p) [B1F227CF]` -> hash `B1F227CF`. Hex containing `B` letters like
`10B`/`8B` still counts as a hash. Absent -> `""`. A bare 32/40-hex file name is a "hashed" release (R7.1).

**R1.5 Separators.** `.`, `_`, spaces and (inside tokens) `-` all separate. Output titles use single spaces:
`Series.With.Title.S02E15` -> `Series With Title`. Dots inside acronyms (`R.I.P.D.`, `The Movie from U.N.C.L.E.`,
`A.I. Artificial Movie`) are kept (movies); a dot between two digits becomes a space (`Evangelion 1.11` ->
`Evangelion 1 11`), except in decimal recap numbers (R2.30). Double dots collapse (`Some.Movie.2..2013`).

**R1.6 Brackets.** Quality/format brackets (`[720p]`, `[HDTV-720p]`, `[WEB-DL]`, `(BD 1080p)`) are metadata,
never titles or groups. A bracketed year stays in series titles: `Series Title [2022] [S25E13]` -> `Series Title [2022]`;
`MY MOVIE (2016) [R][Action...]` -> movie title `MY MOVIE`, year 2016. Angle brackets are stripped:
`<나는 솔로>` -> `나는 SOLO 나는 솔로`.

**R1.7 Full-width / unicode normalisation.** Full-width digits and punctuation are normalised before parsing:
`１５８` -> 158, `＆` -> `&`, `【720p】` -> `[720p]`. Accents are kept in titles (`Báleygr` group, `Carnivàle`);
they are removed only in normalisation (section 8).

**R1.8 Unicode titles.** CJK/Cyrillic/Hangul titles are valid titles. With a Latin alternative after `/` or `_`
or in the last bracket, the Latin part wins: `[哥布林杀手/Anime Series Title][12END]` -> `Anime Series Title`;
`Босх: Спадок (S2E1) / Series: Legacy (S2E1) (2023)` -> `Series: Legacy`; `我的人间烟火.Fireworks.Series.S01E01.2023.V2`
-> `Fireworks Series`. With no Latin part the CJK title is used: `[风车字幕组][名侦探柯南][857]` -> `名侦探柯南`;
`[愛戀&漫貓字幕组][10月新番][關於我轉生後成爲史萊姆那件事][18]` -> `關於我轉生後成爲史萊姆那件事`. Season words such as `第二季` are
dropped. Mixed: `[Skymoon-Raws][Anime Series 海賊王]` -> `Anime Series`.

**R1.9 Path inputs.** Both `\` and `/` separate path segments. Parsing prefers the file name; folder names fill
in what the file name lacks (R7.3). Season folders: `Season 3`, `Season 2 - Total Series Action`, `Specials`.

**R1.10 Rejection.** Obvious non-releases return null series and movie: `THIS SHOULD NEVER PARSE`,
32/40-hex strings, random strings (R7.6).

---

## 2. Series title and numbering

### 2.1 Title extraction

**R2.1 Title is everything before the first numbering token**, separators turned to spaces.
`Series.Title.S01E01` -> `Series Title`. Empty title is valid when only a token is present:
`S03E09 WS PDTV XviD FUtV` -> `""`; `Season 2\E05-06 - Episode Title HDTV-720p Proper` -> `""` (folder context supplies seasons only).

**R2.2 Kept in the title.** Years (`Series.Title.2010.S02E14` -> `Series Title 2010`), parenthesised years
(`Series Title (2024)`, `Series Title-0 (2010)` keeps its hyphen), numeric-only titles (`42`, `69`, `1234`, `86 - 01` -> `86`),
punctuation (`Developers & Coders`, `Series!`, `24-7 Series - Title - Road to the Sonarr`), hyphenated words
(`grp-zoos01e11` -> `grp-zoo`), leading numbers (`2.Developers.Series` -> `2 Developers Series`),
parenthesised alternative titles (`Japanse Anime, Title (Anime, Title)` retained).

**R2.3 Removed from the title.** Website/request prefixes (R1.2, R1.3), a leading `[Group]` (subGroup),
quality/source/codec tokens, release group, episode titles, and leading broadcast-date prefixes in Japanese
variety packs: `221208 ABC123 Series Title ep34` -> `ABC123 Series Title`, s1 e34.

**R2.4 Bilingual titles.** `A / B`, `A AKA B`, `A (B)` produce `allTitles` (R3.12-style): `["Босх: Спадок","Series: Legacy"]`,
`["Серие","Series"]`; the primary `title` for such releases is the Latin/last alternative. `(Series J)` yields an alias
(see C9).

**R2.5 Trailing-year mini-series wrapper.** `(Miniserie) (2024/S01E07/...` -> `Mini Title (2024)`. A pack wrapper
`(2016/S01/WEB-DL/...)` -> title `Seriesless (2016)`, season 1, fullSeason.

### 2.2 Single episode

**R2.6 S/E forms (case-insensitive).** `S02E15`, `s02e15`, `S2E15`, `S1-E1`, `S15.E06`, `S15 E06`, `S01.Ep.01`,
`S01.E.01`, `S01EP01`, `S01.Ep06`, `S6E02-Unwrapped`. All -> season N, episode M.

**R2.7 Large values are literal.** `S1936E18`, `S2009E09`, `S2016E231`, `S41 E10478`, `S101E01`, `S93E081`.

**R2.8 `NxMM`.** `1x04`, `4x05`, `7x6`, `19x06`, `2009x09` (season 2009), `0x01` (season 0).

**R2.9 Words.** `Season 01 Episode 05`, `Season 1 - Episode 01` -> s1 e5/e1. Dutch `Se.3 afl.3` -> s3 e3.
Spanish `Temporada 2 [..][Cap.201]` -> s2 e1; `Cap.1901` -> s19 e1; `Cap.408` -> s4 e8; `[Cap. 101]` -> s1 e1.

**R2.10 Combined 3-4 digit numbers.** A bare `SEE`/`SSEE` block after separators splits last two digits as
episode: `103` -> s1 e3; `416` -> s4 e16; `1013` -> s10 e13; `.525` -> s5 e25; `0308` (after a year) -> s3 e8.
Year-like four-digit values are not split when a year context exists (`Series.2010.S02E14` keeps 2010).

**R2.11 Episode-only.** `Series Show.2016.E04`, `kill-roy-was-here-e07-720p`, `Title.E56.190121.720p-NEXT` -> season 1,
episode N (the 6-digit trailer is a date and ignored). `E07-E08.180612` -> s1 [7,8].

**R2.12 Part numbering as episode.** `Part01`, `Part 02`, `5of9`, `Part Two` -> s1 e1/e2/e5/e2. When a real SxxEyy
precedes, `Part` is ignored: `S01E01 - Part 1` -> e1; `S3E3 - Part 3 Seventeen Seconds` -> e3.

**R2.13 Version suffix.** `S02E01v2`, `Episode 02v2`, `01v3` -> episode unchanged, releaseVersion/revision.version N (R4.20).

**R2.14 Split episodes.** `S06E01b`, `S01E01a` -> episode 1, isSplitEpisode true.

**R2.15 Decimal specials.** `S01E11.5 [SP]` -> e11, special true.

**R2.16 Numbering tokens that end the title** also include `#17` (e17), `ep11` with `Season 39` (s39 e11).

### 2.3 Multi-episode

**R2.17 Hyphen ranges expand.** `S03E01-06` -> 1..6; `S02E03-04-05` -> [3,4,5]; `E9-E10`; `S01E91-E100` -> 10 values;
`S22E5363-E5366` -> 4; `S26E96-97-98-99-100` -> 5; `S04E17-28.Part.2` -> 12 episodes.

**R2.18 Repeated tokens and lists.** `S03E01.S03E02`, `S07E22E23`, `S01e01 e02`, `S6E1-S6E2` -> consecutive lists.
Glued `E1E3` is a **range**: `S6.E1E3` -> [1,2,3]; `S6.E1E2` -> [1,2]; `S6E1-E2-E3` -> [1,2,3].

**R2.19 `x` forms.** `2x04.2x05`, `2x04x05`, `2x9-2x10`, `8x01_02`, `1x01-x03`, `[02x01-x02]`, `02x01-02`,
`2010x15 - 2010x16`.

**R2.20 Implicit pairs.** `103.104` -> s1 [3,4]; `10708` -> [7,8]; `10910` -> [9,10]; `E.010910` -> s1 [9,10]; `101.102`.

**R2.21 Cap ranges.** `Cap.111_120` -> s1 e11-20; `Ep10718 - Ep10722` -> 5 episodes. `Season 01 Episode 05-06` -> [5,6].

**R2.22 Dutch lists.** `Se.1 afl.2-3-4` -> [2,3,4]; `afl.3 en 4` -> [3,4].

**R2.23 "of N" is ignored.** `(S05E06-08 of 24)`, `S5E6-8.of.XX`, `S2E1-4 of 10` -> the range only. Exception: `S1E1-8 of 8`
and `S2E1-16 of 16` where the range spans the whole count are reported as season N with fullSeason true.

### 2.4 Daily / dated

**R2.24 Accepted orders.** yyyy-mm-dd with `. - _ space`; `yyyymmdd`; 6-digit `140722` -> 2014-07-22; `mm.dd.yyyy`
(`04.28.2014`); `dd-mm-yyyy` (`30-04-2024`, `13.02.2025`); `yyyy.dd.mm` when the middle field > 12
(`2012.16.02` -> 2012-02-16; `2012.13.02` -> 02-13); `2011.12.02` -> 2011-12-02 (yyyy leading and ambiguous -> month first).

**R2.25 Ambiguity rejection.** A day-first/month-first date that is valid both ways is rejected: `05-06-2024`, `Series.Title.12.02.2025`
yield no airDate. Resolved when one field > 12 (`13.02.2025`).

**R2.26 Ordinal and word months.** `5th Mar 2025`, `31st Jan 2025`, `23rd Feb 2024` -> airDate.

**R2.27 Validity.** Real calendar dates only. Future dates are accepted (2026-07-03). Very old dates (1950-10-14 in seven
templated forms) are rejected; see C1 for the 1954 counterexample.

**R2.28 Date versus episode token.** If both appear, the SxxEyy wins when it sits right after the title:
`The_Series_US_s06e19_04.28.2014` -> s6 e19; `Judge Developer 2016 02 25 S20E142` -> s20 e142. When the date sits right
after the title and the episode token is trailing metadata the date wins: `The Show Series 2015 02 09 WEBRIP s01e13` -> airDate 2015-02-09;
`Series and Title 20201013 Ep7432` and `Series On TitleClub E76 2024 08 08` -> airDate. With two dates the first wins.

**R2.29 Daily extras.** Daily releases have seasons `[]` and episodes `[]` (season `[0]` for `A.Late.Talk.Show.2010.10.11`);
`.Part1`/`.Part.2` set `dailyPart`. A leading year-like title word stays: `2020.A.Late.Talk.Show.2012.16.02` -> title `2020 A Late Talk Show`.

### 2.5 Anime absolute numbering

**R2.30 Absolute-only.** No season given -> seasons `[0]`... reported as episodes `[]`, absoluteEpisodes `[n]`:
`[Group] Title - 07`, `_-_06_`, `Ep04`, `EP06`, `e66`, `#957`, `E1135`, `Episode 56`, `Episodio 13`, `Episode 013 VF`,
`- 031 -`, `[05]`, `{01}`, `(001)`, `01 Role Play`, Turkish `69. Blm`, `60.Bolum`, `1. Bölüm`.

**R2.31 Season token stays in title for absolute releases.** `Some Anime Show S3 - 12` -> title `Some Anime Show S3`, abs 12;
`Title S21 999` -> `Anime Title S21`, abs 999; `Series Title S03 - EP14` -> `Series Title S03` (see C5).

**R2.32 Both numberings.** `S10E14 214`, `10x14 214`, `214 10x14` -> s10 e14 abs 214. `Title S01E01.001` -> abs 1.
`Series Title (2014) - 017 (115)` -> abs 17 (first number). `(Season 2) - 33` -> s2 abs 33. `S01 - 05 - S01E05` -> s1 e5 abs 5.

**R2.33 Absolute ranges.** `26-27`, `01-12`, `(01-25)`, `1-13`, `Ep01-12`, `091-123`, `01 - 119`, `01~10`, `01 ~ 10`, `[01-05]`, `(892-916)`,
`1017-1088`, `S01 - 01-12` (title `Title S01`). CJK: `[88-91]`, `[01-24完]`.

**R2.34 Episode markers in CJK.** `[12END]`, `[13完]`, `[215 END]`, `[215 Fin]`, `[第05话]`, `[857集]`, `[第1008話]` -> number only.
`[第01-15集]` in a pack -> season 1 episodes 1-15.

**R2.35 Specials/OVA.** `- 01 - Special/OVA/OVD` -> special true abs 1. `OVA - The Other`, `NCOP`, `NCED` -> special true, abs `[]`, seasons `[0]`.

**R2.36 Anime season pack.** `S01 [Web]...`, `S01 12 13`, `S1 05`, `(Season 1)`, `[Season 1 + EXTRA]` -> season 1, fullSeason true, abs `[]`.

**R2.37 Decimal recap numbers.** `12.5` -> specialAbsoluteEpisodes `[12.5]`, abs `[]`; `26.5.1` -> 26.5; `10.5` -> 10.5;
`17.5 (S00E01)` -> s0 e1 specialAbsolute [17.5].

**R2.38 Batch path.** `Series Title 921-928 [..]/921.mkv` -> abs `[921]` (file name wins).

**R2.39 Season-less batch title (`isSeasonTitle`).** `[Group] Series Title Curse (BS11 1280x720 x264 AAC)` -> title `Series Title Curse`,
fullSeason true, isSeasonTitle true, seasons `[]`. Dots retained in this mode (`Series.Title - Curse`). Rejected when stripping
leaves only metadata, for extras (OVA, Special, NCOP, NCED), and when any normal regex parses (`S02E05`, `- 05`, `S02`).

**R2.40 SubGroup.** The leading bracket is `subGroup` and `releaseGroup`: `[GHOST][1080p] Series - 25` -> GHOST.
`Anime-Series Title S04 - 12` -> title `Anime-Series Title S4` (see C5).

### 2.6 Seasons: full, multi, part, extras

**R2.41 Full season.** `S04`, `Season 4`, `Season4`, `S 01`, `S2014`, `Saison3`, `SAISON.1`, `Stagione.3`, `Temporada 10`, `Sezon 3`,
`[Season 3]`, `(S03)`, `(Season 1)`, `Series 1 (1970)` -> fullSeason true, one season, episodes `[]`. Title keeps a year
(`Series 2021 S04`) and numeric tails like `00`/`100`.

**R2.42 Bare season folders reject.** Input exactly `Season 3` is a folder, not a release. `Series.of.Sonarr.S03.720p.BluRay-CLUE\REWARD`
keeps title `Series of Sonarr`.

**R2.43 Multi-season.** `S01-05`, `S01-S09`, `S01 - S07`, `Season 01-07`, `Season 01 - Season 07`, `S01 S04`, `S01 04` -> inclusive range;
`S01 S02 S03 S04` -> list; `S01 S03 S04` -> [1,3,4] (three or more tokens are an explicit list, two tokens are a range:
`Series Title S01 S04` -> [1,2,3,4]). Flags: fullSeason true, isPartialSeason false, isMultiSeason true.

**R2.44 Season part.** `S02.Part.1`, `S07.Vol.1`, `S06.P1`, `S03 - Vol.02`, `S03 Part 2` -> isPartialSeason true, seasonPart N, fullSeason false.

**R2.45 Season extras.** `S05 EXTRAS`, `S03.Extras.01.Deleted.Scenes`, `SUBPACK` -> fullSeason true, isSeasonExtra true.

**R2.46 `[Group] Title 2 S01`** -> title `Series Title 2`, season 1 (number before season token stays in title).

### 2.7 Mini-series, specials, season 0

**R2.47 Mini-series.** `Part 2` style with no season -> season 1 episode 2, isMiniSeries true.

**R2.48 Special detection (`isPossibleSpecialEpisode`).** True for `S02.Special-Inside...`, `S05.Special`, `S11E00.A.Christmas.Carol.Special`;
false when the word sits in the title: `Big.Special.Show.S05`. Season 0 in `S00E16`, `0x01`, folder `Specials`.

### 2.8 SeriesTitleInfo (title-info.json)

**R2.49 Year split.** `title` includes the year, `titleWithoutYear` removes it, `year` is the number (0 when none).
`Series.2022.S03E14`, `Series (2022)`, `Series_2022_` -> titleWithoutYear `Series`, year 2022; `Series Title 2004` -> `Series Title`.
No year -> title == titleWithoutYear, year 0.

**R2.50 Numeric titles.** `1234 2022` -> titleWithoutYear `1234`, year 2022; `1234 S03E14` -> year 0 (the number is the title).

**R2.51 Country.** `country` is a trailing country/variant tag (`US`, `UK`, `AU`) or null. No fixture in title-info.json
exercises a country value; implementers must output null when absent and may recognise only those suffixes.

---

## 3. Movies

**R3.1 Title, year.** Title is everything before the year (or before release metadata). `1776.1979` -> `1776`, 1979; `8.2019` -> `8`;
`Cars.2.German.DL` -> `Cars 2`, year 0.

**R3.2 Several years.** The year is the last plausible year before release info: `Klasse von 1999.1990` -> title `Klasse von 1999`, year 1990;
`Rokudenashi Blues 1993 (1993)` keeps `1993` in title, year 1993; `A Fake Movie 2035 2012 Directors` keeps 2035 in title, year 2012.
A parenthesised or bracketed year wins: `World Movie Z Movie [2023]` -> 2023; `Movie Name (1897) [DVD].mp4` -> 1897.

**R3.3 Leading parenthesised tokens.** `(500).Days.Of.Movie.(2009)` -> `(500) Days Of Movie`; `(1995) Movie Name` -> `Movie Name`.

**R3.4 Subtitle after colon kept.** `Movie: The Movie World 2013`. Roman numerals remain in titles; 1-20 map I..XX both ways (roman-numerals.json).

**R3.5 Trailing junk dropped.** Bracketed tags after the year, `German`, `TRUEFRENCH`, `DL`, `Dubbed` and corrupt characters after the year are cut:
`Mission Movie: Rogue Movie (2015)\uFFFD[XviD...` -> title ends at the year.

**R3.6 Anime movie.** `[MTBB] Kimi no Na wa. (2016) v2` -> title `Kimi no Na wa` (trailing dot removed), group MTBB, year 2016, version 2.
No year: `Evangelion 1.11 - You Are (Not) Alone v2` -> `Evangelion 1 11 - You Are (Not) Alone`.

**R3.7 Version.** `2018v2`, `2018 v2` -> version 2; default 1 (anime-version.json for movies).

### 3.1 Editions (edition.json)

**R3.8 Output preserves input casing and word spelling.** Vocabulary: `Directors Cut`, `Director's Cut`, `Directors`, `Despecialized`,
`Special Edition`, `Special Edition Remastered`, `Special Edition Fan Edit`, `Extended`, `EXTENDED`, `Extended Cut`, `EXTENDED CUT`,
`RECUT EXTENDED`, `EXTENDED EDITION`, `Extended Directors Cut Fan Edit`, `Extended Directors Cut FanEdit`, `Extended Theatrical Version IMAX`,
`50th Anniversary Edition`, `2in1`, `IMAX`, `Restored`, `Final Cut`, `Assembly Cut`, `Ultimate Hunter Edition`, `Diamond Edition`,
`Ultimate Rekall Edition`, `Signature Edition`, `Open Matte`, `Imperial Edition` (leading `The` dropped from the output).

**R3.9 Position.** The edition can precede or follow the year and is removed from the title (`Movie.Title.Imax.2018` -> title `Movie Title`,
edition `Imax`; `Movie.1987.Ultimate.Hunter.Edition` -> edition after the year).

**R3.10 Not editions (edition null).** Title words (`Holiday.Special`), an edition at the very start (`Directors.Cut.German.2006`),
`Uncut.Movie`, `The.Christmas.Edition.1941`, source tags like `TS` (`Loving.Movie.2018.TS.FRENCH`), `Movie Impossible: Rogue Movie 2012 Bluray`.

### 3.2 IDs

**R3.11 External ids.** `{tmdbid-43074}`, `[tmdb-43074]`, `{tmdb-43074}`, `{tmdb-2020}` (4-digit id is not a year) -> tmdbId number.
`[tt1234567]`, `[tt12345678]` -> imdbId (7 or 8 digits). Ids are stripped from the title.

**R3.12 normalizeImdbId.** `asfd` -> null; `123` -> `tt0000123` (pad to 7); `1234567` -> `tt1234567`; `tt1234567` unchanged;
`tt12345678` and `12345678` -> `tt12345678`.

### 3.3 Hardcoded subs, alternatives, language words

**R3.13 Hardcoded subs.** `KORSUB` -> `KORSUB`; `KORSUBS` -> `KORSUBS`; `HC`, `SUBBED` -> `Generic Hardcoded Subs`.
Not hardcoded (null): `RoSubbed`, `Softsubs`, `Softsubs(HorribleSubs)`, `MultiSubs`.

**R3.14 Alternative titles.** Split on ` AKA `, `aka`, `a.k.a.`, `A.K.A.`, `(aka X)`, ` / ` (including Cyrillic `Енола Голмс / Enola Holmes`).
Result list: the full string first, then each trimmed part; the full string keeps internal double spaces (`Radarr prodavet  AKA Radarr Shift`),
`A.K.A.` is normalised to `AKA` in the full title. `AKA.2002` -> `["AKA"]`; `Aka Rox (2008)` -> `["Aka Rox"]` (title word, no split).

**R3.15 Language words in titles stay.** `The.Good.German`, `The.German.Doctor`, `German.Lancers`, `The.Irishman`, `The.French.Movie`,
`The.Italian.Movie`, `Spanish Killroy was Here`, `The Danish Movie 2015`, `The.German.2019`: they remain in the title and add no language
(languages `["Unknown"]`).

**R3.16 Website prefixes** (`www.Torrenting.com`, `www.5MovieRulz.tc`) removed (R1.2).

---

## 4. Quality

### 4.1 Token families

Token matching is case-insensitive and separator-insensitive (`WEB DL`, `WEB.DL`, `Web-Dl`, `WEBDL`).

| Family (tokens) | Source | Resolution | Modifier | Result |
|---|---|---|---|---|
| `HDTV`, `PDTV`, `DSR`, `TVRip`, `SD-TV`, `HD.TV` with no res | television | 480 (SD tags) / 720 (`HD-TV`, bare `[HDTV]`) | none | SDTV or HDTV-720p |
| `.avi .xvid .divx` extension, `x264-CtrlSD`, `480p/360p/540p` + HDTV | television | 480 | none | SDTV |
| `DVDRip`, `DVD`, `NTSC`, `xvidvd`, `SD-DVD`, `[DVD]` | dvd | 480 | none | DVD |
| `DVD5/9`, `DVDR`, `DVD-R`, `2xDVD9`, `MDVDR` | dvd | 480 | remux | DVD-R (movies) |
| `DVDSCR` | dvd | 480 | screener | DVDSCR |
| `R5` regional | dvd | 480 | regional | REGIONAL |
| `WORKPRINT`, `WP` | workprint | 0 | none | WORKPRINT |
| `CAM`, `HDCAM`, `HQCAM`, `NEWCAM`, `CAMRip`, `HD-CAM` | cam | 0 | none | CAM |
| `TS`, `TSRip`, `TeleSync`, `TeleSynch` | telesync | 0 (name gives 720 token still telesync) | none | TELESYNC |
| `TC`, `TeleCine` | telecine | 0 | none | TELECINE |
| `WEB-DL`, `WEBDL`, `WEB`, `WEBHD`, `iTunesHD`, `AmazonHD`, `NetflixHD`, `AMZN WEB`, `NF WEB`, `WEBDLMux`, `Viva MKV WEB` | web | per res tag | none | WEBDL-xxx |
| `WEBRip`, `WEB-Rip`, `WEBMux`, `WEBRIP` | webRip | per res tag | none | WEBRip-xxx |
| `BluRay`, `Blu-ray`, `BD`, `BDRip`, `BRRip`, `BDMux`, `MBluRay`, `UHD BluRay`, `UHDBD`, `UHDBDRip`, `UHD2BD`, `BDLight`, `HDDVD`, `HD-DVD`, `HDDVDRip` | bluray | per res tag | none | Bluray-xxx |
| bluray + `REMUX`, `BDREMUX`, `UHDRemux`, `Remux-2160p` | blurayRaw | per res tag | remux | Remux-1080p / Remux-2160p |
| `BDISO`, `ISO`, `COMPLETE.BLURAY`, `BD25`, `BD50`, `BD66`, `HD.DVD` w/o res, `Blu-ray AVC DTS-HD MA`, `3D BD`, `UNTOUCHED` | blurayRaw | 1080 | brdisk | BR-DISK (movies) |
| `1080i/720p HDTV` + `MPEG2` (or `Raw-HD`) | televisionRaw | 1080 | rawhd | Raw-HD (series; movies fixture also Raw) |

Resolution tags: `360p/480p/480i/540p` -> 480 (360 and 540 round to 480, `848x480` and `640x480` too); `576p` -> 576; `720p`, `960p`,
`1280x720`, `HD` -> 720; `1080p/i`, `1920x1080`, `FHD`, `1440p` -> 1080; `2160p`, `4K`, `UHD`, `UltraHD`, `3840x2160` -> 2160.

Examples: `Movie.Name.S04E10.480p.WEB-DL.x264-mSD` -> WEBDL-480p; `Movie.Title.2013.960p.WEB-DL.AAC2.0.H.264-squalor` -> WEBDL-720p;
`Movie Name.S02E04.1440p` family -> 1080; `Movie Name 2020 WEB-DL 4K H265 10bit HDR DDP5.1 Atmos-PTerWEB` -> WEBDL-2160p;
`Movie.Title.2014.2160p.BDRip.AAC.7.1.HDR10.x265.10bit-Markll` -> Bluray-2160p; `Movie.Title.2018.Bluray720p` -> Bluray-720p.

### 4.2 Resolution/source inference

**R4.1 Source and resolution given** -> use both.

**R4.2 Source only.** HDTV/WEB/Bluray with no resolution tag: television -> 720 (bare HDTV) except SD cues -> 480. Observed:
`HDTV` (`[HDTV]`, `HD TV`) -> HDTV-720p; `Movie.Name.S04E05.HDTV.XviD-LOL` -> SDTV (xvid cue); WEB-DL in brackets with no res -> WEBDL-720p;
WEBMux without res -> WEBRip-480p; `Movie.Title.S01E01.Bluray` -> Bluray-720p (disc without res, not remux); `BDRip XviD` -> Bluray-480p;
German `AmazonSD / AmazonHD.x264 DL` without res -> WEBDL-480p.

**R4.3 Resolution only.** `720p` alone -> HDTV-720p; `1080p` alone -> HDTV-1080p; `848x480` -> SDTV; `2160p` alone -> HDTV-2160p; `[480p]` -> SDTV.

**R4.4 Codec hints.** `x264-CtrlSD` -> SDTV; `H265/H266/HEVC` without res on a WEB source -> WEBDL-1080p; Hi10P `1280x720` -> HDTV-720p.

**R4.5 PDTV exception.** `HR.WS.PDTV` (high-res widescreen) -> HDTV-720p; `WS.PDTV.x264` without `HR` -> SDTV.

**R4.6 Remux without 1080/2160 tag.** `720p ... REMUX` and `480i ... REMUX` stay at their own source resolution (Bluray-720p/480p);
`Movie.Hunter.2018.720p.Blu-ray.Remux` -> Bluray-720p.

**R4.7 UHD disc rules.** `UHD BluRay` + `1080p` -> Bluray-1080p; `UHD BluRay` + `2160p` -> Bluray-2160p; `4K.BluRay.Remux.1080p` -> Remux-1080p
(the explicit resolution tag beats `4K`). `Remux` with `2160p` -> Remux-2160p.

**R4.8 Remux by `Hybrid-REMUX`/German `ML` tag.** `1080p BluRay Hybrid-REMUX AVC TRUEHD` -> Remux-1080p; `German.ML.1080p.BluRay.AVC` -> Remux-1080p.

**R4.9 BR-DISK precedence.** BDISO/ISO/COMPLETE/BD25-66 and bluray with AVC/VC-1/MPEG-2 disc audio (`DTS-HD MA`, `TrueHD`, `LPCM`) and no x264/x265
encode token -> BR-DISK even when a 2160p tag is present (`UHD Blu-ray DTS-HD MA 5.1 DV HDR HEVC-UNTOUCHED` -> BR-DISK, resolution 1080 in the vocabulary).

**R4.10 Telecine/telesync resolution** is 0 in the vocabulary regardless of any `720p` tag.

**R4.11 Case.** `Bluray.2160p`-glued forms (`Bluray720p`, `BD720p`, `[BD1080p]`, `720p-AAC`) parse.

**R4.12 Disc-less BD.** `[FFF] Movie - 01 [BD][720p-AAC]` -> Bluray-720p; `[Elysium]Movie.Name.01(BD.720p.AAC.DA)` -> Bluray-720p.

**R4.13 Anime web.** `[HorribleSubs] ... [Web][MKV][h264][480p/720p/1080p/2160p]` -> WEBDL-xxx; no resolution -> WEBDL-720p;
`[SubsPlease] Movie Title (540p)` and `[Erai-raws] ... [540p]` -> WEBDL-480p.

**R4.14 Enum-style names.** `[Bluray-1080p Remux]` -> Remux-1080p; `My series S01E01 1080p-HD-TV` -> HDTV-1080p; `720p-WEB-DL` -> WEBDL-720p;
`1080p-Remux` -> Remux-1080p; `SD-DVD` -> DVD; `480p-WEB-DL` -> WEBDL-480p.

**R4.15 Unknown.** No cue at all (`Some.Movie.S02E15`, `Movie Name - 11x11 - Quickie`, `S01E01.webm`, `The.Web.MT-dd`) -> Unknown (id 0), revision default.
`WEB` as a bare word of the title (`The.Web`) is not a source.

### 4.3 Detection source

**R4.16** `detectionSource` is `name` when source or resolution came from the name, `extension` when only the container extension
decided (`.mkv`, `.avi`), `unknown` otherwise. Fixture fields are per-axis:

| Input | source detection | resolution detection |
|---|---|---|
| `Movie - 2018 [HDTV-1080p]`, `Bluray1080p`, `1920x1080.Bluray` | name | name |
| `Movie.Title.2018.848x480` (resolution only) | unknown | name |
| `Movie.Title.S01E01.Bluray`, `HD.TV`, `SD.TV`, `...PDTV-REPACK-TLA` (source only) | name | unknown |
| `Movie.Title.S01E02.Chained.Heat.mkv`, `...avi`, `[CR] Movie Title - 004 [48CE2D0F].avi` | extension | extension |
| `Movie.Name.S01E02.Chained.Heat.1080p.mkv`, `...720p.avi` | extension | name |

**R4.17 Extension fallback.** `.mkv` -> HDTV-720p; `.avi/.xvid/.divx` -> SDTV; `.m2ts` -> Bluray-720p (`S03E01.The Electric Can Opener Fluctuation.m2ts`).
`.ts` alone is not telesync (`SomeMovie.2018.DVDRip.ts` -> DVD).

### 4.4 Revision

**R4.18 Version.** Default 1. `PROPER` -> version 2, isRepack false. `REPACK`, `RERIP` -> version 2, isRepack true. `REPACK2`, `RERIP2` -> version 3.
Case-insensitive; a trailing `-RP` group suffix after PROPER keeps version 2 (`PROPER.HDTV.x264-RiVER-RP`).

**R4.19 Real.** `real` counts occurrences of an upper-case `REAL` token that is not part of the title: `REAL.REAL.PROPER` -> real 2; `REAL.PROPER` -> 1;
`PROPER.REAL.RERIP` -> real 1, version 2. Lower or mixed case does not count: `real.proper` -> 0; `Real.Proper` -> 0; the title words
`The Real Housewives of Some Place` -> 0. Version is still 2 for these PROPER cases.

**R4.20 Anime version.** `v2` glued (`01v3`, `Episode 02v2`, `S01E01v2`) or spaced (`01 v2`, `S01E01 v2`) or bracketed (`[v2]`, `WEBDL-1080p v2`) -> version N;
no v-tag -> 1. `[DeadFish] Series Title - 01v4` -> 4.

**R4.21 UltraHD.** `UltraHD`, `Ultra HD`, `UHD`, `4K` all imply 2160 when paired with a 2160p tag; `Into the Movie 2016 2160p Netflix WEBRip` -> WEBRip-2160p.

**R4.22 Name -> quality id.** The final quality name is looked up in the shared vocabulary: HDTV-720p=4, WEBDL-720p=5, Bluray-720p=6, WEBDL-1080p=3,
Bluray-1080p=7, HDTV-1080p=9, Raw-HD=10, Remux-1080p=20, Remux-2160p=29, BR-DISK=30, DVD-R=22, DVDSCR=23, WORKPRINT=24, CAM=25, TELESYNC=26,
TELECINE=27, REGIONAL=28, SDTV=1, DVD=2 (see `packages/shared/src/quality.ts`).

---

## 5. Languages

**R5.1 Default.** A release with no language token reports `["Unknown"]`. Fixtures that assert "contains" (exact=false) do not prove absence of other languages.

**R5.2 Token table (case-sensitivity noted).**

| Language | Tokens |
|---|---|
| English | `English`, `Eng`, `EN` (upper-case only; `En` -> Unknown) |
| French | `French`, `FR`, `VF`, `VF2`, `VFF`, `VFQ`, `VFI`, `TRUEFRENCH`, `FRA`, `FRE`, `MULTi.VF`, `VOSTFR+VFF` |
| Spanish | `Spanish`, `Castellano`, `Español Castellano`, `ES`, `Esp`, `Castellano-Inglés` |
| Spanish (Latino) | `Latino`, `Spa(Latino)`, `audio latino` |
| German | `German`, `GERMAN.DUBBED`, `Ger Dub`, `Ger`, `DE`, `SwissGerman`, `German.DL` |
| Italian | `Italian`, `ITA`, `ita` |
| Danish / Dutch / Icelandic | `Danish`, `Dutch`, `Icelandic` |
| Japanese | `Japanese`, `JA`, `JAP`, `JPN`, `Jap` |
| Chinese | `Chinese`, `Cantonese`, `Mandarin`, `CHS`, `CHT`, `BIG5`, `GB`, `繁中`, `繁体`, `简繁`, `国语`, `字幕组`, `中日双语` |
| Korean | `Korean`, `KOR`, `Kor Rus` |
| Latvian | `LAV`, `LV`, `lv`, `LAT`, `LATViAN` |
| Russian | `Russian`, `Rus`, `RU`, `RUS` |
| Polish | `Polish`, `PL`, `PLLEK`, `PL-LEK`, `LEKPL`, `LEK-PL`, `PLDUB`, `PL-DUB`, `DUBPL`, `DUB-PL` |
| Vietnamese | `Vietnamese`, `VIE` |
| Swedish, Norwegian, Finnish, Turkish, Portuguese, Flemish, Greek | full names |
| Hungarian | `HUN`, `HUNDUB`, `Hungarian` |
| Hebrew | `HebDub`, `HebDubbed` |
| Lithuanian / Czech / Arabic / Hindi | `LT` / `CZ` / `ARABIC` / `Hindi` |
| Bulgarian | `BGAUDIO`, `BG.AUDIO` |
| Ukrainian | `Ukr`, `UKR`, `UKRAINIAN` |
| Slovak / Thai | `SK`, `SLOVAK` / `THAI` |
| Portuguese (Brazil) | `Brazilian`, `Dublado`, `pt-BR` |
| Romanian | `RoDubbed`, `ROMANIAN` |
| Catalan | `Cat`, `Catalán`, `català`, `Catala` |
| Azerbaijani / Uzbek | `Azerbaijan.Dubbed`, `Azerbaijani Dubbed` / `Uzbekistan.Dubbed`, `Uzbek.Dubbed` |
| Romansh, Georgian, Irish | `Romansh`, `Rumantsch`, `Romansch`; `Georgian`, `Geo`, `KA`; `Irish`, `Gaeilge`, `EN-Irish` |
| Mongolian, Persian, Bengali, Telugu, Kannada, Albanian, Afrikaans, Marathi, Tagalog, Malayalam, Urdu | names; Telugu also `Tel`; Mongolian also `Khalkha` |

**R5.3 Multiple languages.** All distinct matches are reported in order of appearance: `Eng Fra`, `FR ENG` -> French+English in either order
(asserted as contains); `[Hindi 5.1 + English 5.1]` -> `[Hindi, English]` exact; `Eng Fre Ger Ita Por Spa` -> `[English, French, German, Italian, Portuguese, Spanish]` exact;
`Ukr/Eng` -> Ukrainian+English; `2Ukr/Tur` -> Ukrainian+Turkish; `RU-KA` -> Russian+Georgian; `esp cat`, `SPA-CAT`, `Castellano - Catalán` -> Spanish+Catalan;
`Esp.DD2.0,Ing.DD2.0,Cat.DD2.0` -> `[English, Spanish, Catalan]` as an exact set.

**R5.4 German DL/ML.** `German.DL` -> `["German","Original"]` exact; `ML` -> `["German","Original","English"]`; `Original`/`Orig` alone -> `["Original"]`.
`WEB-DL` / `WEB.DL` / `WEBDL` / `WEB DL` do NOT add Original.

**R5.5 Subtitle-only tags are not audio.** `SUBFRENCH`, `Eng-Subs`, `PL-SUB`, `PLSUB`, `SUB-PL`, and `.en.sub` file names -> Unknown for the
release language. `Catala.Spanish.Subs` still lists Catalan (contains).

**R5.6 Title words excluded.** Only tokens after the title/year region are languages; see R3.15. Language words inside the release group are excluded:
`x264-SKGTV English` -> group SKGTV (and languages English).

**R5.7 Case policy.** Two-letter codes (`EN`, `FR`, `ES`, `DE`, `RU`, `PL`, `LT`, `CZ`, `SK`, `KA`) are matched upper-case only, except `lv` (also lower) per
fixtures (C3).

**R5.8 Portuguese variants.** `Portuguese` full name -> Portuguese; `Brazilian`, `Dublado`, `pt-BR` -> Portuguese (Brazil); in the ISO table `pt`, `por`, `pt-PT`
-> Portuguese; `de-AU` -> null.

**R5.9 Spanish Latino.** `Latino` variants -> `Spanish (Latino)` (Radarr asserts firstLanguage `Spanish (Latino)`).

### 5.1 ISO codes (iso-codes.json)

**R5.10** ISO 639-1/2 codes and `lang-REGION` forms resolve: `en`, `eng`, `en-US`, `en-GB` -> English; `pt`, `por`, `pt-PT` -> Portuguese; `cze` (alternate
code) -> Czech; `ur`, `urd`, `ur-PK` -> Urdu; `rm`, `roh`, `rm-CH` -> Romansh; `ka`, `geo`, `kat`, `ka-GE` -> Georgian; `ga`, `gle`, `ga-IE` -> Irish.
Null: `enus`, `enusa`, `wo`, `fr-CA`, `de-AU`.

### 5.2 Subtitle file names

**R5.11** A language token before the extension sets `subtitleLanguage` (`en`, `EN`, `eng`, `ENG`, `English` -> English); none -> Unknown.
Tags `default`, `forced`, `cc`, `sdh` go to `languageTags`; order `[default, forced]` when both precede the language and `[forced]` when after.
Remaining free text is `subtitleTitle` (`testtitle`, `Full Subtitles`, `mytitle - 1` -> `mytitle`/`mytitle 1`, `ru-something-else` -> Russian + `something-else`).
Only tags / nothing -> language Unknown and `subtitleRawTitle` null.

---

## 6. Release group

**R6.1 Scene suffix.** The group is the text after the last `-` of the release: `.XviD-LOL` -> `LOL`. Space-separated groups are not suffix groups:
`x264 LOL` -> null.

**R6.2 Hyphenated groups kept whole** from a known list or when a hyphen is inside a group: `D-Z0N3`, `Fight-BB`, `Erai-raws`, `Blu-bits`, `DX-TV`,
`FTW-HS`, `VH-PROD`, `Báleygr`, `Hveðrungr`, `-ZR-` -> `ZR`.

**R6.3 Bracket trailing group.** `[RlsGroup]`, `[rl]`, `[TAoE]`, `[HDO]`, `[QxR]`, `[UTR]`, `[SEV]` at the end. A trailing bracket group beats an
earlier hyphenated token (`...-Goki[TAoE]` -> TAoE). Spaced bracket names (`[Data Lass]`) are null while `-DataLass` -> DataLass (C13).

**R6.4 Anime leading group.** The first `[Group]` of an anime release: FFF, HorribleSubs, Anime-Koi, Erai-raws, Tenrai-Sensei, Exiled-Destiny,
`Anime Time`, `Project Angel`, `Hakata Ramen`, GHOST, MTBB, OPFans (from `[OPFans楓雪動漫]`), `喵萌奶茶屋`, `傲娇零&自由字幕组`.

**R6.5 Known exception groups (glued or spaced to the codec tag).** Recognised by name even without a hyphen: Tigole, afm72, Silence, Panda, Ghost, MONOLITH,
Kappa, Natty, RCVR, SAMPA, YOGI, r00t, EDGE2020, `E.N.D`, KRaLiMaRKo, BluDragon, DarQ, KCRT, `BEN THE MEN`/`BEN.THE.MEN`, Vialle, Celdra, HONE, GiLG, LMain,
`Eml HDTeam`/`EML HDTeam`, YIFY, YTS, YTS.MX, YTS.LT, YTS.AG, TMd, Qman, theincognito, Joy, Vyndros, Bandi, Kametsu, CtrlHD, DHD, DusIctv, SEV, ADC, Koten_Gars,
RH, XZVN, HQMUX, ZØNEHD, FreetheFish, `126811`, Garshasp, t3nzin, ImE, Goki. A suffix that merely glues extra text onto them is null: `t3nzinFAKE`, `VialleFAKE`.
`Movie.Should.Not.Use.Dots.2022.1080p.BluRay.x265.10bit.Tigole` -> null while the same with a trailing `)` -> Tigole.

**R6.6 Strip bad suffixes after the group.** A `GROUP-SUFFIX` where the suffix is one of: `RP`, `RP-RP`, `Obfuscated`, `Obfuscation`, `Scrambled`, `NZBgeek`,
`1`, `4P`, `4Planet`, `postbot`, `xpost`, `Rakuv`, `Rakuv02`, `Rakuvfinhel`, `RakuvUS-Obfuscated`, `WhiteRev`, `BUYMORE`, `AsRequested`, `AlternativeToRequested`,
`GEROV`, `Z0iDS3N`, `Chamele0n`, `AlteZachen`, `RePACKPOST`, `sample`, `Pre` returns `GROUP`: `MeGusta-Pre` -> MeGusta. `[N-Z-B]-xpost` after `.mkv` is ignored.

**R6.7 Language word after the group** is stripped: `x264-SKGTV English`, `_English`, `.English` -> SKGTV.

**R6.8 Not groups.** Anime hash (`iKaos [v3] [6AFFEF6B]` -> null); episode titles in brackets (`Hart-Shaped Murder [SDTV][AAC 2.0][x264]` -> null);
quality brackets (`[HDTV-720p]`); audio/video tokens (`REMUX.AVC.DTS-MA.5.1`, `WEB-Rip.DDP.5.1.HEVC`, `DTS-X.MA`, `DTS-ES`); `7s-Series-s02e01-720p.mkv` -> null;
`Subs]` with no group.

**R6.9 Extras.** `S05 EXTRAS DVDRip XviD RUNNER` -> null (space) but `S01.EXTRAS.DVDRip.XviD-RUNNER` -> RUNNER.

**R6.10 Extension excluded** (R1.1).

---

## 7. Hashed releases, paths, crap

**R7.1 Hashed file name.** When the file name is a 32/40-hex hash, gibberish or otherwise non-release, title/quality/group come from the folder:
`C:\Test\Some.Hashed.Release.S01E01.720p.WEB-DL...-Mercury\0e895c37...mkv` -> title `Some Hashed Release`, WEBDL-720p, group Mercury. A hash-like folder
defers to the file name (movies hashed.json). Series uses compact quality names; movies hyphenated (C8). Folder without group -> group null.

**R7.2 Reversed names.** A reversed file name is detected and un-reversed: `yrucreM-462.H.0.2CAA.LD-BEW.p027.10E10S.esaeleR.dehsaH.emoS.mkv` -> `Some Hashed Release`,
WEBDL-720p, Mercury; `...P0801...` -> WEBDL-1080p; `50E50S.denorD.mkv` -> `Droned`, HDTV-720p, group null; `010E70S.nuF.fo.snoS` -> `Sons of Fun`; `11E-20S seires.mkv` -> `series`.

**R7.3 Path fallback (path.json).** Season from folder, episode from file when the file lacks them:
`z:\tv shows\series title (2003)\Season 3\S03E05 - Title.mkv` -> s3 e5; `z:\tv shows\series title\Specials\S00E16 - Dear Title - SD TV.avi` -> s0 e16;
`C:\Test\Series\Season 01\01 Pilot (1080p HD).mkv` and `1 Pilot` -> s1 e1; `Season 1\02 Honor Thy Father` -> e2;
`Season 2\01. Total Series Action - Episode 1 - Monster Cash.mkv` -> s2 e1; `Season 1\02.04.24 - S01E01 - The Rabbit Hole` -> e1 (the date-looking prefix is ignored);
`8 Series Rules - S01E01 - Pilot` -> e1; `S:\TV Drop\Series - 10x11 - Title [SDTV]\1011 - Title.avi` -> s10 e11 (also forward slashes);
`Series Title S02 01.mkv`, `S2 1.mkv`, `S2 10.mkv`, `S02 01.mkv` -> s2 e1/e1/e10/e1;
`C:\Test\Series Title S01 02\Series Title S02 01 1080p WEB-DL.mkv` -> s2 e1 (file beats folder);
`E:\Downloads\tv\Series.Title.S01E01.720p.HDTV\ajifajjjeaeaeqwer_eppj.avi` and `...\tbbt101.avi` -> s1 e1 (folder);
`C:/Test/TV/Series.4x05.HDTV.XviD-LOL` -> s4 e5. `fullSeason` false for all path fixtures.
Multi: `01-03\The Series Title (2010) - 1x01-02-03 - Episode Title HDTV-720p Proper` -> title `The Series Title (2010)`, s1 [1,2,3];
`Season 2\E05-06 - Episode Title HDTV-720p Proper` -> title `""`, s2 [5,6].

**R7.4 Scene check.** `isSceneTitle` (movies) needs title + year + quality + group: `Some.Movie.2..2013.German.DTS.DL.720p.BluRay.x264-Pate` true;
missing any of quality, group, title or a hash-only name -> false. Series scene check needs title + SxxEyy (or Sxx) + quality + `-GROUP`;
`S08E05 - Virtual In-Stanity [WEBDL-720p]` false. `sceneTitle` strips trailing `_`, `.mkv`, `.nzb` and converts `【720p】` to `[720p]`.

**R7.5 Slug.** Strip accents, lowercase, spaces to dashes; specials removed (default) or dashed when `replaceSpecialCharsWithDash` is true; `trimChars` default `-_`
trims the ends; `deduplicateChars` default `-_` collapses runs; null options use defaults. `test-_--_result` -> `test-result`, `test-_-_result` -> `test_result`;
`ß`, `œ`, `Ø` are stripped.

**R7.6 Crap rejection.** Return null series and null movie for: 32/40-hex or other hash-only names, random alphanumerics, `thebiggestmovie1618finale`,
`Big Movie (S01E18) Complete 360p HDTV AAC H.264-NEXT` (movie mode only), `THIS SHOULD NEVER PARSE`, `password - ... yEnc`, and series crap such as
`Sonar TV - Series Title : 02 Road From Code [S04].mp4` is `noThrow`: the parser must not throw on any input.

---

## 8. Normalization

### 8.1 normalizeTitle (series and movies)

Transformations, applied in order:

1. Lowercase.
2. Remove accents/diacritics: `Carnivàle` -> `carnivale`, `Ríkið` -> `rikid` (`ð` -> `d`), `Parler à` -> `parlera`.
3. `NN%` after a digit becomes `NNpercent`: `3%` -> `3percent`, `100%` -> `100percent`.
4. Drop `&` and `'`: `I'm a cyborg, but that's OK` -> `imcyborgbutthatsok`.
5. Remove the standalone words `the`, `and`, `or`, `a`, `an`, `of` when they are separated words in the **middle** (not first or last), separators `.`, `-`, ` `, `_`:
   `Law_and_Order_SVU` -> `lawordersvu`; `Series_and_Title_Sonarr` -> `seriestitlesonarr`; `Series of the Day` -> `seriesday`; `Series of the Day 2` -> `seriesday2`.
   Leading/trailing words stay: `The Office` -> `theoffice`; `Tokyo Ghoul A` -> `tokyoghoula`; `Series Title A` -> `seriestitlea`; `word.theword` unchanged.
6. Remove every remaining non-alphanumeric character: `Castle (2009)` -> `castle2009`; `Series - 4x05` -> `seriestitle` (as parse_series_name); `The Series Bros. (2006)` -> `theseriesbros2006`;
   `The Daily Series -` -> `thedailyseries`; `Mad Series - Season 1 [Bluray720p]` -> `madseries`.
7. Movie variant: the lone-letter article `a` adjacent to single-letter tokens is kept: `word.a.N.K.L.E.word` -> `wordankleword`; `word N K L E a word` -> `wordnkleaword`.

### 8.2 cleanTitle

`cleanTitle` is the series/movie `normalizeTitle` result stored for matching. The parse_series_name fixtures assert `cleanTitle`:
`Bad Format` -> `badformat`; `Series & Title` -> `seriestitle`.

### 8.3 Roman numerals

`I..XX` (1-20) convert both ways; used when comparing movie sequel titles (roman-numerals.json).

---

## 9. Output casing and shape summary

- Titles keep original casing; only separators and metadata change.
- Missing values: strings `""` for empty series title, hash `""`; nullable fields use `null` per types.ts.
- `year` 0 means none. `isMultiSeason` only for season ranges/lists. `fullSeason` true for season packs and for `Sxx` packs, season extras, anime season packs.
- Order of arrays: ascending numeric for expanded ranges; appearance order for explicit lists and languages.

---

## 10. Known contradictions in fixtures

**C1. Old daily dates.** 1950-10-14 is rejected in seven `{year} {month} {day}` template cases, yet `Series Title (1955) - 1954-01-23 05 00 00 - Cottage for Sale.ts`
is accepted with airDate 1954-01-23. A threshold between 1950 and 1954 resolves it; a title-year-sensitive rule would too. Spec: accept dates from 1951 onward (unverifiable).

**C2. Ambiguous dates.** `05-06-2024` and `12.02.2025` are rejected as ambiguous, while `2011.12.02` is accepted and `13.02.2025` is accepted. Consistent only if
year-first dates default to month-first and day-first/month-first forms are rejected when both fields <= 12.

**C3. Language case policy.** `Movie Title 1994 EN 1080p` -> English but `Movie.Title.2010.En.1080p` -> Unknown; both `lv` and `LV` -> Latvian.
Case sensitivity is not uniform.

**C4. Anime season packs vs absolute.** `[Group] Title S01 - 01-12` -> title `Title S01` with absolute 1-12, while `[Group] Title S01 12 13` and
`[Group] Title S1 05` -> season 1, fullSeason true, no episodes. Distinguishable only by dash presence.

**C5. Season token in anime titles.** `Anime-Series Title S04 - 12` -> title `Anime-Series Title S4` (leading zero removed), but `Series Title S03 - EP14` -> `Series Title S03`
and `Title S01 - 01-12` -> `Title S01` (zero kept).

**C6. misc.json `Series.911.S01`.** normalized `series911` but `seriesName` `series 911`; every other row has seriesName equal to the normalized form.

**C7. Release hash null vs empty.** types.ts declares `string | null`; anime fixtures expect `""` when absent.

**C8. Quality name spelling.** `series/hashed.json` expects `WEBDL720p`, `HDTV720p`, `Bluray1080p`, `DVD`; `movies/hashed.json` and the shared vocabulary use `WEBDL-720p`,
`Bluray-1080p`. Both cannot be the canonical output string; compare by id or normalise.

**C9. Parenthesised alternative titles.** `[Judas] Series E (Series J)` -> allTitles `["Series E","Series J"]`, but `Japanse Anime, Title (Anime, Title)` keeps the parentheses in the single title.

**C10. Special word.** `S02.Special` is a possible special but `Big.Special.Show.S05` is not; only title position separates them.

**C11. Remux vs 4K tag.** `Movie.Title.II.2003.4K.BluRay.Remux.1080p` -> Remux-1080p while `Movie Title 1976 2160p UHD Blu-ray DTS-HD MA 5.1 DV HDR HEVC-UNTOUCHED` -> BR-DISK
with resolution 1080 despite a 2160p tag; and `German.ML.2160p.BluRay.HEVC` -> Remux-2160p. Resolution is not always the named one.

**C12. TS tag.** `Loving.Movie.2018.TS.FRENCH` has edition null and quality TELESYNC, while `SomeMovie.2018.DVDRip.ts` (extension) is DVD.

**C13. Spaced bracket groups.** `[Data Lass]` -> null but `[TAoE]`, `[QxR]`, `[HDO]` accepted; the difference is a known-group list or the space only.

**C14. Series.of.Sonarr backslash.** `Series.of.Sonarr.S03.720p.BluRay-CLUE\REWARD` contains a path separator in a name fixture; parse as release name, title `Series of Sonarr`,
group not asserted.

**C15. Duplicate fixtures.** `Series.Stagione.3.HDTV.XviD-NOTAG` and `[HorribleSubs]_Show_Title_-_33_[720p]` appear twice; harmless.
