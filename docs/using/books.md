# Books

The Books section keeps your **ebooks** and your **comics** (comics, manga and graphic novels). It does the jobs of Readarr (ebooks) and Mylar3 or Kapowarr (comics): you add authors, books or comic series, Arclight watches for new releases, searches your own indexers, sends the best match to your download client, and files the result in your library with a tidy name. It tells your reading server (Kavita, Komga, Audiobookshelf or Calibre-Web) when a new file arrives.

Arclight is not a reader. It finds, downloads and files books; you read them in the app you already use.

Books is separate from [Audiobooks](library.md), but the two share series and authors (see [Sharing with audiobooks](#sharing-with-audiobooks)).

## Turn it on

Books is off by default. As an administrator open **Settings > General > Features**, switch **Books** on and save. **Books** then appears under **Library** in the left menu, **Books** appears in **Settings**, and ebook and comic requests become possible.

While the switch is off, Arclight does no book work in the background: no refreshes, no searches, no RSS matching and no calendar entries.

## Set up, in order

1. Add a root folder for each kind you want ([Root folders](#root-folders)).
2. Turn on the metadata sources you want ([Metadata sources](#metadata-sources)).
3. Check the format profiles ([Format profiles](#format-profiles)).
4. Make sure you have at least one indexer that offers book categories, and a download client ([Searching](#searching)).
5. Optionally add your reading servers ([Library apps](#library-apps)).
6. Add an author, a book or a comic series ([Adding things](#adding-things)).

## Root folders

Open **Settings > Media management** and add root folders. Two folder types belong to Books:

- **Ebook** - where ebooks are filed.
- **Comic** - where comics, manga and graphic novels are filed.

Keep them separate from each other and from your video and audiobook folders. The Ebook and Comic types only appear once Books is turned on. Where the folder sits relative to your download folder matters for hard links; see [Folders and hard links](../getting-started/folders-and-hardlinks.md).

## Metadata sources

Arclight does not rely on one catalogue. It asks several at the same time, merges the answers and keeps a local copy. This is on purpose: if one service is down, slow or rate limiting you, the others still answer and you lose nothing but freshness.

| Source | Used for | What you need |
| --- | --- | --- |
| Open Library | Ebooks | Nothing. On by default. |
| Google Books | Ebooks | Nothing. On by default. An optional API key raises the request limit. |
| Hardcover | Ebooks | An API token from your Hardcover account (its Settings > API page). Off by default. Without a token the source is skipped even if switched on. |
| Comic Vine | Comics | A free API key from your Comic Vine account. Off by default. |
| Metron | Comics | A Metron account (username and password). Off by default. |

Set them up in **Settings > Books > Metadata**. Keys and passwords are hidden once saved; leave a field empty to keep the stored value.

Also in **Metadata**: **Languages**, a comma-separated list of language codes such as `en, de`. Books in other languages are left out of author catalogues and releases in a clearly different language are rejected. Leave it empty to keep every language. The default is `en`.

### How the sources work together

- Ebook searches ask Open Library, Google Books and Hardcover together (whichever are switched on and usable) and merge them, so a book found in two places shows up once.
- Comic searches ask Comic Vine and Metron. Comics need at least one of the two. With neither set up, comic lookups cannot work.
- Answers are cached on your server: records for 7 days, search results and comic issue lists for 1 day. A fresh cache entry answers without contacting the source at all.
- When a source fails and an older cached answer exists, Arclight uses the old answer instead of failing. A lookup only fails when every enabled source failed and nothing was cached.

### The source chips

On the **Add** screen, each lookup shows a small chip per source:

| Chip | Meaning |
| --- | --- |
| OK | The source answered just now. |
| Cached | The answer came from the local copy, still fresh. |
| Stale | The source failed and an older copy was used. The data may be a little out of date. |
| Failed | The source failed and nothing was cached. Hover for the reason. |
| Off | The source is switched off, or needs a key or login you have not entered. |

A "Failed" or "Stale" chip is not a problem with your library. It means that service is having a bad moment. Try again later.

## Adding things

Open **Library > Books**. The page has an **Ebooks** shelf (authors) and a **Comics** shelf (series), a poster or table view, and filters for missing items and file format. Use **Add author or book** or **Add comic series**.

### Ebooks: authors and books

The Add screen has two tabs.

- **Author** searches by author name. Adding an author adds their whole catalogue, and you choose what to monitor.
- **Book** searches by title or ISBN. Adding a book also adds its author, but the author's other books are added **unmonitored**, so only the book you picked is wanted.

For either, choose the **Root folder** (Ebook type), the **Format profile**, optional tags, and whether to **Start searching for missing items** right away.

### Comics: series

The **Comic series** tab searches Comic Vine and Metron. A "series" here is one run of a title, such as *Saga (2012)*. Besides the root folder and profile, choose a **Series type**:

- **Comic** - single issues, numbered 1, 2, 3.
- **Manga** - volumes are treated as the numbers. A release named "Vol. 3" counts as issue 3.
- **Graphic novel** - collected volumes.

The type changes how releases are matched. For a Comic series, a collected edition is rejected as "not a single issue". You can change the type later from the series page.

### Refreshing

Arclight refreshes monitored authors and series on its own, twice a day (the **BooksRefresh** job in **System > Tasks**). An author with a monitored book that is not out yet is checked daily; others weekly. Click **Refresh** on an author or series page to check right now. If an author or series shows no books, **Refresh** asks the sources again.

## Monitoring

Monitored means "search for it and download it". Unmonitored items stay in the library but are left alone.

### Ebook authors

When you add an author, **Monitor** picks which of their books are wanted:

| Option | Monitors |
| --- | --- |
| All books | Every book. |
| Future books | Only books that are not out yet (books with no date are included). |
| Missing books | Books that have no file yet. |
| Existing books | Books that already have a file. |
| First book | The earliest released book. |
| Latest book | The most recent released book. |
| Books in a series | Only books that belong to a series. |
| None | Nothing. |

**Monitor new books** decides what happens to books that appear later, when Arclight refreshes the author: **All new books**, **New books in a series** or **None**. Turn the author's own **Monitored** switch off to stop all searching for them.

On an existing author, editing the monitor option and saving applies the choice to the books already in the library ("Apply the monitoring choice to books and issues already in the library").

### Comic series

Comic series use the same options except **Books in a series**, with issue wording: **All issues**, **Future issues**, **Missing**, **Existing**, **First issue**, **Latest issue** and **None**.

**Monitor new issues** is the new-issue tracking switch. When it is on, issues announced after you added the series are monitored automatically the next time the series refreshes, so each new issue is searched for when it comes out. Turn it off to track only the issues you picked.

### Single books

Open an author, then tick or untick the monitor control on a single book to watch only that one. The same goes for single issues on a series page.

## Wanted and the calendar

**Library > Books > Wanted** (or **See all** on the Books page) lists monitored items that need work, in two lists:

- **Missing** - monitored, released, and no file. Books with no date are included. Issues use their store date (the on-sale day), falling back to the cover date.
- **Cutoff unmet** - there is a file, but in a format below the profile's cutoff. It only lists items the profile allows to be upgraded.

Filter by Ebooks or Comics. Select items to **Search selected**, or use **Search all missing**, **Search all ebooks** and **Search all comics**.

Ebook and comic releases appear on the [Calendar](calendar.md) and in its iCal feed, marked **Ebook** or **Comic**. For comics the date is the store date when known, otherwise the cover date, which is often a month or two ahead of the real on-sale day.

## Searching

Arclight finds releases on **your own indexers**, the Newznab and Torznab indexers you set up in [Indexers](indexers.md), and sends them to **your download clients** ([Download clients](download-clients.md)). It does not provide or recommend any source of files. If you have no indexer that carries books, Books can track and organise but nothing will download.

### Categories

Searches only look in the book categories of your indexers. Set them in **Settings > Books > Search**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Ebook categories | `7020, 7000` | 7000 is Books, 7020 is EBook. |
| Comic categories | `7030` | 7030 is Comics. |

Enter category numbers separated by commas. Use whatever your indexers call them; if one puts comics under 7000, add 7000 to the comic list.

Ebooks are searched by author and title. Comics are searched by series name and issue number, and Arclight tries both "Series 7" and "Series 007" because release names disagree about padding.

### Automatic searching

There are four ways Arclight searches without you:

- **On add** - if you ticked **Start searching for missing items**.
- **RSS** - every time your indexers' feeds are read, new releases are matched against the wanted list and the best match is grabbed.
- **The missing search** - a periodic sweep of the Wanted lists (below).
- **After a failed download** - when [Media management](media-management.md) has automatic redownload of failed downloads on, the item is searched again.

The missing search runs every **Missing search interval** hours (default 24, set 0 to turn it off). It looks at missing items first, then cutoff-unmet items, oldest-searched first, and handles at most 50 items per run. **Search cooldown** (default 12 hours) stops it from searching an item that was searched more recently, by any means, so your indexers are not hammered. Click **Search all missing** on the Wanted page to run it by hand.

Only the best approved release for an item is grabbed. An item that already has a download in progress is skipped.

### How a release is judged

Each release is checked against the wanted item and its format profile. The release is rejected, with a reason, when:

- **Ebooks:** the title does not match the wanted book (a longer title is a different book, so "Dune Messiah" is not "Dune"), or the author does not match. A matching ISBN passes by itself. Name order is understood both ways round, "Author - Title" and "Title - Author", and "Sanderson, Brandon" matches "Brandon Sanderson".
- **Ebooks:** it is an audiobook, or a collection or pack of several books.
- **Ebooks:** its language is not in your Languages list.
- **Comics:** the series name does not match, or the issue number is not the wanted one (so "001" is the same as "1"; annuals are kept apart from regular issues).
- **Comics:** it is a pack of several issues, or (for a Comic series) a collected edition.
- **Comics:** its year is more than a year before the series began.
- **Both:** the file format is not in the profile.
- **Both:** the size is under the profile's minimum or over its maximum.
- **Both:** the title contains one of the profile's ignored terms.
- **Both:** a torrent has no seeders.
- **Both:** the release failed for you before and is on the blocklist.
- **Both:** a file already exists and this release is not an upgrade (see [Upgrades](#upgrades)).

Among the approved releases the winner is chosen by, in order: how high its format sits in the profile, then preferred terms, a small bonus for retail or digital releases, and a small bonus for seeders. Ties go to the newest release.

### Interactive search

Click **Interactive search** on a book or an issue to see every release your indexers returned. Approved releases come first, best at the top; rejected ones follow with the rejection reasons (hover the rejections icon). Each row shows the indexer, title, size, format, seeders and age.

Click the download button on a release to send it. A rejected release asks you to confirm; choosing it anyway overrides the rejection. Results are kept for 30 minutes, so if you wait too long you will be asked to search again.

## Format profiles

A format profile says which file formats you accept and in what order you prefer them. Edit them in **Settings > Books > Format profiles**. Two profiles are created for you and are shared by all authors and series that use them.

| Profile | Kind | Formats, best first | Cutoff | Size limits |
| --- | --- | --- | --- | --- |
| Ebooks | Ebook | epub, azw3, mobi, pdf | epub | up to 100 MB |
| Comics | Comic | cbz, cbr, cb7, pdf | cbz | up to 2000 MB |

Each profile has:

- **Formats** - tick the formats you accept and move them up or down. Higher is preferred. A release in an unticked format is rejected. A release that does not say its format is allowed and ranked last.
- **Cutoff** - the format at which you are happy. Once a file at the cutoff format or better is on disk, upgrades stop.
- **Upgrades allowed** - when off, a book with a file is never replaced.
- **Minimum size** and **Maximum size** in MB. Leave empty for no limit.
- **Ignored terms** - comma-separated words. A release whose title contains any of them is rejected (not case sensitive). Useful for words like `sample` or a language you do not want.
- **Preferred terms** - comma-separated words. Releases containing them rank above otherwise equal releases.

You can add your own profiles. A profile that an author or series still uses cannot be deleted; move those items to another profile first.

### Upgrades

If a book has a file and upgrades are allowed, a release is only accepted if its format is higher in the profile than the file you have, and the file you have is below the cutoff. A file at or above the cutoff is never replaced automatically. Files below the cutoff show under **Cutoff unmet**. When an upgrade is imported, the old file goes to the recycle bin if you have one set in [Media management](media-management.md).

Supported file types are `epub`, `azw3`, `mobi` and `pdf` for ebooks, and `cbz`, `cbr`, `cb7` and `pdf` for comics. `.azw` and `.kfx` files count as azw3.

## Importing and naming

When a download finishes, Arclight picks the best file of the profile's formats from it, moves it (or hard-links or copies it, following your Media management settings) to the name below, sets permissions, and tells your library apps. If the item already had a file, the old one goes to the recycle bin. If the download has no file in an accepted format, or something fails, it is held in [Activity](activity.md) with a message so you can import it by hand.

### Naming settings

In **Settings > Books > Naming**, **Rename files** turns renaming on or off. When off, the folder still follows the folder format but each file keeps the name it came with.

There are a folder format and a file format for each kind. A `/` in the folder format makes another folder level. The file format is a single name, and Arclight adds the extension.

| Setting | Default |
| --- | --- |
| Ebook folder format | `{Author Name}/{Series Title}/{Book Title} ({Release Year})` |
| Ebook file format | `{Book Title} - {Author Name}` |
| Comic folder format | `{Publisher}/{Series Title} ({Series Year})` |
| Comic file format | `{Series Title} #{Issue Number:000} ({Release Year})` |

With the defaults:

```
Brandon Sanderson/Mistborn/The Final Empire (2006)/The Final Empire - Brandon Sanderson.epub
Image/Saga (2012)/Saga #054 (2018).cbz
```

Empty values disappear cleanly. A book that is not in a series skips the series folder (`Author/Title (Year)/...`), a missing year removes the empty brackets, and a comic with no publisher skips that level. Characters that Windows or Linux would reject are replaced, and names are cut to stay within file system limits.

### Ebook tokens

| Token | Gives | Example |
| --- | --- | --- |
| `{Author Name}` | Author | Brandon Sanderson |
| `{Author SortName}` | Author, last name first | Sanderson, Brandon |
| `{Book Title}` | Title | The Final Empire |
| `{Book Subtitle}` | Subtitle, if any | |
| `{Series Title}` | Series name, if any | Mistborn |
| `{Series Position}` | Number in the series (only when there is a series) | 1 |
| `{Release Year}` | Year | 2006 |
| `{Publisher}` | Publisher | Tor Books |
| `{ISBN}` | ISBN, digits only | 9780765311788 |
| `{Format}` | File type, upper case | EPUB |

### Comic tokens

| Token | Gives | Example |
| --- | --- | --- |
| `{Series Title}` | Series name | Saga |
| `{Series Year}` | Year the series began | 2012 |
| `{Publisher}` | Publisher | Image |
| `{Issue Number}` | Issue number | 54 |
| `{Issue Title}` | Issue title, if any | Chapter Fifty-Four |
| `{Release Year}` | Year of the issue's cover date (or store date) | 2018 |
| `{Volume}` | Volume number | |
| `{Format}` | File type, upper case | CBZ |

`{Volume}` is accepted but is currently left empty when Arclight files a download, so it gives nothing yet.

### Modifiers

Add a colon and a modifier inside the braces.

- **Padding** on `{Series Position}`, `{Issue Number}` and `{Volume}`: zeros set the width. `{Issue Number:000}` turns 54 into `054` and 7 into `007`. A decimal or lettered issue keeps its tail: 12.1 becomes `012.1`. Issues such as `½` or `Annual 2` stay as they are.
- **Length** on text tokens: `{Book Title:30}` cuts the title to 30 characters.
- `{Release Year}`, `{Series Year}`, `{ISBN}` and `{Format}` take no modifier.

The settings page checks your formats as you type and tells you about unknown tokens, bad modifiers, a path separator in a file format, or a format that would produce an empty name.

## Moving in an existing library (Rescan)

Arclight has no importer for the databases of Readarr, Mylar3 or Kapowarr. You bring your collection across by pointing Arclight at the folders the files are already in and letting it recognise them. Your files are not moved or renamed in the process.

1. Add a root folder of the right type that **is** (or contains) your existing collection. See [Root folders](#root-folders).
2. For **comics**, set **Comic folder format** to match how your folders are laid out first (for example `{Series Title} ({Series Year})` if you have no publisher level). Then add the series. Arclight only recognises a comic file that sits inside the folder the folder format gives the series.
3. For **ebooks**, add the authors (or books). Files are recognised if they sit in the author's folder, or if the author's name can be read from the path (`Author/Title/...` or `Author - Title`).
4. When adding, choose the monitor option **None** or **Missing**, and leave **Start searching for missing items** off, so nothing is downloaded before your files are recognised.
5. On the **Books** page, click **Rescan folders**. (It is the `RescanBooks` command, so you can also start it with the [API](../API.md): `POST /api/v1/books/command` with `{"name":"RescanBooks"}`.)

   Progress and the result appear in **System > Tasks**, for example "matched 412 file(s), removed 0 missing, 9 not matched".
6. Afterwards set the monitor option to **Missing** on authors and series you want completed, so only the gaps are searched.

What Rescan does:

- Files under your Ebook and Comic root folders that Arclight does not know are matched to an author's book (by title, or ISBN) or a series' issue (by issue number, so `001` equals `1`) and recorded **where they are**.
- Files it cannot match are counted as "not matched" and left alone. Usually the author or series is not in the library yet, or the name differs a lot.
- Library records whose file has disappeared from disk are dropped, so the item becomes missing again.
- A book or issue that already has a file keeps it; a second file is not matched to it.

Rescan never moves, renames or deletes files. If you want existing files renamed to your naming settings, that is a separate step.

## Library apps

In **Settings > Books > Library apps** you list the reading servers Arclight should nudge after it imports a file, so the new book shows up without waiting for the server's own schedule. For each app give a name, its **URL** (the address Arclight uses to reach it), its credentials, an optional **Library id**, and which kinds it is told about (**Notify for**: ebook, comic, audiobook). Use **Test** to check the connection.

Library apps are optional. Failures are logged and never stop an import.

| App | What Arclight does after an import |
| --- | --- |
| Kavita | Signs in with your Kavita API key. If you set a **Library id**, asks Kavita to scan that library. Otherwise asks it to scan just the folder that was imported into. **Test** signs in. |
| Komga | Authenticates with an API key, or a username and password. Asks Komga to scan the library with your **Library id**, or every Komga library when it is empty. **Test** lists the libraries. |
| Audiobookshelf | Authenticates with an API key. Asks it to scan the library with your **Library id**, or every book library when empty. Use it for the **audiobook** kind. **Test** lists the libraries. |
| Calibre-Web | Nothing after an import. Calibre-Web has no rescan call; it reads your Calibre library database by itself and finds new books when that changes. **Test** only checks that the address answers. |

So with Calibre-Web, Arclight does not and cannot make it rescan. You need Calibre (or something else) to add the new files to the Calibre library. Arclight does not edit a Calibre database.

Notes:

- Stored API keys and passwords are hidden after saving. Leave the field alone to keep the stored value.
- An app only hears about the kinds ticked in **Notify for**. An app with the **audiobook** kind is also told when an audiobook is imported.
- A **Library id** is the id the app itself uses for the library. Leave it empty if you are unsure; Komga and Audiobookshelf then rescan everything, which is slower but safe.

## Requests

Users can ask for books the same way they ask for movies and shows. Two request types exist:

- **Ebooks** - ebooks by author or title.
- **Comics** - comic series, manga and graphic novels.

### Who can request

A user needs the **Request** permission and the request type turned on. Turn types on or off for one user in **Settings > Users > Manage > Caps and approval**, under **Request types**. The default for new users is under **Default request types for new users** in **Settings > Requests**. See [Request types](discover-and-requests.md#request-types). Administrators are never filtered.

### The flow

1. The user opens **Requests**, chooses the **Books** filter, and searches for an ebook or a comic series.
2. They request it. A book that is already requested or already in the library is refused.
3. The request is **Pending**, unless the user may auto-approve, in which case it is approved at once.
4. A manager reviews it in **Requests**: **Approve**, or **Decline** with an optional reason. Users can delete their own pending requests, and managers can delete any.
5. Approving adds the book (and its author, other books unmonitored) or the comic series to your library and starts a search. It uses the first Ebook or Comic root folder, and the first format profile of that kind.
6. When a file arrives the request shows as **Completed**.

If approval cannot finish, for example because there is no root folder of that type or no format profile, the request is marked **Failed** with the reason. Fix the cause and **Approve** the request again to retry.

## Sharing with audiobooks

Ebooks and audiobooks share their **series**. A series such as Mistborn is one series with both its ebooks and its audiobooks in it, and the ebook series page shows the reading order and a note such as "3 books in this series are also in Audiobooks" with an **Open Audiobooks** link.

An ebook author is linked to the same person in your Audiobooks library when there is one, matched by Open Library id or by name. An ebook author page shows **Also in Audiobooks** when linked.

Nothing else is shared: the files, root folders and monitoring of an ebook and its audiobook are independent, so you can have one without the other.

## Troubleshooting

**Books is missing from the menu.** Turn it on in **Settings > General > Features**.

**I can add Ebook but not Comic folders, or neither type is offered.** The Ebook and Comic types only appear once Books is on. Check **Settings > Media management**.

**The Add screen finds nothing.** Look at the source chips. If everything is Off, switch sources on in **Settings > Books > Metadata**. Comics need a Comic Vine key or a Metron login. If a source says Failed, try again later; Stale and Cached answers are normal.

**Hardcover or Comic Vine is switched on but shows Off.** It is missing its key (**Hardcover API key**, **Comic Vine API key**) or, for Metron, a username and password.

**Nothing is downloading.** Check the list in order: an indexer that carries book categories is set up and enabled; the category numbers in **Settings > Books > Search** match what the indexer uses; the item is monitored (author or series too); it is released; the format profile allows a format releases actually come in; and a download client is set up. Run **Interactive search** on one item; the rejection reasons tell you what is wrong.

**Every release is rejected.** Read the reasons. "title does not match" means the release names a different edition or book; "format ... is not in the profile" means tick that format; "size ... above the maximum" means raise the profile's maximum (comic volumes can be large); "contains ignored term" points at your ignored terms; "language ... is not wanted" points at **Languages**.

**A series' latest issue never appears.** Make sure **Monitor new issues** is on and the series is monitored, then **Refresh** it. Issues are only wanted once their store date (or cover date) has passed.

**The wrong issue or a collected edition was grabbed.** Set the correct **Series type** (Manga treats volumes as numbers; Comic rejects collected editions), and use interactive search for the odd cases.

**A download finished but nothing was imported.** Open [Activity](activity.md). A message says why, such as no file in an accepted format, or the library item was deleted. A format your profile does not list is the usual cause.

**The reading server did not update.** Use **Test** on the app. For Kavita, Komga and Audiobookshelf check the URL (reachable from where Arclight runs, not from your browser) and the key. Check the **Notify for** kinds. Calibre-Web is not told anything by design.

**Rescan says files were not matched.** The author or series must be in the library first, and for comics the file must be inside the series' folder. Compare the folder format with your layout.

**A format profile cannot be deleted.** Authors or series still use it; move them to another profile first.

## Related

- [Library](library.md) - bulk actions, audiobooks and the other media types
- [Indexers](indexers.md) and [Download clients](download-clients.md) - where releases come from
- [Interactive search](interactive-search.md) - the idea behind choosing a release yourself
- [Wanted](wanted.md) and [Calendar](calendar.md)
- [Media management](media-management.md) - root folders, hard links and the recycle bin
- [Discover and requests](discover-and-requests.md)
