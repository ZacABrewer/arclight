import { useId, useState, type ReactNode } from 'react';
import { TORRENT_TRANSPORT_DEFAULTS } from '@arclight/shared';
import type { TorrentEncryptionMode, TorrentEngineState, TorrentSessionStatus, TorrentSettingsResponse, TorrentSettingsUpdate } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Chip, ErrorBlock, FormRow, FormSection, Input, KeyValue, LiveDot, Pane, Segmented, Skeleton, Toggle, type ChipTone, type KeyValueItem } from '../../arclight/index.js';
import { useSaveTorrentSettings, useTorrentSettings, useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate } from '../../lib/format.js';
import { SettingsPage, useDraft } from './settings-layout.js';
import { t } from '../../i18n/index.js';

// Settings -> Torrent engine: engine-wide settings of the built-in BitTorrent engine in
// FormSection groups, plus a live status pane on the side. Per-client options (categories,
// save paths) live on the Built-in download client; super-seeding and per-torrent limits are
// set per torrent in the queue drawer.

const STATE_LABELS: Record<TorrentEngineState, [string, ChipTone]> = {
  get disabled() {
    return [t('common.disabled'), 'muted'] as [string, ChipTone];
  },
  get starting() {
    return [t('settings.torrent.starting'), 'default'] as [string, ChipTone];
  },
  get running() {
    return [t('common.running'), 'accent'] as [string, ChipTone];
  },
  get lockdown() {
    return [t('settings.torrent.lockdown'), 'danger'] as [string, ChipTone];
  },
  get error() {
    return [t('status.failed'), 'danger'] as [string, ChipTone];
  },
};

/** Engine state as a chip: Running (accent) · Starting · Disabled (muted) · Lockdown / Failed (danger). */
export function engineBadge(state: TorrentEngineState) {
  const [label, tone] = STATE_LABELS[state];
  return <Chip tone={tone}>{label}</Chip>;
}

export const lockdownExplanation = () => t('settings.torrent.lockdownExplanation');

/** "41234 (forwarded by VPN; configured 6881)" and friends. */
export function listenPortText(status: Pick<TorrentSessionStatus, 'listenPort' | 'configuredListenPort'>): string {
  if (status.listenPort === null) return t('settings.torrent.notListeningConfiguredConfiguredlistenport', { configuredListenPort: status.configuredListenPort });
  if (status.listenPort !== status.configuredListenPort) return t('settings.torrent.listenportForwardedByVpnConfigured', { listenPort: status.listenPort, configuredListenPort: status.configuredListenPort });
  return String(status.listenPort);
}

function vpnText(vpn: TorrentSessionStatus['vpn']): string {
  if (!vpn.bindToVpn) return t('settings.torrent.notBoundToTheVpn');
  if (!vpn.enabled) return t('settings.torrent.bindToVpnOnVpn');
  return [
    vpn.connected ? t('common.connected') : t('common.disconnected'),
    vpn.tunnelAddress ? `tunnel ${vpn.tunnelAddress}` : null,
    vpn.forwardedPort !== undefined ? `forwarded port ${vpn.forwardedPort}` : null,
    vpn.killSwitchEngaged ? 'kill switch engaged' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "12 of 17 (71%)": encrypted peers and their share of connected peers. */
export function encryptedPeersText(status: Pick<TorrentSessionStatus, 'peers' | 'encryptedPeers' | 'encryptedPeerRatio'>): string {
  const ratio = status.encryptedPeerRatio ?? (status.encryptedPeers !== undefined && status.peers > 0 ? status.encryptedPeers / status.peers : 0);
  const percent = `${Math.round(ratio * 100)}%`;
  if (status.encryptedPeers === undefined) return percent;
  return t('settings.torrent.encryptedOfPeers', { encrypted: status.encryptedPeers, peers: status.peers, percent });
}

/** Live status as key/value rows (mono values). Shared by the settings page and handy elsewhere. */
export function TorrentStatusFields({ status }: { status: TorrentSessionStatus }) {
  const item = status.torrents;
  const items: KeyValueItem[] = [
    { label: t('common.state'), value: engineBadge(status.state), mono: false },
    { label: t('settings.torrent.listeningPort'), value: listenPortText(status) },
    { label: t('settings.torrent.boundAddress'), value: status.boundAddress ?? 'all interfaces' },
    { label: t('settings.torrent.vpnBinding'), value: vpnText(status.vpn), mono: false },
    { label: t('settings.torrent.dhtNodes'), value: String(status.dhtNodes) },
    ...(status.dht6Nodes !== undefined ? [{ label: t('settings.torrent.ipv6DhtNodes'), value: String(status.dht6Nodes) }] : []),
    { label: t('settings.torrent.connectedPeers'), value: String(status.peers) },
    ...(status.utpConnections !== undefined ? [{ label: t('settings.torrent.utpConnections'), value: String(status.utpConnections) }] : []),
    ...(status.encryptedPeerRatio !== undefined || status.encryptedPeers !== undefined
      ? [{ label: t('settings.torrent.encryptedPeers'), value: encryptedPeersText(status) }]
      : []),
    { label: t('common.download'), value: formatRate(status.downloadRate) },
    { label: t('common.upload'), value: formatRate(status.uploadRate) },
    {
      label: t('settings.torrent.torrents'),
      value: `${item.total} total · ${item.downloading} downloading · ${item.seeding} seeding · ${item.paused} paused · ${item.queued} queued · ${item.checking} checking · ${item.error} error`,
    },
  ];
  return (
    <div role="group" aria-label={t('settings.torrent.torrentEngineStatus')} className="al-torrent-status">
      {status.state === 'lockdown' ? (
        <p className="al-inline-error" role="alert">
          {lockdownExplanation()}
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
/** Optional transport switches; rows saved before they existed read as the engine defaults. */
const TRANSPORT_KEYS = ['tcp', 'utp', 'ipv6'] as const;

type BoolKey = (typeof BOOL_KEYS)[number] | (typeof TRANSPORT_KEYS)[number];
type NumKey = (typeof INT_KEYS)[number] | (typeof NULLABLE_KEYS)[number] | 'webSeedConnectionsPerTorrent';

/** Number inputs are kept as text so they can be empty while typing. */
export type TorrentDraft = Record<BoolKey, boolean> & Record<NumKey, string> & { downloadsRoot: string; encryption: TorrentEncryptionMode };

export function toTorrentDraft(s: TorrentSettingsResponse): TorrentDraft {
  const draft = { downloadsRoot: s.downloadsRoot, encryption: s.encryption ?? TORRENT_TRANSPORT_DEFAULTS.encryption } as TorrentDraft;
  for (const k of BOOL_KEYS) draft[k] = s[k];
  for (const k of TRANSPORT_KEYS) draft[k] = s[k] ?? TORRENT_TRANSPORT_DEFAULTS[k];
  for (const k of INT_KEYS) draft[k] = String(s[k]);
  for (const k of NULLABLE_KEYS) draft[k] = s[k] === null ? '' : String(s[k]);
  draft.webSeedConnectionsPerTorrent = String(s.webSeedConnectionsPerTorrent ?? TORRENT_TRANSPORT_DEFAULTS.webSeedConnectionsPerTorrent);
  return draft;
}

/** Draft -> PUT body. Empty nullable numbers mean "unlimited" (null); other empty numbers are omitted. */
export function toTorrentUpdate(draft: TorrentDraft): TorrentSettingsUpdate {
  const body: TorrentSettingsUpdate = { downloadsRoot: draft.downloadsRoot.trim(), encryption: draft.encryption };
  for (const k of BOOL_KEYS) body[k] = draft[k];
  for (const k of TRANSPORT_KEYS) body[k] = draft[k];
  for (const k of [...INT_KEYS, 'webSeedConnectionsPerTorrent'] as const) {
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
export const TORRENT_SECTIONS = ['Engine', 'Port', 'Limits', 'Ratio & time', 'Interface binding', 'DHT & PEX', 'Transport', 'Encryption'] as const;

const ENCRYPTION_OPTIONS: { value: TorrentEncryptionMode; readonly label: string }[] = [
  { value: 'preferred', get label() { return t('settings.torrent.encryptionPreferred'); } },
  { value: 'required', get label() { return t('settings.torrent.encryptionRequired'); } },
  { value: 'disabled', get label() { return t('common.disabled'); } },
];

/** Caption under the encryption choice: what the selected mode does. */
export function encryptionCaption(mode: TorrentEncryptionMode): string {
  if (mode === 'required') return t('settings.torrent.encryptionRequiredCaption');
  if (mode === 'disabled') return t('settings.torrent.encryptionDisabledCaption');
  return t('settings.torrent.encryptionPreferredCaption');
}

const LIMIT_FIELDS: NumField[] = [
  { key: 'maxConnections', get label() { return t('settings.torrent.maxConnections'); }, get caption() { return t('settings.torrent.peerConnectionsAcrossAllTorrents'); }, min: 1, max: 5000 },
  { key: 'maxConnectionsPerTorrent', get label() { return t('settings.torrent.maxConnectionsPerTorrent'); }, min: 1, max: 1000 },
  { key: 'downloadLimitKbps', get label() { return t('settings.torrent.downloadLimit'); }, unit: 'KiB/s', get caption() { return t('settings.torrent.n0Unlimited'); }, min: 0 },
  { key: 'uploadLimitKbps', get label() { return t('settings.torrent.uploadLimit'); }, unit: 'KiB/s', get caption() { return t('settings.torrent.n0Unlimited'); }, min: 0 },
  { key: 'maxActiveDownloads', get label() { return t('settings.torrent.maxActiveDownloads'); }, get caption() { return t('settings.torrent.n1Unlimited'); }, min: -1 },
  { key: 'maxActiveSeeds', get label() { return t('settings.torrent.maxActiveSeeds'); }, get caption() { return t('settings.torrent.n1Unlimited'); }, min: -1 },
];

const RATIO_FIELDS: NumField[] = [
  { key: 'defaultSeedRatio', get label() { return t('settings.torrent.defaultSeedRatio'); }, get caption() { return t('settings.torrent.stopSeedingAtThisRatio'); }, min: 0, step: '0.1', get placeholder() { return t('settings.torrent.unlimited'); } },
  { key: 'defaultSeedTimeMinutes', get label() { return t('settings.torrent.defaultSeedTime'); }, unit: 'min', get caption() { return t('settings.torrent.stopSeedingAfterThisLong'); }, min: 0, get placeholder() { return t('settings.torrent.unlimited'); } },
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
      aria-label={t('settings.torrent.torrentEngineSettings')}
      style={{ display: 'flex', flexDirection: 'column', gap: 30 }}
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <FormSection label={t('settings.torrent.engine')}>
        <BoolRow f={{ key: 'enabled', label: t('settings.torrent.enableEngine'), caption: t('settings.torrent.runTheBuiltInTorrent') }} checked={d.enabled} onChange={(v) => set('enabled', v)} />
        <BoolRow
          f={{ key: 'autoRegisterClient', label: t('settings.torrent.autoRegisterClient'), caption: t('settings.torrent.addABuiltInDownload') }}
          checked={d.autoRegisterClient}
          onChange={(v) => set('autoRegisterClient', v)}
        />
        <FormRow label={t('settings.torrent.downloadsFolder')} htmlFor={downloadsId} caption={t('settings.torrent.defaultDownloadFolderEmptyUses')}>
          <Input id={downloadsId} mono value={d.downloadsRoot} placeholder={data.effectiveDownloadsRoot} onChange={(e) => set('downloadsRoot', e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('settings.torrent.resumeDataFolder')} htmlFor={resumeId} caption={t('settings.torrent.fastResumeDataAndSaved')}>
          <Input id={resumeId} mono value={data.resumeDir} readOnly />
        </FormRow>
      </FormSection>
      <FormSection label={t('common.port')}>
        <NumRow
          f={{ key: 'listenPort', label: t('settings.torrent.listenPort'), caption: t('settings.torrent.incomingPeersTcpAndDht'), min: 1, max: 65535 }}
          value={d.listenPort}
          onChange={(v) => set('listenPort', v)}
        />
      </FormSection>
      <FormSection label={t('settings.torrent.limits')}>
        {LIMIT_FIELDS.map((f) => (
          <NumRow key={f.key} f={f} value={d[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </FormSection>
      <FormSection label={t('settings.torrent.ratioTime')}>
        {RATIO_FIELDS.map((f) => (
          <NumRow key={f.key} f={f} value={d[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </FormSection>
      <FormSection label={t('settings.torrent.interfaceBinding')}>
        <BoolRow
          f={{ key: 'bindToVpn', label: t('settings.torrent.bindToVpn'), caption: t('settings.torrent.bindEverySocketToThe') }}
          checked={d.bindToVpn}
          onChange={(v) => set('bindToVpn', v)}
        />
      </FormSection>
      <FormSection label={t('settings.torrent.dhtPex')}>
        <BoolRow f={{ key: 'dht', label: t('settings.torrent.dht'), caption: t('settings.torrent.findPeersThroughTheDistributed') }} checked={d.dht} onChange={(v) => set('dht', v)} />
        <BoolRow f={{ key: 'pex', label: t('settings.torrent.peerExchange'), caption: t('settings.torrent.exchangePeersWithConnectedPeers') }} checked={d.pex} onChange={(v) => set('pex', v)} />
      </FormSection>
      <FormSection label={t('settings.torrent.transport')}>
        <BoolRow f={{ key: 'tcp', label: t('settings.torrent.tcp'), caption: t('settings.torrent.tcpCaption') }} checked={d.tcp} onChange={(v) => set('tcp', v)} />
        <BoolRow f={{ key: 'utp', label: t('settings.torrent.utp'), caption: t('settings.torrent.utpCaption') }} checked={d.utp} onChange={(v) => set('utp', v)} />
        {!d.tcp && !d.utp ? (
          <p className="al-inline-error" role="alert">
            {t('settings.torrent.noTransportWarning')}
          </p>
        ) : null}
        <BoolRow f={{ key: 'ipv6', label: t('settings.torrent.ipv6'), caption: t('settings.torrent.ipv6Caption') }} checked={d.ipv6} onChange={(v) => set('ipv6', v)} />
        <NumRow
          f={{ key: 'webSeedConnectionsPerTorrent', label: t('settings.torrent.webSeedConnections'), caption: t('settings.torrent.webSeedConnectionsCaption'), min: 0, max: 32 }}
          value={d.webSeedConnectionsPerTorrent}
          onChange={(v) => set('webSeedConnectionsPerTorrent', v)}
        />
      </FormSection>
      <FormSection label={t('settings.torrent.encryption')}>
        <FormRow label={t('settings.torrent.peerEncryption')} caption={encryptionCaption(d.encryption)}>
          <Segmented aria-label={t('settings.torrent.peerEncryption')} variant="soft" options={ENCRYPTION_OPTIONS} value={d.encryption} onChange={(v) => set('encryption', v)} />
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
      title={t('common.liveStatus')}
      actions={live ? <LiveDot label={t('settings.torrent.engineRunning')} /> : null}
      aria-label={t('common.liveStatus')}
    >
      {status.isPending ? (
        <Skeleton lines={6} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.torrent.couldntReadTheEngineStatus')} onRetry={() => void status.refetch()}>
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
      <SettingsPage title={t('common.torrentEngine')} aside={aside}>
        {settings.isError ? (
          <ErrorBlock title={t('settings.torrent.couldntLoadTorrentEngineSettings')} onRetry={() => void settings.refetch()}>
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
        <SettingsPage title={t('common.torrentEngine')} description={t('settings.torrent.engineWideSettingsOfThe')} aside={aside} save={save}>
          {body}
        </SettingsPage>
      )}
    </TorrentForm>
  );
}
