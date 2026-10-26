# Arclight — design hand-off

Arclight (formerly Media-Tron) is an all-in-one media downloader, indexer and requester. This folder plus the `.dc.html` files at the project root are the complete visual spec. Build to these; when something isn't drawn, compose it from the rules below.

## Files

| File | What it is |
|---|---|
| `Arclight Pages.dc.html` | **Canonical screens.** 01 Dashboard · 02 Library · 03 Series details · 04 Activity queue · 05 Calendar · 06 Settings · 07 Login (session expired) · 08 Setup wizard · 09 404 · 10 Mobile ×2 |
| `Arclight Design Kit.dc.html` | Tokens, type, spacing, glass, light/circuit rules, motion, every component with states, icons, do/don't |
| `Arclight Backdrop.dc.html` | Generator for the grid floor, horizon, spire, background circuit bundle. Port its JS (≈40 lines) to a `<Backdrop>` component or an SVG/canvas layer |
| `Arclight Chrome.dc.html` | Nav rail + top bar |
| `handoff/arclight.css` | Drop-in CSS: variables + `.al-*` component classes + keyframes |
| `handoff/arclight-motion.js` | **v1.1** Backdrop motion layer (ESM, no deps). `mountBackdrop(canvas, opts)` + `backdropGeometry()` |
| `handoff/tokens.json` | Same tokens as JSON (Tailwind/Style Dictionary friendly) |
| `Media-Tron Mockups.dc.html` | Exploration history (rounds 1–4). **Not** a spec — 4a became Dashboard |

Open any `.dc.html` directly in a browser (keep `support.js` alongside).

## The five rules

1. **Glow = live.** Only the connection dot, the active nav bar and active progress glow. Everything else is flat 1px lines.
2. **Cyan is the only accent.** Orange `#ff9a4d` = needs attention (missing, stalled, low disk, rate-limited). Red `#ff5a46` = failed / destructive. Nothing else gets colour.
3. **0° / 45° / 90°, square corners.** No border-radius on panes, buttons, inputs, chips. Round only dots, rings, avatar-less marks and device frames.
4. **Mono is for data.** JetBrains Mono for numbers, sizes, times, paths, format strings, codes and the spaced CAPS section label. Everything else is Archivo.
5. **Plain words.** No sci-fi vocabulary in UI copy. Report facts and causes: "Nyaa is rate-limited. Retry at 20:55." Never invented scores.

## Shell

- **Backdrop** (fixed, z 0): black → `#06222b` radial at the horizon (~52% height), perspective grid (radial lines from the vanishing point + horizontal lines spaced `600/(k+.6)`), 2px horizon line, single spire of light at the vanishing point with a core dot and floor reflection, faint circuit bundle top-right at 16%, scanline 1.5% + vignette on top. Spire is **background only** — keep the screen centre visually open when layout allows. Props: `spire` (off on dense pages like Details), `circuit`.
- **Rail** 84px: diamond mark, 11 two-letter codes — DB Dashboard · LB Library · DS Discover · RQ Requests · CL Calendar · WN Wanted · AC Activity · SB Subtitles · IX Indexers · ST Settings · SY System. Tablet: 64px codes only. Mobile: bottom tab bar (Home, Library, Discover, Activity, More).
- **Top bar** 60px: wordmark, search (underline field, `/` to focus → opens global search overlay), then plain-text status: live dot + "Connected", VPN location, request count, issue count (orange when >0), avatar square → user menu.
- **Content** inset left 124 / right 40 / top 96. Page header = mono index + title-l + page controls, actions right-aligned.

## Surfaces

- `.al-pane` — default container. Square, line-2 border, blur 26, sheen.
- `.al-pane--chamfer-*` + `.al-edge` — **hero** containers only, max 2 per screen (e.g. Dashboard's "Next 24 hours" and "VPN/Storage/Issues"; Login card; wizard card; modal).
- `.al-floatbar` — bulk-select bar, unsaved-changes bar. Bottom-centre (bulk) or bottom of form pane (save).
- Never nest glass more than two levels.

## Screen → feature map (what's drawn, what to compose)

**1 Application shell** — Pages 01–10 show rail/top bar. *Global search overlay*: full-width `.al-pane` dropping from top bar, grouped results (Series / Movies / People / Settings) as 44px rows, mono keyboard hints. *Command palette*: same shell, centred 640px, chamfer-tl. *Side drawer*: `.al-drawer`. *Toasts*: bottom-right stack, max 3. *Keyboard sheet*: modal with two-column mono key list. *Error/404*: Page 09. *Login / session expired*: Page 07 (banner = warn tone). *Setup wizard*: Page 08 — diamond stepper (done = filled, active = glow, todo = dim), one chamfered card per step: Admin → TMDB → Root folders → Download client → Indexer → VPN. Back (ghost) left, Skip (ghost) + Continue (primary) right.

**2 Dashboard** — Page 01. Next 24 hours (chamfer-tl), VPN/Storage/Issues (chamfer-br), Queue with trails, Requests awaiting approval. Indexer/client status chips go in an expandable row under Issues or on System → Status. Two purposeful traces connect the hero panes toward the centre; keep them decorative (`aria-hidden`).

**3 Library** — Page 02 (poster grid + select mode + bulk bar). *Table view*: `.al-table` dense rows. *Overview view*: 1 column of 140px rows: poster 2:3 left, title-m, overview 2 lines, meta chips. Poster size slider changes grid column count (5–10). Empty state: `.al-empty` "No series yet" + Add series / Import folder. *Add new*: search field top, TMDB results as rich rows (poster, title, year, network, overview) with "Add" secondary; add dialog = modal 560px with fields (root, profile, monitor, type, season folder, tags, search on add) and mono path preview line. *Import existing folders*: table with match column (poster + title select) and confidence chip. *Series / Movie details*: Page 03 — backdrop placeholder with left/bottom fade, poster, meta grid (mono values), action bar, tabs: Seasons & episodes / Files / History / Search / Subtitles / Requests. Season accordion with monitor toggle and meter. Episode rows 44px with status chip. *Episode drawer*: `.al-drawer` with still, overview, file info, history list. *Interactive search*: modal 1100px wide, release table (title, indexer, age, size, peers, quality, CF score tags, rejections → `.al-tooltip`, Grab = secondary sm). Movies add: release dates row (In cinemas / Digital / Physical as mono dates), collection link, availability chip. *Collections*: poster grid grouped by collection with meter of owned/total.

**4 Discover & Requests** — Discover home: horizontal sliders of 2:3 posters (title-m section headers, "See all" link). Discover Movies/TV: filter bar (segmented + selects) + infinite poster grid. *Title page*: Details layout without file data; primary "Request" (or "Request 4K" secondary), status chip (Requested / Approved / Available). Request modal: season checklist table, quality target select. *Person page*: Details layout with circle-free square headshot, credits grid. *Requests admin*: tabs Pending / Approved / Declined / Available, rich table with Approve (secondary) / Decline (danger) and bulk float bar. *My requests*: timeline list (mono date left, 1px vertical trace with nodes — one of the few allowed decorative traces). *Issues*: table + detail page with comment thread (square avatars, panes per comment). *Users*: table → detail with permission matrix (checkbox grid), quota meters, linked accounts, notification agents. *Override rules*, *Watchlist*: table/grid patterns above.

**5 Calendar** — Page 05 month. Week: 7 columns × hour rows, events as blocks with 2px left bar. Day: single column. Agenda: grouped list by date. Event bar colour: cyan solid = downloaded, cyan 40% = upcoming, orange = missing. Item popover = `.al-tooltip`-styled pane 320px with poster, title, episode, status chip, actions. iCal dialog: modal with mono URL field + Copy.

**6 Wanted** — Missing and Cutoff unmet: rich table with checkbox, title, episode, air date, chip (`missing` / `cutoff`), "Search" action; bulk bar "Search selected / Search all".

**7 Activity** — Page 04 queue (trails per row, warn/failed rows explain the cause in the chip). History: table + filter bar + details drawer (Mark failed = danger, Redownload = secondary). Blocklist: table + Remove. Pending: table with delay countdown in mono. Remove dialog: modal with checkboxes "Remove from client", "Add to blocklist", "Skip redownload". *Manual import wizard*: wizard stepper in a modal-sized pane: Path → Files → Mapping → Mode → Results.

**8 Subtitles** — Wanted (tabs TV/Movies) table; History; Blacklist; per-item Subtitles tab on Details (table of languages, Search / Upload / Delete / Sync); Language profiles editor (ordered list with drag handles `⋮⋮` in text-5); Providers: card grid of `.al-pane` with credential fields + Test (secondary) showing result toast.

**9 Indexers** — Card grid: `.al-pane` per indexer, name title-m, protocol badge, status chip, priority mono, Test/Edit. Add chooser: modal with search + list of definitions (Torznab/Newznab/native). Editor: settings form + category tree (checkbox tree, 20px indent per level). Cross-indexer search page: search bar + release table (same as interactive search). Stats: simple 1px line/bar charts in cyan with text-4 axes, no fills over 12%. Proxies, app sync: settings forms.

**10 Settings** — Page 06. Left sub-nav (15 items), one form pane, sticky unsaved-changes float bar. Form rows: 220px label column + control + caption help. Section = mono CAPS label. "Show advanced" toggle top-right. Profiles: list of panes → editor with drag-ordered quality list and cutoff marker. Custom formats: card grid with score tags; JSON import modal with mono textarea. Download clients: card grid like Indexers; built-in client page = form groups (Port, Limits, Ratio/time, Interface binding, DHT/PEX, Encryption). VPN: form + live status pane (chamfer-tl) with public IP, port forward, uptime. General: grouped form; API key field mono with Copy / Regenerate (danger). Security: users / sessions / API keys tables.

**11 System** — Status: two-column key/value panes (mono values). Tasks: table with last/next run and "Run now". Health: list of issue rows with tone chip, cause, fix link (same copy rules as Dashboard Issues). Logs: dense mono table, level chip (info = neutral, warn = warn, error = failed), filter bar, live-tail toggle (dot glows only while tailing). Backups: table + Create backup primary + Restore (danger confirm). Updates: changelog panes per version. Audit/events: table.

**12 Components** — all in Design Kit §08; class names in `arclight.css`. Also needed: path picker (input + directory browser list, Page 08), date picker (7-col grid like Calendar, selected = cyan fill), paginator (mono "Page 1 of 4" + ‹ ›), filter bar (row of selects/segmented + "Clear"), accordion (Page 03), popover (= tooltip shell with padding 16), schema-driven form (form-row pattern). Theme specifics: grid floor (Backdrop), scanline (in Backdrop), identity ring (`.al-ring`), light-trail progress (`.al-trail`), derezz delete (`.al-derezz`).

**13 Mobile / PWA** — Page 10. Single column, 20px side padding, panes keep chamfer on the first hero only. Bottom tab bar 86px incl. safe area, active tab = 2px top bar with glow. Swipe actions on rows: left reveals Search (cyan), right reveals Delete (danger). Hit targets ≥ 44px.

## Status vocabulary (use exactly these labels)

Downloaded · Downloading · Importing · Monitored · Unmonitored · Unaired · Queued · Paused · Waiting for air date · Missing · Cutoff unmet · Stalled · Failed (always append cause: "Failed · sample only", "Stalled · no peers").

## Copy rules

- Sentence case everywhere except page titles (Title case) and section labels (MONO CAPS).
- Lead with the object, then the state, then the fix: "/media/tv has 0.9 TB free. Manage".
- Numbers in mono with units: `72.4 MB/s`, `412 GB`, `3d 7h`, `03:00`.
- Buttons are verbs: Save changes, Search monitored, Add series, Approve, Delete series. Destructive confirms name the object.

## Imagery

Posters 2:3 and backdrops 16:9 from TMDB inside square 1px line-2 frames with the sheen gradient on top. Details backdrop fades to black left (92%→20%) and bottom. Never put glow on artwork. Fallback = diagonal stripe pattern (`repeating-linear-gradient(135deg, rgba(110,246,255,.06) 0 1px, transparent 1px 9px)`) with title in text-4.

## Motion layer (v1.1 — ambient light)

Animation is added to **existing** components only; no new UI. Everything below is live in `Arclight Pages.dc.html` (Tweaks: *Motion* on/off, *Speed*).

**Backdrop** — a `<canvas class="al-backdrop__motion">` inside the Backdrop, after the spire and before the scanline/vignette. Port as:

```tsx
import { mountBackdrop } from './arclight-motion';
useEffect(() => {
  const ctl = mountBackdrop(ref.current!, { vx: 0.53, vy: 0.52, spire, circuit, speed: 1 }); // vx/vy: px, or 0–1 fraction of size
  return () => ctl.destroy();
}, [spire, circuit]);
```

When the canvas is mounted, **drop the static horizontal floor lines** — the canvas draws them (drifting toward the viewer). Radial lines, circuit traces, nodes, horizon and spire stay static DOM/SVG. The canvas draws: floor drift · light cycles (comet trails running out from the vanishing point along radial lines, max 2) · circuit pulses (packets down the top-right bundle; end node flashes) · horizon sweep · spire rise · core breathing. All cyan/white, additive. It sizes itself with ResizeObserver, caps DPR at 1.5, and pauses when offscreen or the tab is hidden. Under `prefers-reduced-motion` it paints one static frame. Spire off → no rise/breathe; circuit off → no pulses. The circuit generator uses the same seed as the static Backdrop so paths line up — keep them in sync if you change one.

**Chrome** — `.al-runner--v` on the rail's right border (9s loop), `.al-runner--h` on the top bar's bottom border (12s loop). Connected dot = `.al-live` (breathes).

**Components** — active `.al-trail`: light packet flows through the fill (1.8s). Head dot pulses (existing). Hero `.al-edge`: 7s opacity glint. Dashboard traces: one `.al-trace-pulse` per trace with `--path` set to the trace polyline, second delayed 2.5s.

**Rules** — ambient motion never carries meaning and never uses orange/red. Nothing moves inside text or data. No motion on paused/stalled/failed trails. Keep everything `aria-hidden` and `pointer-events: none`. One global switch (user setting "Reduce motion") should both stop the canvas (`destroy()`) and add `[data-motion="off"] * { animation: none }`.

## Accessibility

Text ≥ 4.5:1 on its glass (text-4 `#7fa6ae` is the minimum for body copy on panes). Focus ring `--al-focus` on everything interactive. Status never by colour alone — chips always carry a label. Honour `prefers-reduced-motion` (handled in css).
