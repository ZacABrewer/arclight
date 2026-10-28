// Non-routed component gallery: every Arclight component in every state. The page re-skin
// agents mount it at /design. Sample copy follows the kit (Pages / Design Kit) and the copy
// rules: sentence case, object → state → fix, mono numbers with units.
import { useState, type ReactNode } from 'react';
import './fonts.js';
import './tokens.css';
import { Backdrop } from './Backdrop.js';
import { ContentInset, MobileTabBar, PageHeader, Rail, TopBar } from './Chrome/index.js';
import { Button, ButtonGroup, LinkButton } from './components/Button.js';
import { Chip, StatusChip } from './components/Chip.js';
import { CommandPalette, GlobalSearchOverlay, type ResultGroup } from './components/CommandPalette.js';
import { Checkbox, RadioGroup, Segmented, Slider, SwitchButton, Toggle } from './components/Controls.js';
import { DatePicker } from './components/DatePicker.js';
import { Derezz } from './components/Derezz.js';
import { Icon, ICON_NAMES, Mark } from './components/Icon.js';
import { Field, FormRow, FormSection, Input, Textarea } from './components/Input.js';
import { KeyboardSheet } from './components/KeyboardSheet.js';
import { KeyValue } from './components/KeyValue.js';
import { BackdropFrame, Poster, PosterCard } from './components/Media.js';
import { Drawer, Modal } from './components/Modal.js';
import { Accordion, AccordionItem, FilterBar, Paginator, Stepper, Tabs } from './components/Navigation.js';
import { FloatBar, FloatBarDivider, Pane } from './components/Pane.js';
import { LiveDot, Meter, Ring, Trail } from './components/Progress.js';
import { SectionHead, SectionLabel } from './components/SectionLabel.js';
import { Select, SelectMenu } from './components/Select.js';
import { Banner, EmptyState, ErrorBlock, Skeleton } from './components/States.js';
import { Table, type Column } from './components/Table.js';
import { CountBadge, ProtocolBadge, QualityTag, ScoreTag, Tag } from './components/Tag.js';
import { Timeline } from './components/Timeline.js';
import { ToastStack, type ToastData } from './components/Toast.js';
import { Menu, Popover, RejectionList, Tooltip } from './components/Tooltip.js';
import { PathPickerField } from './components/PathPickerField.js';
import { STATUS_LABELS, type StatusKey } from './tokens.js';

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="al-gallery__section" id={`al-${n}`}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <span className="al-index">{n}</span>
        <h2 className="al-title-m" style={{ margin: 0 }}>
          {title}
        </h2>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, var(--al-line-a40), transparent)' }} />
      </div>
      {children}
    </section>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="al-gallery__cell">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

interface QueueRow {
  id: string;
  title: string;
  sub: string;
  quality: string;
  protocol: 'torrent' | 'usenet';
  client: string;
  pct: number;
  size: string;
  eta: string;
  status: StatusKey;
  cause?: string;
}

const QUEUE: QueueRow[] = [
  { id: 'q1', title: 'Andor S02E09', sub: 'Andor · Season 2', quality: 'WEB-DL 2160p', protocol: 'torrent', client: 'Built-in', pct: 68, size: '18.2 GB', eta: '4m', status: 'downloading' },
  { id: 'q2', title: 'Fallout S01E08', sub: 'Fallout · Season 1', quality: 'WEB-DL 1080p', protocol: 'torrent', client: 'Built-in', pct: 91, size: '4.1 GB', eta: '38s', status: 'downloading' },
  { id: 'q3', title: 'Dune: Part Two', sub: 'Movie · 2024', quality: 'Remux 2160p', protocol: 'usenet', client: 'SABnzbd', pct: 23, size: '61.8 GB', eta: '41m', status: 'downloading' },
  { id: 'q4', title: 'The Bear S04E02', sub: 'The Bear · Season 4', quality: 'WEB-DL 1080p', protocol: 'torrent', client: 'Built-in', pct: 12, size: '2.3 GB', eta: '—', status: 'stalled', cause: 'no peers' },
  { id: 'q5', title: 'Arrival', sub: 'Movie · 2016', quality: 'Bluray 1080p', protocol: 'usenet', client: 'SABnzbd', pct: 100, size: '9.7 GB', eta: '—', status: 'failed', cause: 'sample only' },
  { id: 'q6', title: 'Silo S02E10', sub: 'Silo · Season 2', quality: 'WEB-DL 2160p', protocol: 'torrent', client: 'Built-in', pct: 100, size: '6.0 GB', eta: '—', status: 'importing' },
  { id: 'q7', title: 'Blade Runner 2049', sub: 'Movie · 2017', quality: 'Remux 2160p', protocol: 'torrent', client: 'Built-in', pct: 0, size: '71.0 GB', eta: '—', status: 'paused' },
  { id: 'q8', title: 'Pluribus S01E04', sub: 'Pluribus · Season 1', quality: '—', protocol: 'torrent', client: '—', pct: 0, size: '—', eta: '09:00', status: 'waiting' },
];

function trailState(r: QueueRow) {
  if (r.status === 'downloading' || r.status === 'importing') return r.pct >= 100 ? 'complete' : 'active';
  if (r.status === 'stalled') return 'stalled';
  if (r.status === 'failed') return 'failed';
  if (r.status === 'paused') return 'paused';
  return 'queued';
}

const QUEUE_COLUMNS: Column<QueueRow>[] = [
  {
    key: 'title',
    header: 'Title',
    sortValue: (r) => r.title,
    cell: (r) => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{r.title}</div>
        <div className="al-caption" style={{ fontSize: 12 }}>
          {r.sub}
        </div>
      </div>
    ),
  },
  { key: 'quality', header: 'Quality', mono: true, cell: (r) => r.quality },
  { key: 'prot', header: 'Prot', cell: (r) => <ProtocolBadge protocol={r.protocol} /> },
  { key: 'client', header: 'Client', muted: true, cell: (r) => r.client },
  { key: 'progress', header: 'Progress', width: '22%', sortValue: (r) => r.pct, cell: (r) => <Trail value={r.pct} state={trailState(r)} showValue /> },
  { key: 'size', header: 'Size', mono: true, cell: (r) => r.size },
  { key: 'eta', header: 'ETA', mono: true, cell: (r) => r.eta },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (r.status === 'failed' || r.status === 'stalled' ? <StatusChip status={r.status} cause={r.cause ?? 'unknown'} /> : <StatusChip status={r.status} />),
  },
];

const LOG_ROWS = Array.from({ length: 2000 }, (_, i) => ({
  id: i,
  time: `19:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
  level: i % 17 === 0 ? 'error' : i % 7 === 0 ? 'warn' : 'info',
  message: i % 17 === 0 ? 'Import failed: only a sample file was found' : i % 7 === 0 ? 'Nyaa is rate-limited. Retry at 20:55.' : `RSS sync found ${i % 23} releases`,
}));

const SEARCH_GROUPS: ResultGroup[] = [
  { label: 'Series', items: [{ id: 's1', label: 'Severance', meta: '2022 · Apple TV+', hint: '↵', onSelect: () => {} }, { id: 's2', label: 'Silo', meta: '2023 · Apple TV+', onSelect: () => {} }] },
  { label: 'Movies', items: [{ id: 'm1', label: 'Arrival', meta: '2016', onSelect: () => {} }] },
  { label: 'People', items: [{ id: 'p1', label: 'Adam Scott', meta: 'Actor', onSelect: () => {} }] },
  { label: 'Settings', items: [{ id: 'x1', label: 'Indexers', meta: 'Settings › Indexers', hint: 'G I', onSelect: () => {} }] },
];

export function ArclightGallery() {
  const [seg, setSeg] = useState('series');
  const [view, setView] = useState('posters');
  const [check, setCheck] = useState(true);
  const [toggle, setToggle] = useState(true);
  const [slider, setSlider] = useState(60);
  const [quality, setQuality] = useState<string | null>('uhd');
  const [radio, setRadio] = useState('standard');
  const [page, setPage] = useState(1);
  const [date, setDate] = useState<string | null>('2026-10-25');
  const [path, setPath] = useState('/media/movies');
  const [step, setStep] = useState(2);
  const [modal, setModal] = useState<null | 440 | 560 | 640 | 1100>(null);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [derezzed, setDerezzed] = useState(false);
  const [gone, setGone] = useState(false);
  const [tab, setTab] = useState('seasons');
  const [tags, setTags] = useState(['family', 'anime']);

  const pushToast = (t: Omit<ToastData, 'id'>) => setToasts((list) => [...list, { ...t, id: Date.now() + Math.random() }]);
  const filteredGroups = SEARCH_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => String(i.label).toLowerCase().includes(query.toLowerCase())) }));

  return (
    <div className="al-app">
      <Backdrop spire circuit />
      <Rail active="DB" homeHref="#" />
      <TopBar
        onSearch={() => setSearch(true)}
        vpnLocation="Amsterdam"
        requestCount={4}
        issueCount={2}
        initials="SK"
        userLabel="Account: sam"
        userMenu={(close) => (
          <Menu
            header="Signed in as sam"
            onDone={close}
            items={[
              { id: 'keys', label: 'Keyboard shortcuts', onSelect: () => setSheet(true) },
              { id: 'acct', label: 'Account settings' },
              { id: 'out', label: 'Sign out', separatorBefore: true },
            ]}
          />
        )}
      />
      <ContentInset>
        <PageHeader index="12" title="Components" subtitle="Every Arclight component in every state" actions={<Button variant="primary" onClick={() => setPalette(true)}>Open command palette</Button>}>
          <Segmented aria-label="Library type" options={[{ value: 'series', label: 'Series' }, { value: 'movies', label: 'Movies' }]} value={seg} onChange={setSeg} />
        </PageHeader>

        <div className="al-gallery">
          <Section n="01" title="Buttons">
            {(['primary', 'secondary', 'ghost', 'danger'] as const).map((v) => (
              <div key={v} className="al-gallery__row">
                <span className="al-caption" style={{ width: 90 }}>
                  {v}
                </span>
                <Button variant={v} size="sm">
                  Small
                </Button>
                <Button variant={v}>{v === 'primary' ? 'Save changes' : v === 'danger' ? 'Delete series' : v === 'ghost' ? 'Cancel' : 'Refresh'}</Button>
                <Button variant={v} size="lg">
                  Large
                </Button>
                <Button variant={v} loading>
                  Saving
                </Button>
                <Button variant={v} disabled>
                  Disabled
                </Button>
                <Tooltip content="Refresh">
                  <Button variant={v} icon={<Icon name="refresh" />} aria-label="Refresh" />
                </Tooltip>
                <Button variant={v} icon={<Icon name="plus" />}>
                  With icon
                </Button>
              </div>
            ))}
            <ButtonGroup>
              <Button variant="danger-solid">Delete series</Button>
              <LinkButton href="#al-01" variant="secondary">
                Link button
              </LinkButton>
            </ButtonGroup>
          </Section>

          <Section n="02" title="Inputs and selection">
            <div className="al-gallery__grid">
              <Cell label="Text input">
                <Field label="Root folder" hint="Absolute path on the server">
                  <Input mono defaultValue="/media/tv" />
                </Field>
                <Field label="API key" error="TMDB rejected this key (401)">
                  <Input mono defaultValue="4f1c-xx" />
                </Field>
                <Field label="URL base" hint="Set by reverse proxy">
                  <Input mono defaultValue="/arclight" disabled />
                </Field>
                <Field label="Search">
                  <Input variant="underline" placeholder="Search" end="/" />
                </Field>
                <Field label="JSON">
                  <Textarea mono defaultValue={'{ "name": "DV" }'} />
                </Field>
              </Cell>
              <Cell label="Selection controls">
                <div className="al-gallery__row">
                  <Toggle checked={toggle} onChange={(e) => setToggle(e.currentTarget.checked)} label={toggle ? 'On' : 'Off'} />
                  <Toggle defaultChecked={false} label="Off" />
                  <Toggle disabled label="Disabled" />
                  <Toggle size="sm" defaultChecked label="Small" />
                  <SwitchButton checked={toggle} onChange={setToggle} aria-label="Kit markup switch" />
                </div>
                <div className="al-gallery__row">
                  <Checkbox label="Checked" checked={check} onChange={(e) => setCheck(e.currentTarget.checked)} />
                  <Checkbox label="Mixed" indeterminate readOnly />
                  <Checkbox label="Unchecked" defaultChecked={false} />
                  <Checkbox label="Also delete 9 files (184 GB)" tone="danger" defaultChecked={false} />
                  <Checkbox label="Disabled" disabled />
                </div>
                <RadioGroup legend="Episode type" direction="row" value={radio} onChange={setRadio} options={[{ value: 'standard', label: 'Standard' }, { value: 'daily', label: 'Daily' }, { value: 'anime', label: 'Anime' }]} />
                <Segmented aria-label="Library type" options={[{ value: 'series', label: 'Series' }, { value: 'movies', label: 'Movies' }]} value={seg} onChange={setSeg} />
                <Segmented variant="soft" aria-label="View" options={[{ value: 'posters', label: 'Posters' }, { value: 'table', label: 'Table' }, { value: 'overview', label: 'Overview' }]} value={view} onChange={setView} />
                <Slider label="Size" value={slider} onChange={setSlider} min={5} max={100} />
                <SelectMenu
                  aria-label="Quality profile"
                  value={quality}
                  onChange={setQuality}
                  options={[
                    { value: 'uhd', label: 'UHD-2160' },
                    { value: 'hd', label: 'HD-1080' },
                    { value: 'any', label: 'Any' },
                  ]}
                />
                <Select aria-label="Multi-episode style" options={[{ value: 'prefixed', label: 'Prefixed range' }, { value: 'extend', label: 'Extend' }]} defaultValue="prefixed" style={{ width: 260 }} />
              </Cell>
            </div>
          </Section>

          <Section n="03" title="Status, tags, protocol">
            <div className="al-gallery__row">
              {(Object.keys(STATUS_LABELS) as StatusKey[]).map((k) =>
                k === 'failed' ? <StatusChip key={k} status="failed" cause="sample only" /> : k === 'stalled' ? <StatusChip key={k} status="stalled" cause="no peers" /> : <StatusChip key={k} status={k} />,
              )}
            </div>
            <div className="al-gallery__row">
              <Chip tone="accent">Requested</Chip>
              <Chip>Approved</Chip>
              <Chip tone="neutral">Available</Chip>
              <Chip tone="warn">Rate-limited</Chip>
              <Chip tone="danger">Error</Chip>
              <Chip tone="muted" dot="ring">
                Disabled
              </Chip>
              <Chip dot="none">info</Chip>
              <StatusChip status="monitored" large />
            </div>
            <div className="al-gallery__row">
              <QualityTag>UHD-2160</QualityTag>
              <QualityTag>WEB-DL 1080p</QualityTag>
              <ProtocolBadge protocol="torrent" />
              <ProtocolBadge protocol="usenet" />
              {tags.map((t) => (
                <Tag key={t} onRemove={() => setTags((l) => l.filter((x) => x !== t))}>
                  {t}
                </Tag>
              ))}
              <Tag>4K HDR</Tag>
              <ScoreTag name="DV" score={150} />
              <ScoreTag name="HDR10" score={50} />
              <ScoreTag name="x265 HD" score={-10000} />
              <span className="al-caption">
                Filter <CountBadge>2</CountBadge>
              </span>
            </div>
          </Section>

          <Section n="04" title="Progress">
            <div className="al-gallery__grid">
              <Cell label="Light trail">
                <Trail value={68} state="active" showValue label="Active" />
                <Trail value={40} state="paused" showValue label="Paused" />
                <Trail value={12} state="stalled" showValue label="Stalled" />
                <Trail value={100} state="failed" showValue label="Failed" />
                <Trail value={100} state="complete" showValue label="Complete" />
                <Trail value={0} state="queued" valueText="Queued" label="Queued" />
              </Cell>
              <Cell label="Meter · ring · live dot">
                <Meter value={58} valueText="6.4 TB free" label="/media/movies" />
                <Meter value={92} tone="warn" valueText="0.9 TB free" label="/media/tv" />
                <Meter value={45} live valueText="live" label="Upload" />
                <Meter value={100} live valueText="done (no glow)" label="Done" />
                <div className="al-gallery__row">
                  <Ring value={68} label="Season completion" />
                  <LiveDot label="Connected" />
                  <LiveDot down label="Disconnected" />
                </div>
              </Cell>
            </div>
          </Section>

          <Section n="05" title="Surfaces">
            <div className="al-gallery__grid">
              <Pane title="Pane" actions={<a href="#al-05">Calendar</a>}>
                <p className="al-caption" style={{ margin: 0 }}>
                  Square corners, line-2 border, blur 26, sheen.
                </p>
              </Pane>
              <Pane chamfer="tl" title="Next 24 hours">
                <p className="al-caption" style={{ margin: 0 }}>
                  Hero pane, chamfer top-left.
                </p>
              </Pane>
              <Pane chamfer="br" title="VPN">
                <p className="al-caption" style={{ margin: 0 }}>
                  Hero pane, chamfer bottom-right.
                </p>
              </Pane>
              <Pane chamfer="tr" title="Chamfer tr">
                <p className="al-caption" style={{ margin: 0 }}>
                  Top-right variant.
                </p>
              </Pane>
              <Pane chamfer="bl" title="Chamfer bl">
                <p className="al-caption" style={{ margin: 0 }}>
                  Bottom-left variant.
                </p>
              </Pane>
              <Pane chamfer="both" title="Login card">
                <p className="al-caption" style={{ margin: 0 }}>
                  Both corners (tl + br).
                </p>
              </Pane>
            </div>
            <FloatBar position="inline" count={3}>
              <Button variant="ghost">Monitor</Button>
              <Button variant="ghost">Profile</Button>
              <Button variant="ghost">Tags</Button>
              <FloatBarDivider />
              <Button variant="danger" size="sm">
                Delete
              </Button>
              <Button variant="ghost" className="al-floatbar__cancel">
                Cancel
              </Button>
            </FloatBar>
            <FloatBar variant="save" position="inline" count={2}>
              <Button variant="ghost">Discard</Button>
              <Button variant="primary">Save changes</Button>
            </FloatBar>
          </Section>

          <Section n="06" title="Overlays">
            <div className="al-gallery__row">
              {([440, 560, 640, 1100] as const).map((s) => (
                <Button key={s} onClick={() => setModal(s)}>
                  Modal {s}
                </Button>
              ))}
              <Button onClick={() => setDrawer(true)}>Drawer</Button>
              <Button onClick={() => setSheet(true)}>Keyboard sheet</Button>
              <Button onClick={() => setPalette(true)}>Command palette</Button>
              <Button onClick={() => setSearch(true)}>Global search</Button>
              <Popover
                label="Episode"
                trigger={(p) => (
                  <Button {...p} variant="secondary">
                    Popover
                  </Button>
                )}
              >
                <div style={{ display: 'flex', gap: 12 }}>
                  <Poster title="Severance" width={60} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="al-body-l">Severance</span>
                    <span className="al-caption">
                      S03E02 · <span className="al-num">03:00</span>
                    </span>
                    <StatusChip status="unaired" />
                  </div>
                </div>
              </Popover>
              <Tooltip content={<RejectionList reasons={['Quality WEB-DL 720p is below cutoff', 'Size 0.4 GB under minimum 1.2 GB']} />}>
                <Button variant="ghost">Rejections</Button>
              </Tooltip>
            </div>
            <div className="al-gallery__row">
              <Button onClick={() => pushToast({ title: 'Imported Silo S02E10', description: 'WEB-DL 2160p · 6.0 GB', action: { label: 'View', onClick: () => {} } })}>Toast</Button>
              <Button onClick={() => pushToast({ title: 'Indexer rate-limited', description: 'Nyaa · retrying at 20:55', tone: 'warn' })}>Warn toast</Button>
              <Button onClick={() => pushToast({ title: 'Import failed', description: 'Arrival · only a sample file was found', tone: 'danger' })}>Danger toast</Button>
            </div>
            <div style={{ maxWidth: 360 }}>
              <ToastStack
                inline
                toasts={[
                  { id: 1, title: 'Settings saved', description: 'Media management' },
                  { id: 2, title: 'Indexer rate-limited', description: 'Nyaa · retrying at 20:55', tone: 'warn', action: { label: 'Details', onClick: () => {} } },
                  { id: 3, title: 'Import failed', description: 'Arrival · only a sample file was found', tone: 'danger', action: { label: 'Fix', onClick: () => {} } },
                ]}
              />
            </div>
            <Banner tone="warn">Your session expired. Sign in to continue.</Banner>
          </Section>

          <Section n="07" title="Tables">
            <Pane chamfer="tl" flush bare>
              <Table
                columns={QUEUE_COLUMNS}
                rows={QUEUE}
                rowKey={(r) => r.id}
                density="rich"
                selectable
                rowLabel={(r) => `Select ${r.title}`}
                defaultSelected={new Set(['q5'])}
                bulkPosition="inline"
                bulkActions={() => (
                  <>
                    <Button variant="danger" size="sm">
                      Remove…
                    </Button>
                    <Button variant="ghost">Retry import</Button>
                  </>
                )}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 24px' }}>
                <Paginator page={page} pageCount={4} onPageChange={setPage} />
              </div>
            </Pane>
            <FilterBar onClear={() => {}} activeCount={2} end={<span className="al-caption">2,000 lines</span>}>
              <Select aria-label="Level" options={[{ value: 'all', label: 'All levels' }, { value: 'warn', label: 'Warn' }]} defaultValue="all" style={{ width: 180 }} />
              <Segmented variant="soft" aria-label="Tail" options={[{ value: 'live', label: 'Live tail' }, { value: 'paused', label: 'Paused' }]} value="live" onChange={() => {}} />
            </FilterBar>
            <Pane flush bare>
              <Table
                caption="Logs (virtualised)"
                columns={[
                  { key: 'time', header: 'Time', mono: true, width: '120px', cell: (r) => r.time },
                  {
                    key: 'level',
                    header: 'Level',
                    width: '110px',
                    cell: (r) => <Chip tone={r.level === 'error' ? 'danger' : r.level === 'warn' ? 'warn' : 'neutral'}>{r.level}</Chip>,
                  },
                  { key: 'msg', header: 'Message', cell: (r) => r.message },
                ]}
                rows={LOG_ROWS}
                rowKey={(r) => r.id}
                virtualize
                maxHeight={360}
                sortable={false}
              />
            </Pane>
            <Table columns={QUEUE_COLUMNS} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title="Queue is empty" action={<Button>Search monitored</Button>}>Nothing is downloading.</EmptyState>} />
            <Table columns={QUEUE_COLUMNS} rows={undefined} rowKey={(r) => r.id} loading />
          </Section>

          <Section n="08" title="Structure">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'seasons', label: 'Seasons & episodes', content: null },
                { id: 'files', label: 'Files', content: null },
                { id: 'history', label: 'History', count: 12, content: null },
                { id: 'search', label: 'Search', content: null },
                { id: 'subs', label: 'Subtitles', content: null, disabled: true },
              ]}
            />
            <Tabs compact aria-label="Activity" tabs={[{ id: 'q', label: 'Queue', count: 8 }, { id: 'h', label: 'History' }, { id: 'b', label: 'Blocklist' }, { id: 'p', label: 'Pending', count: 2 }]} />
            <Accordion>
              <AccordionItem title="Season 3" meta="Airing · 1 of 9 aired" aside={<span className="al-num" style={{ fontSize: 12 }}>1/1</span>}>
                <div style={{ padding: 18 }}>Season 3 episodes</div>
              </AccordionItem>
              <AccordionItem
                defaultOpen
                title="Season 2"
                aside={
                  <>
                    <Toggle size="sm" defaultChecked label="Monitored" />
                    <div style={{ width: 240 }}>
                      <Meter value={80} valueText="8/10 · 248 GB" label="Season 2 completion" />
                    </div>
                    <button type="button" className="al-link">
                      Search season
                    </button>
                  </>
                }
              >
                <div style={{ padding: '8px 18px 18px' }}>
                  <KeyValue
                    layout="grid"
                    items={[
                      { label: 'Path', value: '/media/tv/Severance (2022)' },
                      { label: 'Size on disk', value: '412 GB' },
                      { label: 'Episodes', value: '20 / 22' },
                      { label: 'Next airing', value: 'S03E02 · Mon 03:00', mono: false },
                    ]}
                  />
                </div>
              </AccordionItem>
              <AccordionItem title="Season 1" meta="Complete" aside={<span className="al-num" style={{ fontSize: 12 }}>9/9 · 164 GB</span>}>
                <div style={{ padding: 18 }}>Season 1 episodes</div>
              </AccordionItem>
            </Accordion>
            <Stepper
              current={step}
              onStepClick={setStep}
              steps={['Admin account', 'TMDB key', 'Root folders', 'Download client', 'Indexer', 'VPN'].map((l, i) => ({ id: String(i), label: l }))}
            />
            <ButtonGroup>
              <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep((s) => Math.min(5, s + 1))}>
                Continue
              </Button>
            </ButtonGroup>
          </Section>

          <Section n="09" title="States and data">
            <div className="al-gallery__grid">
              <EmptyState title="No movies yet" action={<Button variant="primary" size="sm">Add movie</Button>}>
                Add one or import a folder.
              </EmptyState>
              <Pane>
                <Skeleton lines={3} />
              </Pane>
              <ErrorBlock title="Couldn't reach TMDB" onRetry={() => {}}>
                Request timed out after 10 s.
              </ErrorBlock>
              <Pane title="Status">
                <KeyValue
                  items={[
                    { label: 'Version', value: '0.9.4' },
                    { label: 'Uptime', value: '3d 7h' },
                    { label: 'Database', value: '/config/arclight.db' },
                    { label: 'Mode', value: 'Docker', mono: false },
                  ]}
                />
              </Pane>
              <Pane title="My requests">
                <Timeline
                  items={[
                    { id: '1', date: '12 Oct', title: 'Blade Runner 2049', description: 'Movie · 4K', aside: <Chip tone="accent">Requested</Chip> },
                    { id: '2', date: '08 Oct', title: 'Severance', description: 'TV · Season 3', aside: <Chip>Approved</Chip> },
                    { id: '3', date: '02 Oct', title: 'Arrival', description: 'Declined: already in library', tone: 'warn' },
                  ]}
                />
              </Pane>
              <Pane title="Section labels">
                <SectionHead label="NEXT 24 HOURS" action={<a href="#al-09">Calendar</a>} />
                <SectionLabel tone="warn" count={2}>
                  Issues
                </SectionLabel>
              </Pane>
            </div>
          </Section>

          <Section n="10" title="Forms and pickers">
            <Pane title="Media management">
              <FormSection label="Episode naming">
                <FormRow label="Rename episodes" captionInline caption="Rename imported files using the format below">
                  <Toggle defaultChecked />
                </FormRow>
                <FormRow label="Standard episode format" htmlFor="fmt" caption="→ Severance - S02E09 - The After Hours [WEBDL-2160p].mkv" captionMono>
                  <Input id="fmt" mono defaultValue="{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]" />
                </FormRow>
                <Field label="Season folder format" inline hint="Used for new series">
                  <Input mono defaultValue="Season {season:00}" />
                </Field>
              </FormSection>
            </Pane>
            <div className="al-gallery__grid">
              <Cell label="Date picker">
                <DatePicker value={date} onChange={setDate} today="2026-10-25" />
              </Cell>
              <Cell label="Path picker">
                <PathPickerField
                  value={path}
                  onChange={setPath}
                  onNavigate={setPath}
                  onAdd={() => {}}
                  crumbs={[
                    { label: '/', path: '/' },
                    { label: 'media', path: '/media' },
                  ]}
                  entries={[
                    { name: 'downloads', path: '/media/downloads', meta: '2.1 TB free' },
                    { name: 'movies', path: '/media/movies', meta: '6.4 TB free' },
                    { name: 'music', path: '/media/music', meta: '6.4 TB free' },
                    { name: 'tv', path: '/media/tv', meta: '0.9 TB free' },
                  ]}
                />
              </Cell>
            </div>
          </Section>

          <Section n="11" title="Imagery and motion">
            <div className="al-gallery__posters">
              <PosterCard title="Severance" meta="2022 · Apple TV+" count="22/22" progress={100} />
              <PosterCard title="Andor" meta="2022 · Disney+" count="18/24" progress={72} selected overlay={<Checkbox aria-label="Select Andor" defaultChecked />} />
              <PosterCard title="Shōgun" meta="2024 · FX" count="6/10" countTone="warn" progress={60} progressTone="warn" />
              <PosterCard title="Dark" meta="2017 · Netflix" count="26/26" progress={100} progressTone="muted" />
              <Poster title="Broken image" src="data:," />
            </div>
            <div style={{ maxWidth: 560 }}>
              <BackdropFrame title="Severance backdrop" fade />
            </div>
            {gone ? (
              <Button size="sm" onClick={() => { setGone(false); setDerezzed(false); }}>
                Restore row
              </Button>
            ) : (
              <Derezz active={derezzed} onDone={() => setGone(true)}>
                <div className="al-pane" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ flex: 1 }}>Foundation · 184 GB</span>
                  <Button variant="danger" size="sm" onClick={() => setDerezzed(true)}>
                    Delete series
                  </Button>
                </div>
              </Derezz>
            )}
          </Section>

          <Section n="12" title="Icons and chrome">
            <div className="al-gallery__row">
              <Mark size={34} />
              {ICON_NAMES.map((n) => (
                <span key={n} title={n} style={{ color: 'var(--al-text-3)' }}>
                  <Icon name={n} size={20} />
                </span>
              ))}
            </div>
            <div className="al-gallery__frame">
              <Backdrop contained width={1100} height={420} vx={0.5} horizon={0.6} />
              <Rail active="LB" />
              <TopBar onSearch={() => {}} connected={false} vpnLocation={null} requestCount={0} issueCount={0} initials="SK" />
              <MobileTabBar active="library" alwaysVisible />
            </div>
          </Section>
        </div>
      </ContentInset>

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        size={modal ?? 440}
        title={modal === 440 ? 'Delete Foundation?' : `Modal ${modal ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              Cancel
            </Button>
            {modal === 440 ? (
              <Button variant="danger-solid" onClick={() => setModal(null)}>
                Delete series
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setModal(null)}>
                Save changes
              </Button>
            )}
          </>
        }
      >
        {modal === 440 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <span>Removes the series from Arclight. Files on disk are kept unless you choose otherwise.</span>
            <Checkbox tone="danger" label="Also delete 9 files (184 GB)" />
            <Checkbox label="Add to import exclusions" defaultChecked />
          </div>
        ) : (
          <Field label="Root folder">
            <Input mono defaultValue="/media/tv" />
          </Field>
        )}
      </Modal>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="S02E09 · The After Hours" footer={<Button variant="danger">Mark failed</Button>}>
        <BackdropFrame title="Episode still" />
        <p>Mark leads a team of office workers whose memories have been surgically divided.</p>
        <KeyValue items={[{ label: 'Quality', value: 'WEB-DL 2160p' }, { label: 'Size', value: '24.6 GB' }]} />
      </Drawer>
      <KeyboardSheet open={sheet} onClose={() => setSheet(false)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} query={query} onQueryChange={setQuery} groups={filteredGroups} />
      <GlobalSearchOverlay open={search} onClose={() => setSearch(false)} query={query} onQueryChange={setQuery} groups={query ? filteredGroups : []} />
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((l) => l.filter((t) => t.id !== id))} />
      <MobileTabBar active="home" />
    </div>
  );
}

export default ArclightGallery;
