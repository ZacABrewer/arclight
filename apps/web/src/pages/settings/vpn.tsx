import { useEffect, useRef, useState } from 'react';
import type { VpnProviderSettings, VpnProviderType, VpnSettingsResponse, VpnSettingsUpdate, VpnStatus } from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { useSaveVpnSettings, useTestVpn, useVpnAction, useVpnSettings, useVpnStatus } from '../../hooks/vpn.js';
import { relativeTime } from '../../lib/format.js';

export const PROVIDER_OPTIONS: Array<{ value: VpnProviderType; label: string }> = [
  { value: 'gluetun', label: 'Gluetun (Docker)' },
  { value: 'wireguard-windows', label: 'WireGuard for Windows (native)' },
  { value: 'interface-binding', label: 'Interface binding (any OS)' },
];

function defaultProvider(type: VpnProviderType): VpnProviderSettings {
  switch (type) {
    case 'gluetun':
      return { type };
    case 'wireguard-windows':
      return { type, configPath: '', autoStart: true, killSwitch: true };
    case 'interface-binding':
      return { type, interfaceName: '' };
  }
}

/** Draft -> PUT body. Masked secrets go back as-is, which the api reads as "keep". */
export function toVpnUpdate(draft: VpnSettingsResponse): VpnSettingsUpdate {
  const { homePublicIp, ...rest } = draft;
  return { ...rest, homePublicIp: homePublicIp?.trim() ? homePublicIp.trim() : null };
}

function formatBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function vpnBadge(status: VpnStatus | undefined) {
  if (!status || !status.enabled) return <Badge>Disabled</Badge>;
  if (status.leak) return <Badge tone="warning">Leak</Badge>;
  return status.connected ? <Badge tone="ok">Connected</Badge> : <Badge tone="error">Disconnected</Badge>;
}

/** Status rows shared by the settings page and the dashboard card. */
export function VpnStatusFields({ status }: { status: VpnStatus }) {
  const location = [status.city, status.region, status.country].filter(Boolean).join(', ');
  const rows: Array<[string, React.ReactNode]> = [
    ['State', vpnBadge(status)],
    ['Public IP', status.publicIp ?? '—'],
    ['Location', location || '—'],
  ];
  if (status.forwardedPort !== undefined || status.provider === 'gluetun') {
    const synced = status.downloadClientPortSynced === undefined ? '' : status.downloadClientPortSynced ? ' (synced to qBittorrent)' : ' (sync failed)';
    rows.push(['Forwarded port', status.forwardedPort === undefined ? '—' : `${status.forwardedPort}${synced}`]);
  }
  if (status.tunnelAddress || status.interfaceName) rows.push(['Adapter', `${status.interfaceName ?? '?'} ${status.tunnelAddress ?? '(no IPv4)'}`]);
  if (status.endpoint) rows.push(['Endpoint', status.endpoint]);
  if (status.lastHandshake) rows.push(['Last handshake', relativeTime(status.lastHandshake)]);
  if (status.rxBytes !== undefined) rows.push(['Transfer', `${formatBytes(status.rxBytes)} in, ${formatBytes(status.txBytes)} out`]);
  if (status.error) rows.push(['Problem', <span className="field-error-text">{status.error}</span>]);
  rows.push(['Last checked', status.lastChecked ? relativeTime(status.lastChecked) : 'never']);
  return (
    <dl className="fields">
      {rows.map(([label, value]) => (
        <div className="fields-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProviderFields({ provider, onChange }: { provider: VpnProviderSettings; onChange: (p: VpnProviderSettings) => void }) {
  switch (provider.type) {
    case 'gluetun':
      return (
        <>
          <FormField label="Control server URL" hint="Gluetun's HTTP control server (HTTP_CONTROL_SERVER_ADDRESS)." inline>
            <Input value={provider.controlUrl ?? ''} placeholder="http://localhost:8000" onChange={(e) => onChange({ ...provider, controlUrl: e.target.value })} />
          </FormField>
          <FormField label="API key" hint="Sent as X-API-Key. Leave empty when the control server is open." inline>
            <Input type="password" value={provider.apiKey ?? ''} onChange={(e) => onChange({ ...provider, apiKey: e.target.value })} />
          </FormField>
          <FormField label="Username" hint="Basic auth, if your Gluetun uses it instead of an API key." inline>
            <Input value={provider.username ?? ''} onChange={(e) => onChange({ ...provider, username: e.target.value })} />
          </FormField>
          <FormField label="Password" inline>
            <Input type="password" value={provider.password ?? ''} onChange={(e) => onChange({ ...provider, password: e.target.value })} />
          </FormField>
        </>
      );
    case 'wireguard-windows':
      return (
        <>
          <FormField label="WireGuard config (.conf)" hint="Path to the Proton WireGuard file, e.g. C:\vpn\proton-nl.conf. Its name is the tunnel name." inline>
            <Input value={provider.configPath} onChange={(e) => onChange({ ...provider, configPath: e.target.value })} />
          </FormField>
          <FormField label="wireguard.exe" hint="Leave empty for C:\Program Files\WireGuard\wireguard.exe." inline>
            <Input value={provider.wireguardExe ?? ''} onChange={(e) => onChange({ ...provider, wireguardExe: e.target.value })} />
          </FormField>
          <FormField label="Auto-start" inline>
            <Toggle checked={provider.autoStart} label="Install the tunnel service when it is not running" onChange={(e) => onChange({ ...provider, autoStart: e.target.checked })} />
          </FormField>
          <FormField label="Kill switch" inline>
            <Toggle checked={provider.killSwitch} label="Stop grabs and torrent traffic when the tunnel drops" onChange={(e) => onChange({ ...provider, killSwitch: e.target.checked })} />
          </FormField>
        </>
      );
    case 'interface-binding':
      return (
        <FormField label="Adapter name" hint='The VPN network adapter, e.g. "ProtonVPN" or "wg0".' inline>
          <Input value={provider.interfaceName} onChange={(e) => onChange({ ...provider, interfaceName: e.target.value })} />
        </FormField>
      );
  }
}

function VpnForm({ data }: { data: VpnSettingsResponse }) {
  const [draft, setDraft] = useState(data);
  // Per-provider drafts so flipping the selector back and forth keeps what was typed.
  const drafts = useRef(new Map<VpnProviderType, VpnProviderSettings>([[data.provider.type, data.provider]]));
  useEffect(() => {
    setDraft(data);
    drafts.current.set(data.provider.type, data.provider);
  }, [data]);
  const save = useSaveVpnSettings();
  const test = useTestVpn();
  const set = <K extends keyof VpnSettingsResponse>(key: K, value: VpnSettingsResponse[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setProvider = (p: VpnProviderSettings) => {
    drafts.current.set(p.type, p);
    set('provider', p);
  };

  return (
    <>
      <FormField label="Enable VPN monitoring" inline>
        <Toggle checked={draft.enabled} label="Watch the VPN and guard grabs" onChange={(e) => set('enabled', e.target.checked)} />
      </FormField>
      <FormField label="Provider" inline>
        <Select
          aria-label="Provider"
          value={draft.provider.type}
          options={PROVIDER_OPTIONS}
          onChange={(e) => {
            const type = e.target.value as VpnProviderType;
            setProvider(drafts.current.get(type) ?? defaultProvider(type));
          }}
        />
      </FormField>
      <ProviderFields provider={draft.provider} onChange={setProvider} />
      {draft.provider.type === 'gluetun' ? (
        <FormField label="Sync forwarded port" inline>
          <Toggle
            checked={draft.syncForwardedPortToDownloadClient}
            label="Set qBittorrent's listening port to the forwarded port"
            onChange={(e) => set('syncForwardedPortToDownloadClient', e.target.checked)}
          />
        </FormField>
      ) : (
        <FormField label="Public IP check URL" hint="Answers with your public IP (JSON {ip} or plain text)." inline>
          <Input value={draft.publicIpCheckUrl} onChange={(e) => set('publicIpCheckUrl', e.target.value)} />
        </FormField>
      )}
      <FormField label="Pause grabs when down" inline>
        <Toggle checked={draft.pauseGrabsWhenDown} label="Hold grabs while the VPN is down or leaking" onChange={(e) => set('pauseGrabsWhenDown', e.target.checked)} />
      </FormField>
      <FormField label="Home public IP" hint="Your ISP address. If the VPN reports it, traffic is leaking." inline>
        <Input value={draft.homePublicIp ?? ''} placeholder="optional" onChange={(e) => set('homePublicIp', e.target.value)} />
      </FormField>
      <FormField label="Poll interval (seconds)" inline>
        <Input type="number" min={10} max={3600} value={draft.pollIntervalSeconds} onChange={(e) => set('pollIntervalSeconds', Number(e.target.value))} />
      </FormField>
      <div className="editor-footer">
        <div className="editor-footer-left">
          <Button loading={test.isPending} onClick={() => test.mutate(toVpnUpdate(draft))}>
            Test
          </Button>
        </div>
        <div className="editor-footer-right">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(toVpnUpdate(draft))}>
            Save
          </Button>
        </div>
      </div>
      {test.isError ? <p className="field-error-text" role="alert">{errorMessage(test.error)}</p> : null}
      {test.data ? (
        <div aria-label="Test result">
          <h3 className="card-title">Test result</h3>
          <VpnStatusFields status={test.data} />
        </div>
      ) : null}
    </>
  );
}

function LiveStatus() {
  const status = useVpnStatus();
  const refresh = useVpnAction('refresh');
  const connect = useVpnAction('connect');
  const disconnect = useVpnAction('disconnect');
  const native = status.data?.provider === 'wireguard-windows';
  return (
    <Card
      title="Live status"
      actions={
        <>
          {native ? (
            <>
              <Button size="sm" loading={connect.isPending} onClick={() => connect.mutate()}>
                Connect
              </Button>
              <Button size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </>
          ) : null}
          <Button size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh
          </Button>
        </>
      }
    >
      {status.isPending ? <LoadingBlock /> : status.isError ? <ErrorView error={status.error} onRetry={() => void status.refetch()} /> : <VpnStatusFields status={status.data} />}
    </Card>
  );
}

export function VpnSettingsPage() {
  const settings = useVpnSettings();
  return (
    <Page title="VPN">
      <div className="stack">
        <LiveStatus />
        <Card title="VPN">
          {settings.isPending ? (
            <LoadingBlock />
          ) : settings.isError ? (
            <ErrorView error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <VpnForm data={settings.data} />
          )}
        </Card>
      </div>
    </Page>
  );
}
