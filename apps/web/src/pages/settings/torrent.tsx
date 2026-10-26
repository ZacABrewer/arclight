import { useId, useState, type ReactNode } from 'react';
import type { TorrentEngineState, TorrentSessionStatus, TorrentSettingsResponse, TorrentSettingsUpdate } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Chip, ErrorBlock, FormRow, FormSection, Input, KeyValue, LiveDot, Pane, Skeleton, Toggle, type ChipTone, type KeyValueItem } from '../../arclight/index.js';
import { useSaveTorrentSettings, useTorrentSettings, useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate } from '../../lib/format.js';
import { SettingsPage, useDraft } from './settings-layout.js';

// Settings -> Torrent engine: engine-wide settings of the built-in BitTorrent engine in
// FormSection groups, plus a live status pane on the side. Per-client options (categories,
// save paths) live on the Built-in download client.

const STATE_LABELS: Record<TorrentEngineState, [string, ChipTone]> = {
  disabled: ['Disabled', 'muted'],
  starting: ['Starting', 'default'],
  running: ['Running', 'accent'],
  lockdown: ['Lockdown', 'danger'],
  error: ['Failed', 'danger'],
};

/** Engine state as a chip: Running (accent) · Starting · Disabled (muted) · Lockdown / Failed (danger). */
export function engineBadge(state: TorrentEngineState) {
  const [label, tone] = STATE_LABELS[state];
  return <Chip tone={tone}>{label}</Chip>;
}

export const LOCKDOWN_EXPLANATION = 'VPN down — all torrents paused, sockets bound to 127.0.0.1';

/** "41234 (forwarded by VPN; configured 6881)" and friends. */
export function listenPortText(status: Pick<TorrentSessionStatus, 'listenPort' | 'configuredListenPort'>): string {
  if (status.listenPort === null) return `not listening (configured ${status.configuredListenPort})`;
  if (status.listenPort !== status.configuredListenPort) return `${status.listenPort} (forwarded by VPN; configured ${status.configuredListenPort})`;
  return String(status.listenPort);
}

function vpnText(vpn: TorrentSessionStatus['vpn']): string {
  if (!vpn.bindToVpn) return 'Not bound to the VPN';
  if (!vpn.enabled) return 'Bind to VPN on, VPN integration disabled';
  return [
    vpn.connected ? 'Connected' : 'Disconnected',
    vpn.tunnelAddress ? `tunnel ${vpn.tunnelAddress}` : null,
    vpn.forwardedPort !== undefined ? `forwarded port ${vpn.forwardedPort}` : null,
    vpn.killSwitchEngaged ? 'kill switch engaged' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Live status as key/value rows (mono values). Shared by the settings page and handy elsewhere. */
export function TorrentStatusFields({ status }: { status: TorrentSessionStatus }) {
  const t = status.torrents;
  const items: KeyValueItem[] = [
    { label: 'State', value: engineBadge(status.state), mono: false },
    { label: 'Listening port', value: listenPortText(status) },
    { label: 'Bound address', value: status.boundAddress ?? 'all interfaces' },
    { label: 'VPN binding', value: vpnText(status.vpn), mono: false },
    { label: 'DHT nodes', value: String(status.dhtNodes) },
    { label: 'Connected peers', value: String(status.peers) },
    { label: 'Download', value: formatRate(status.downloadRate) },
    { label: 'Upload', value: formatRate(status.uploadRate) },
    {
      label: 'Torrents',
      value: `${t.total} total · ${t.downloading} downloading · ${t.seeding} seeding · ${t.paused} paused · ${t.queued} queued · ${t.checking} checking · ${t.error} error`,
    },
  ];
  return (
    <div role="group" aria-label="Torrent engine status" className="al-torrent-status">
      {status.state === 'lockdown' ? (
        <p className="al-inline-error" role="alert">
          {LOCKDOWN_EXPLANATION}
          {status.lockdownReason ? ` (${status.lockdownReason})` : ''}
        </p>
      ) : null}
      {status.error ? (
        <p className="al-inline-error" role="alert">
          {status.error}
        </p>
      ) : null}
      <KeyValue items={items} />
    </div>
  );
}

// ---- form draft ----------------------------------------------------------------------

const BOOL_KEYS = ['enabled', 'autoRegisterClient', 'dht', 'pex', 'bindToVpn'] as const;
const INT_KEYS = [
  'listenPort',
  'maxConnections',
  'maxConnectionsPerTorrent',
  'downloadLimitKbps',
  'uploadLimitKbps',
  'maxActiveDownloads',
  'maxActiveSeeds',
] as const;
const NULLABLE_KEYS = ['defaultSeedRatio', 'defaultSeedTimeMinutes'] as const;

type BoolKey = (typeof BOOL_KEYS)[number];
type NumKey = (typeof INT_KEYS)[number] | (typeof NULLABLE_KEYS)[number];

/** Number inputs are kept as text so they can be empty while typing. */
export type TorrentDraft = Record<BoolKey, boolean> & Record<NumKey, string> & { downloadsRoot: string };

export function toTorrentDraft(s: TorrentSettingsResponse): TorrentDraft {
  const draft = { downloadsRoot: s.downloadsRoot } as TorrentDraft;
  for (const k of BOOL_KEYS) draft[k] = s[k];
  for (const k of INT_KEYS) draft[k] = String(s[k]);
  for (const k of NULLABLE_KEYS) draft[k] = s[k] === null ? '' : String(s[k]);
  return draft;
}

/** Draft -> PUT body. Empty nullable numbers mean "unlimited" (null); other empty numbers are omitted. */
export function toTorrentUpdate(draft: TorrentDraft): TorrentSettingsUpdate {
  const body: TorrentSettingsUpdate = { downloadsRoot: draft.downloadsRoot.trim() };
  for (const k of BOOL_KEYS) body[k] = draft[k];
  for (const k of INT_KEYS) {
    const text = draft[k].trim();
    const n = Number(text);
    if (text !== '' && Number.isFinite(n)) body[k] = n;
  }
  for (const k of NULLABLE_KEYS) {
    const text = draft[k].trim();
    const n = Number(text);
    body[k] = text === '' || !Number.isFinite(n) ? null : n;
  }
  return body;
}


type NumField = { key: NumKey; label: string; caption?: string; unit?: string; min?: number; max?: number; step?: string; placeholder?: string };
type BoolField = { key: BoolKey; label: string; caption: string };

function NumRow({ f, value, onChange }: { f: NumField; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={f.label} htmlFor={id} caption={f.caption}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        mono
        className="al-input--num"
        end={f.unit}
        min={f.min}
        max={f.max}
        step={f.step}
        placeholder={f.placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </FormRow>
  );
}

function BoolRow({ f, checked, onChange }: { f: BoolField; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <FormRow label={f.label} caption={f.caption} captionInline>
      <Toggle aria-label={f.label} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </FormRow>
  );
}

/** The engine form groups in page order (handoff §10: Port, Limits, Ratio/time, Interface binding, DHT/PEX, Encryption). */
export const TORRENT_SECTIONS = ['Engine', 'Port', 'Limits', 'Ratio & time', 'Interface binding', 'DHT & PEX', 'Encryption'] as const;

const LIMIT_FIELDS: NumField[] = [
  { key: 'maxConnections', label: 'Max connections', caption: 'Peer connections across all torrents.', min: 1, max: 5000 },
  { key: 'maxConnectionsPerTorrent', label: 'Max connections per torrent', min: 1, max: 1000 },
  { key: 'downloadLimitKbps', label: 'Download limit', unit: 'KiB/s', caption: '0 = unlimited.', min: 0 },
  { key: 'uploadLimitKbps', label: 'Upload limit', unit: 'KiB/s', caption: '0 = unlimited.', min: 0 },
  { key: 'maxActiveDownloads', label: 'Max active downloads', caption: '-1 = unlimited.', min: -1 },
  { key: 'maxActiveSeeds', label: 'Max active seeds', caption: '-1 = unlimited.', min: -1 },
];

const RATIO_FIELDS: NumField[] = [
  { key: 'defaultSeedRatio', label: 'Default seed ratio', caption: 'Stop seeding at this ratio. Empty = unlimited.', min: 0, step: '0.1', placeholder: 'unlimited' },
  { key: 'defaultSeedTimeMinutes', label: 'Default seed time', unit: 'min', caption: 'Stop seeding after this long. Empty = unlimited.', min: 0, placeholder: 'unlimited' },
];

/** Saved value for the draft: the save response until the next refetch lands, then the query. */
function useSavedDraft(data: TorrentSettingsResponse, dataUpdatedAt: number) {
  const [override, setOverride] = useState<{ at: number; value: TorrentDraft } | null>(null);
  const saved = override && override.at >= dataUpdatedAt ? override.value : toTorrentDraft(data);
  return [saved, (res: TorrentSettingsResponse) => setOverride({ at: Date.now(), value: toTorrentDraft(res) })] as const;
}

function TorrentForm({
  data,
  dataUpdatedAt,
  children,
}: {
  data: TorrentSettingsResponse;
  dataUpdatedAt: number;
  children: (form: { body: ReactNode; save: { count: number; onSave: () => void; onDiscard: () => void; saving: boolean } }) => ReactNode;
}) {
  const [saved, setSaved] = useSavedDraft(data, dataUpdatedAt);
  const draft = useDraft(saved);
  const d = draft.value;
  const save = useSaveTorrentSettings();
  const set = <K extends keyof TorrentDraft>(key: K, value: TorrentDraft[K]) => draft.set((prev) => ({ ...prev, [key]: value }));
  const downloadsId = useId();
  const resumeId = useId();

  const body = (
    <form
      aria-label="Torrent engine settings"
      style={{ display: 'flex', flexDirection: 'column', gap: 30 }}
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <FormSection label="Engine">
        <BoolRow f={{ key: 'enabled', label: 'Enable engine', caption: 'Run the built-in torrent engine.' }} checked={d.enabled} onChange={(v) => set('enabled', v)} />
        <BoolRow
          f={{ key: 'autoRegisterClient', label: 'Auto-register client', caption: 'Add a "Built-in" download client on first start when none exists.' }}
          checked={d.autoRegisterClient}
          onChange={(v) => set('autoRegisterClient', v)}
        />
        <FormRow label="Downloads folder" htmlFor={downloadsId} caption="Default download folder. Empty uses the folder shown.">
          <Input id={downloadsId} mono value={d.downloadsRoot} placeholder={data.effectiveDownloadsRoot} onChange={(e) => set('downloadsRoot', e.currentTarget.value)} />
        </FormRow>
        <FormRow label="Resume data folder" htmlFor={resumeId} caption="Fast-resume data and saved .torrent files. Not editable.">
          <Input id={resumeId} mono value={data.resumeDir} readOnly />
        </FormRow>
      </FormSection>
      <FormSection label="Port">
        <NumRow
          f={{ key: 'listenPort', label: 'Listen port', caption: 'Incoming peers (TCP) and DHT (UDP). A port forwarded by the VPN takes precedence.', min: 1, max: 65535 }}
          value={d.listenPort}
          onChange={(v) => set('listenPort', v)}
        />
      </FormSection>
      <FormSection label="Limits">
        {LIMIT_FIELDS.map((f) => (
          <NumRow key={f.key} f={f} value={d[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </FormSection>
      <FormSection label="Ratio & time">
        {RATIO_FIELDS.map((f) => (
          <NumRow key={f.key} f={f} value={d[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </FormSection>
      <FormSection label="Interface binding">
        <BoolRow
          f={{ key: 'bindToVpn', label: 'Bind to VPN', caption: 'Bind every socket to the VPN tunnel and pause all torrents while it is down.' }}
          checked={d.bindToVpn}
          onChange={(v) => set('bindToVpn', v)}
        />
      </FormSection>
      <FormSection label="DHT & PEX">
        <BoolRow f={{ key: 'dht', label: 'DHT', caption: 'Find peers through the distributed hash table (not for private torrents).' }} checked={d.dht} onChange={(v) => set('dht', v)} />
        <BoolRow f={{ key: 'pex', label: 'Peer exchange', caption: 'Exchange peers with connected peers (not for private torrents).' }} checked={d.pex} onChange={(v) => set('pex', v)} />
      </FormSection>
      <FormSection label="Encryption">
        <FormRow label="Peer encryption" caption="The engine does not offer encrypted peer connections yet.">
          <span className="al-muted">Plain connections only</span>
        </FormRow>
      </FormSection>
    </form>
  );

  return (
    <>
      {children({
        body,
        save: {
          count: draft.changes,
          onSave: () => save.mutate(toTorrentUpdate(d), { onSuccess: setSaved }),
          onDiscard: draft.discard,
          saving: save.isPending,
        },
      })}
    </>
  );
}

/** Live status side pane: LiveDot only while the engine is running and connected. */
function LiveStatus() {
  const status = useTorrentStatus();
  const live = status.data?.state === 'running';
  return (
    <Pane
      title="Live status"
      actions={live ? <LiveDot label="Engine running" /> : null}
      aria-label="Live status"
    >
      {status.isPending ? (
        <Skeleton lines={6} />
      ) : status.isError ? (
        <ErrorBlock title="Couldn't read the engine status" onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <TorrentStatusFields status={status.data} />
      )}
    </Pane>
  );
}

export function TorrentSettingsPage() {
  const settings = useTorrentSettings();
  const aside = <LiveStatus />;
  if (!settings.data) {
    return (
      <SettingsPage title="Torrent engine" aside={aside}>
        {settings.isError ? (
          <ErrorBlock title="Couldn't load torrent engine settings" onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        ) : (
          <Skeleton lines={8} />
        )}
      </SettingsPage>
    );
  }
  return (
    <TorrentForm data={settings.data} dataUpdatedAt={settings.dataUpdatedAt}>
      {({ body, save }) => (
        <SettingsPage title="Torrent engine" description="Engine-wide settings of the built-in BitTorrent engine." aside={aside} save={save}>
          {body}
        </SettingsPage>
      )}
    </TorrentForm>
  );
}
