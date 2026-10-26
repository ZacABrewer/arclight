# Arclight — React components

React wrappers over the Arclight kit (`design/arclight-kit`). Each component is a thin typed
layer over the kit's `.al-*` classes. **The kit is the spec.** If you need something that
isn't here, build it from the rules below. Don't invent new colours, radii or glows.

```ts
// app entry (once, when the shell switches to Arclight)
import './arclight/fonts.js';    // self-hosted Archivo (variable wght + wdth) + JetBrains Mono 400/500
import './arclight/tokens.css';  // kit CSS verbatim + our layers
// pages
import { Pane, Button, StatusChip, Table } from '../arclight/index.js';
```

Styles live in `src/styles/arclight/`:

| File | What it holds |
|---|---|
| `arclight.css` | **Verbatim copy** of `handoff/arclight.css`. Never edit it; re-copy it when the kit changes. |
| `fonts.css` | Adds `"Archivo Variable"` (the @fontsource family name) after `"Archivo"` in `--al-font`. |
| `layout.css` | Rail, top bar, mobile tab bar, content inset, page header, breakpoints. |
| `components.css` | Classes the kit draws but `arclight.css` doesn't define (radio, slider, stepper, accordion, …). |

The gallery `gallery.tsx` (`ArclightGallery`) renders every component in every state. It isn't routed yet; mount it at `/design`.

## The five rules (enforced by the components; don't fight them)

1. **Glow = live.** Only `LiveDot`, the active `Rail`/`MobileTabBar` bar and active progress (`Trail state="active"`, `Meter live`) glow.
2. **Cyan is the only accent.** Orange = needs attention, red = failed/destructive. `Chip tone` only maps to existing kit colours.
3. **Square corners, 0°/45°/90°.** Round shapes are limited to dots, `Ring`, `Radio` and device frames.
4. **Mono is for data.** Use `KeyValue` (mono values), `Column.mono`, `Input mono`, `.al-num`. Sentences stay in Archivo.
5. **Plain words.** Sentence case. Lead with the object, then its state, then the fix: "/media/tv has 0.9 TB free. Manage". Button labels are verbs. Never write "derezz", "the Grid" or "programs" in the UI.

## Kit → component map

### Shell

| Kit | Component | Key props |
|---|---|---|
| Backdrop (grid floor, horizon, spire, circuit, scanline, vignette) | `Backdrop` | `spire` (turn off on dense pages such as Details), `circuit`, `vx`/`horizon` (fractions; Login uses `vx={.5} horizon={.58}`), `animate` (opt-in floor drift, never runs under reduced motion), `contained` |
| Rail 84px, 11 codes | `Rail` | `active` ('DB'…'SY' or null), `items` (`RAIL_ITEMS` + `href`), `onSelect(code, e)` (call `e.preventDefault()` and route), `compact`, `homeHref` |
| Top bar 60px | `TopBar` | `onSearch` (also bound to `/`), `connected`, `vpnLocation` (string \| null \| undefined), `requestCount`, `issueCount` (orange when > 0), `initials`, `userLabel`, `userMenu={(close) => <Menu …/>}` |
| Mobile tab bar | `MobileTabBar` | `active` ('home' \| 'library' \| 'discover' \| 'activity' \| 'more'), `items`, `onSelect` (shown only below 768px) |
| Page header | `PageHeader` | `index` ("01"), `title`, `children` (controls), `subtitle`, `actions` |
| Content inset 124/40/96 | `ContentInset` | `flushTop` (Details backdrop) |

### Surfaces and overlays

| Kit | Component | Key props |
|---|---|---|
| `.al-pane` | `Pane` | `title` (a string renders as a CAPS label), `actions`, `flush`, `bare`, `chamfer` ('tl' \| 'tr' \| 'bl' \| 'br' \| 'both'; **max 2 per screen**), `small` (16px mobile chamfer), `strong` |
| `.al-floatbar` | `FloatBar`, `FloatBarDivider` | `variant` ('bulk' \| 'save'), `count`, `position` ('fixed' \| 'sticky' \| 'inline') |
| `.al-modal` | `Modal` | `open`, `onClose`, `title`, `footer`, `size` (440 confirm \| 560 add \| 640 \| 1100 interactive search; old 'sm'\|'md'\|'lg' still work), `hideClose`, `initialFocus`. Traps focus; Esc and the scrim close it |
| `.al-drawer` | `Drawer` | `open`, `onClose`, `title`, `footer`, `width` |
| `.al-tooltip` | `Tooltip`, `RejectionList` | `content`, `placement`; wraps one focusable child |
| Popover (tooltip shell, padding 16) | `Popover`, `Menu` | `trigger={(props) => <Button {...props}/>}`, `width` (320), `placement` |
| `.al-toast` (bottom-right, max 3) | `ToastStack`, `Toast`, `ToastViewport` | `ToastViewport store={toasts}` renders the existing `lib/toast` store unchanged; tones info/ok/warning/error map to the kit tones |
| Session-expired banner | `Banner` | `tone` ('info' \| 'warn' \| 'danger'), `action` |
| Keyboard sheet | `KeyboardSheet`, `KeyCombo` | `groups` (defaults to `DEFAULT_SHORTCUTS`) |
| Command palette (640, chamfer-tl) | `CommandPalette` | `open`, `onClose`, `query`, `onQueryChange`, `groups: ResultGroup[]` (data comes in via props) |
| Global search overlay | `GlobalSearchOverlay` | Same props as `CommandPalette`, plus `hint` |

### Controls

| Kit | Component | Key props |
|---|---|---|
| `.al-btn` | `Button`, `LinkButton`, `ButtonGroup` | `variant` ('primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'danger-solid'), `size` ('sm' 32 \| 'md' 38 \| 'lg' 46), `loading`, `icon` (with no children it renders an icon button; add `aria-label` and a `Tooltip`), `iconEnd`, `block` |
| `.al-input` | `Input`, `Textarea` | `variant` ('field' \| 'underline'), `mono`, `size` ('lg' = 44px), `invalid`, `end` (mono hint) |
| `.al-field` | `Field` | Same as the old `FormField`: `label`, `hint`, `error`, `htmlFor`, `inline` |
| Form row 220px | `FormRow`, `FormSection` | `label`, `htmlFor`, `caption`, `captionMono`, `captionInline`, `error` |
| `.al-select` | `Select` (native) / `SelectMenu` (kit listbox drawing) | `options`, `placeholder` / `value`, `onChange`, `width` |
| `.al-seg` | `Segmented` | `options`, `value`, `onChange`, `variant` ('solid' \| 'soft'), `full`, `aria-label` |
| `.al-check` | `Checkbox` | `label`, `hint`, `indeterminate`, `tone="danger"` |
| Radio | `Radio`, `RadioGroup` | `legend`, `options`, `value`, `onChange`, `direction` |
| `.al-toggle` | `Toggle` (native checkbox, role=switch) / `SwitchButton` (the kit's literal `<button>`) | `label`, `size` ('sm' for accordion headers), works controlled or uncontrolled |
| Slider (diamond thumb) | `Slider` | `value`, `onChange`, `min`, `max`, `label`, `formatValue` |
| Date picker (7 columns) | `DatePicker` | `value` ('YYYY-MM-DD'), `onChange`, `min`, `max` |
| Path picker | `PathPickerField` | `value`, `onChange`, `entries`, `crumbs`, `onNavigate`, `onAdd`, `loading`, `error` (data comes in via props: a click selects, a double-click or → opens) |

### Status and data

| Kit | Component | Key props |
|---|---|---|
| `.al-chip[data-status]` | `StatusChip` | `status` takes a key or a label ('cutoffUnmet' or "Cutoff unmet"). `cause` is **required** for failed and stalled ("Failed · sample only"). Also `label`, `dot`, `large` |
| `.al-chip` (other states) | `Chip` | `tone` ('default' \| 'accent' \| 'neutral' \| 'muted' \| 'warn' \| 'danger'), `dot` ('fill' \| 'ring' \| 'none'). Use for Requested/Approved/Available and log levels |
| `.al-tag` / `.al-quality` / `.al-score` / `.al-proto` | `Tag` (`onRemove`), `QualityTag`, `ScoreTag` (`name`, `score`, `highAt`), `ProtocolBadge` (`protocol`), `CountBadge` |
| `.al-meter` | `Meter` | `value`, `tone` ('warn' for low disk), `live` (glows only while live and below 100), `valueText` |
| `.al-trail` | `Trail` | `value`, `state` ('active' \| 'paused' \| 'stalled' \| 'failed' \| 'complete' \| 'queued'), `showValue`, `valueText` |
| `.al-ring` | `Ring` | `value`, `size` (84). One per view |
| `.al-live` | `LiveDot` | `down` |
| `.al-table` | `Table` | Same as the old `Table` (`columns`, `rows`, `rowKey`, sort props, `loading`, `empty`, `onRowClick`), plus `density` ('dense' 44 \| 'rich' 62), `selectable`, `selected`/`onSelectionChange`, `bulkActions={(keys, clear) => …}` (renders the FloatBar), `stickyHeader`, `maxHeight`, `virtualize`; columns add `mono`, `muted` |
| Paginator | `Paginator` | `page`, `pageCount`, `onPageChange` |
| Filter bar | `FilterBar` | `children`, `onClear`, `activeCount`, `end` |
| `.al-tabs` | `Tabs` | Same as the old `Tabs`, plus `count`, `compact`, and tabs without `content` (route-driven) |
| Accordion (season rows) | `Accordion`, `AccordionItem` | `title`, `meta`, `aside` (controls outside the toggle button), `open`/`defaultOpen` |
| Stepper (diamonds) | `Stepper` | `steps`, `current`, `onStepClick` (done steps only) |
| `.al-empty` / `.al-skeleton` / `.al-error` | `EmptyState`, `Skeleton` (`lines`, `shape`), `ErrorBlock` (`onRetry`) |
| Key/value (mono values) | `KeyValue` | `items`, `layout` ('rows' \| 'grid'), `columns` |
| Section label (mono CAPS) | `SectionLabel`, `SectionHead` | `count` ("ISSUES · 2"), `tone`, `action` |
| Poster 2:3 / backdrop 16:9 | `Poster`, `PosterCard`, `BackdropFrame` | `src`, `title` (the alt text and the stripe fallback), `selected`, `progress`, `progressTone`, `fade` |
| `.al-derezz` | `Derezz` | `active`, `onDone` (remove the item there; fires at once under reduced motion) |
| Timeline (date + trace + nodes) | `Timeline` | `items: { date, title, description, tone, aside }` |
| Icons (Lucide idiom, 1.5px stroke, square caps) | `Icon`, `Mark` | `name` (`ICON_NAMES`), `size` 16/20/24, `label` |

Tokens in TS: `STATUS_LABELS`, `STATUS_STYLES` (each status mapped to its tokens.json entry), `resolveStatus`, `SIZE`, `BREAKPOINTS`, `MOTION`, `TOAST_LIMIT`.
Hooks: `useFocusTrap`, `useHotkey`, `useReducedMotion`, `useMediaQuery`, `useVirtualRows`.

## Migrating from the old primitives

| Old (`components/`) | New |
|---|---|
| `Page title subtitle actions` | `<PageHeader index title subtitle actions>` inside `<ContentInset>`. Set `document.title` in the page as before |
| `Card title actions flush` | `Pane` (same props) |
| `Button variant size loading icon` | `Button` (same props, plus `lg`) |
| `Badge tone` / `toneFor` | `Chip tone`: ok→`accent`, info→`default`, warning→`warn`, error→`danger`, neutral→`neutral`. Use `StatusChip` for media states |
| `ProtocolBadge protocol` | `ProtocolBadge` (same prop; shows TOR / NZB) |
| `FormField`, `Input`, `Select`, `Toggle` | `Field`, `Input`, `Select`, `Toggle` (same props) |
| `Modal open onClose title footer size` | `Modal` (same props) |
| `Tabs`, `Table`, `sortRows`, `nextSort`, `EmptyState` | Same names and props |
| `ToastProvider` viewport | `<ToastViewport store={toasts} />` |
| `Spinner` / `LoadingBlock` | `Skeleton` (`lines`) for content. Buttons use `loading` |

## Page recipes (from the handoff README)

- **Shell:** render `<Backdrop spire circuit />`, `<Rail active=…/>`, `<TopBar …/>`, `<ContentInset>{page}</ContentInset>`, `<MobileTabBar/>`, `<ToastViewport/>`, `<GlobalSearchOverlay/>` and `<KeyboardSheet/>` (open it with `useHotkey('?')`). `/` opens search.
- **01 Dashboard:** `PageHeader index="00"` with the date (time in mono) on the right. Two hero panes: "Next 24 hours" uses `Pane chamfer="tl"` with time-mono rows; VPN / Storage / Issues uses `Pane chamfer="br"` with `Meter tone="warn"` for low disk and `SectionLabel tone="warn" count`. Then a 1.7fr / 1fr grid: a Queue `Pane` (rows with `Trail`, mono % and ETA) and a Requests `Pane` (secondary "Approve"). Any decorative traces get `aria-hidden`.
- **02 Library:** header controls are `Segmented` (Series/Movies), a mono count line, `Segmented variant="soft"` (Posters/Table/Overview), Sort, Filter with `CountBadge`, `Slider` (5–10 columns), then the primary "Add series". The grid uses `PosterCard`. Select mode adds a `Checkbox` overlay plus `FloatBar count` (Monitor, Profile, Move, Tags, Refresh, Search | Delete (danger) and Cancel). Table view is `Table density="dense"`. Empty: `EmptyState "No series yet"` with "Add series" and "Import folder".
- **03 Details:** `Backdrop spire={false} circuit={false}`, then a `BackdropFrame fade bleed` header, a `Poster`, `title-xl` with a mono year, a meta line, chips (`StatusChip monitored large`, `QualityTag`, `Tag`), a 4-column `KeyValue layout="grid"`, and an action row (primary "Search monitored", secondary buttons, danger "Delete"). Below that sit `Tabs` and an `Accordion` of seasons (`aside` = small `Toggle`, `Meter`, "Search season") with 44px episode rows and a `StatusChip` per row. The episode drawer is a `Drawer`. Interactive search is a `Modal size={1100}` with a release `Table` (rejections in a `Tooltip` + `RejectionList`, Grab = secondary sm).
- **04 Activity:** `PageHeader` with `Tabs compact` (Queue 8 / History / Blocklist / Pending 2). One `Pane chamfer="tl" flush bare` with `Table density="rich" selectable bulkActions` (Remove… danger, Retry import). Each row shows a `Trail` matching its status and a `StatusChip` with a cause. A `Paginator` sits in the footer.
- **05 Calendar:** month grid inside a `Pane` (7 columns, mono weekday labels, today = cyan date pill). Event bars use a 2px left bar: cyan = downloaded, cyan 40% = upcoming, orange = missing. The item popover is a `Popover` (320px). The view switch is `Segmented variant="soft"`.
- **06 Settings:** a 240px sub-nav with a 2px active bar, plus one `Pane`. Inside it, `FormSection` → `FormRow` (220px labels). "Show advanced" is a `Toggle` at the top right. Unsaved changes show a `FloatBar variant="save" count` with ghost "Discard" and primary "Save changes".
- **07 Login:** `Backdrop vx={.5} horizon={.58}`, `Banner tone="warn"`, `Pane chamfer="both"` with a large `Mark`, `Input size="lg"`, `Checkbox` and `Button variant="primary" size="lg" block`.
- **08 Setup wizard:** a 72px header (mark, wordmark, "Step 3 of 6" in mono), then a `Stepper` and one `Pane chamfer="tl"` per step. `PathPickerField onAdd` and an "ADDED" list go inside. The footer has ghost Back on the left, then ghost "Skip for now" and primary "Continue" on the right.
- **09 404:** mono 120px "404", a title-m heading, a body line, primary "Go to dashboard" and secondary "Report a problem". Use `Backdrop vx={.78} horizon={.65} circuit={false}` and `Rail active={null}`.
- **10 Mobile:** single column with 20px sides. Only the first hero keeps `Pane chamfer small`. `MobileTabBar` replaces the rail. Hit targets are at least 44px.
- **Wanted / Requests / Indexers / System:** build these from rich `Table` + `bulkActions`, `Pane` card grids, `KeyValue` panes, `Timeline` for My requests, and `Chip` tones for log levels (info = neutral, warn = warn, error = danger).
