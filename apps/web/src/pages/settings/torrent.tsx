import { useEffect, useState } from 'react';
import type { TorrentEngineState, TorrentSessionStatus, TorrentSettingsResponse, TorrentSettingsUpdate } from '@media-tron/shared';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Toggle } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { useSaveTorrentSettings, useTorrentSettings, useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate } from '../../lib/format.js';

// Settings -> Torrent Engine: engine-wide settings of the built-in BitTorrent engine plus a live
// status panel. Per-client options (categories, save paths) live on the Built-in download client.

const STATE_LABELS: Record<TorrentEngineState, [string, BadgeTone]> = {
  disabled: ['Disabled', 'neutral'],
  starting: ['Starting', 'info'],
  running: ['Running', 'ok'],
  lockdown: ['Lockdown', 'error'],
  error: ['Error', 'error'],
};

export function engineBadge(state: TorrentEngineState) {
  const [label, tone] = STATE_LABELS[state];
  return <Badge tone={tone}>{label}</Badge>;
}

export const LOCKDOWN_EXPLANATION = 'VPN down — all torrents paused, sockets bound to 127.0.0.1';

/** Status rows shared by the settings page (and handy for the dashboard). */
export function TorrentStatusFields({ status }: { status: TorrentSessionStatus }) {
  const rows: Array<[string, React.ReactNode]> = [['State', engineBadge(status.state)]];
  if (status.state === 'lockdown') {
    rows.push([
      'Lockdown',
      <span className="field-error-text">
        {LOCKDOWN_EXPLANATION}
        {status.lockdownReason ? ` (${status.lockdownReason})` : ''}
      </span>,
    ]);
  }
  if (status.error) rows.push(['Problem', <span className="field-error-text">{status.error}</span>]);
  const port =
    status.listenPort === null
      ? `not listening (configured ${status.configuredListenPort})`
      : status.listenPort !== status.configuredListenPort
        ? `${status.listenPort} (forwarded by VPN; configured ${status.configuredListenPort})`
        : String(status.listenPort);
  rows.push(['Listen port', port]);
  rows.push(['Bound address', status.boundAddress ?? 'all interfaces']);
  const vpn = status.vpn;
  const vpnText = !vpn.bindToVpn
    ? 'not bound to the VPN'
    : !vpn.enabled
      ? 'bind to VPN on, VPN integration disabled'
      : [
          vpn.connected ? 'connected' : 'disconnected',
          vpn.tunnelAddress ? `tunnel ${vpn.tunnelAddress}` : null,
          vpn.forwardedPort !== undefined ? `forwarded port ${vpn.forwardedPort}` : null,
          vpn.killSwitchEngaged ? 'kill switch engaged' : null,
        ]
          .filter(Boolean)
          .join(' · ');
  rows.push(['VPN binding', vpnText]);
  rows.push(['DHT nodes', String(status.dhtNodes)]);
  rows.push(['Peers', String(status.peers)]);
  rows.push(['Download', formatRate(status.downloadRate)]);
  rows.push(['Upload', formatRate(status.uploadRate)]);
  const t = status.torrents;
  rows.push([
    'Torrents',
    `${t.total} total · ${t.downloading} downloading · ${t.seeding} seeding · ${t.paused} paused · ${t.queued} queued · ${t.checking} checking · ${t.error} error`,
  ]);
  return (
    <dl className="fields" aria-label="Torrent engine status">
      {rows.map(([label, value]) => (
        <div className="fields-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
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

const BOOL_FIELDS: Array<[BoolKey, string, string]> = [
  ['enabled', 'Enable engine', 'Run the built-in torrent engine'],
  ['autoRegisterClient', 'Auto-register client', 'Add a "Built-in" download client on first start when none exists'],
  ['dht', 'DHT', 'Find peers through the distributed hash table (not for private torrents)'],
  ['pex', 'Peer exchange', 'Exchange peers with connected peers (not for private torrents)'],
  ['bindToVpn', 'Bind to VPN', 'Bind every socket to the VPN tunnel and pause all torrents while it is down'],
];

const NUM_FIELDS: Array<{ key: NumKey; label: string; hint?: string; min?: number; max?: number; step?: string; placeholder?: string }> = [
  { key: 'listenPort', label: 'Listen port', hint: 'Incoming peers (TCP) and DHT (UDP). A port forwarded by the VPN takes precedence.', min: 1, max: 65535 },
  { key: 'maxConnections', label: 'Max connections', hint: 'Peer connections across all torrents.', min: 1, max: 5000 },
  { key: 'maxConnectionsPerTorrent', label: 'Max connections per torrent', min: 1, max: 1000 },
  { key: 'downloadLimitKbps', label: 'Download limit (KiB/s)', hint: '0 = unlimited.', min: 0 },
  { key: 'uploadLimitKbps', label: 'Upload limit (KiB/s)', hint: '0 = unlimited.', min: 0 },
  { key: 'maxActiveDownloads', label: 'Max active downloads', hint: '-1 = unlimited.', min: -1 },
  { key: 'maxActiveSeeds', label: 'Max active seeds', hint: '-1 = unlimited.', min: -1 },
  { key: 'defaultSeedRatio', label: 'Default seed ratio', hint: 'Stop seeding at this ratio. Empty = unlimited.', min: 0, step: '0.1', placeholder: 'unlimited' },
  { key: 'defaultSeedTimeMinutes', label: 'Default seed time (minutes)', hint: 'Stop seeding after this long. Empty = unlimited.', min: 0, placeholder: 'unlimited' },
];

function TorrentForm({ data }: { data: TorrentSettingsResponse }) {
  const [draft, setDraft] = useState(() => toTorrentDraft(data));
  useEffect(() => setDraft(toTorrentDraft(data)), [data]);
  const save = useSaveTorrentSettings();
  const set = <K extends keyof TorrentDraft>(key: K, value: TorrentDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
      {BOOL_FIELDS.map(([key, label, text]) => (
        <FormField key={key} label={label} inline>
          <Toggle checked={draft[key]} label={text} onChange={(e) => set(key, e.currentTarget.checked)} />
        </FormField>
      ))}
      {NUM_FIELDS.map((f) => (
        <FormField key={f.key} label={f.label} hint={f.hint} inline>
          <Input
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            step={f.step}
            placeholder={f.placeholder}
            value={draft[f.key]}
            onChange={(e) => set(f.key, e.currentTarget.value)}
          />
        </FormField>
      ))}
      <FormField label="Downloads folder" hint="Default download folder. Empty uses the folder shown." inline>
        <Input value={draft.downloadsRoot} placeholder={data.effectiveDownloadsRoot} onChange={(e) => set('downloadsRoot', e.currentTarget.value)} />
      </FormField>
      <FormField label="Resume data folder" hint="Fast-resume data and saved .torrent files. Not editable." inline>
        <Input value={data.resumeDir} readOnly />
      </FormField>
      <div className="editor-footer">
        <div className="editor-footer-left" />
        <div className="editor-footer-right">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(toTorrentUpdate(draft))}>
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

function LiveStatus() {
  const status = useTorrentStatus();
  return (
    <Card title="Live status">
      {status.isPending ? (
        <LoadingBlock />
      ) : status.isError ? (
        <ErrorView error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <TorrentStatusFields status={status.data} />
      )}
    </Card>
  );
}

export function TorrentSettingsPage() {
  const settings = useTorrentSettings();
  return (
    <Page title="Torrent Engine">
      <div className="stack">
        <LiveStatus />
        <Card title="Engine">
          {settings.isPending ? (
            <LoadingBlock />
          ) : settings.isError ? (
            <ErrorView error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <TorrentForm data={settings.data} />
          )}
        </Card>
      </div>
    </Page>
  );
}
