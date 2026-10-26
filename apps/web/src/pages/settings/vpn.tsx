import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { VpnProviderSettings, VpnProviderType, VpnSettingsResponse, VpnSettingsUpdate, VpnStatus } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, ErrorBlock, FormRow, Input, KeyValue, LiveDot, Pane, Select, Skeleton, Toggle, type KeyValueItem } from '../../arclight/index.js';
import { useSaveVpnSettings, useTestVpn, useVpnAction, useVpnSettings, useVpnStatus } from '../../hooks/vpn.js';
import { formatSize, formatUptime, relativeTime } from '../../lib/format.js';
import { SettingsPage, useDraft } from './settings-layout.js';
import { SettingsSection } from './shared.js';
import './vpn.css';

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

/** Plain status text: "Connected", "Disconnected · <cause>", "Leaking · …", "Off". */
export function vpnStatusText(status: VpnStatus | undefined): string {
  if (!status || !status.enabled) return 'Off';
  if (status.leak) return 'Leaking · public IP matches your home IP';
  if (status.connected) return 'Connected';
  return `Disconnected · ${status.error ?? 'tunnel is down'}`;
}

/** Status chip (cyan connected, orange leaking, red disconnected). Kept for other screens. */
export function vpnBadge(status: VpnStatus | undefined) {
  if (!status || !status.enabled) return <Chip tone="muted">Off</Chip>;
  if (status.leak) return <Chip tone="warn">Leaking</Chip>;
  return status.connected ? <Chip tone="accent">Connected</Chip> : <Chip tone="danger">Disconnected</Chip>;
}

/** Seconds the tunnel has been up, from the last state change; null when unknown or down. */
export function vpnUptimeSeconds(status: VpnStatus, now: number = Date.now()): number | null {
  if (!status.enabled || !status.connected || !status.lastChanged) return null;
  const since = new Date(status.lastChanged).getTime();
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : null;
}

function portText(status: VpnStatus): string {
  if (status.forwardedPort === undefined) return '—';
  const synced = status.downloadClientPortSynced === undefined ? '' : status.downloadClientPortSynced ? ' · synced to qBittorrent' : ' · sync failed';
  return `${status.forwardedPort}${synced}`;
}

/** Key/value rows (mono values) for a status: public IP, port forward, uptime, interface… */
export function vpnStatusItems(status: VpnStatus): KeyValueItem[] {
  const location = [status.city, status.region, status.country].filter(Boolean).join(', ');
  const uptime = vpnUptimeSeconds(status);
  const items: KeyValueItem[] = [
    { label: 'Public IP', value: status.publicIp ?? '—' },
    { label: 'Port forward', value: portText(status) },
    { label: 'Uptime', value: uptime === null ? '—' : formatUptime(uptime) },
    { label: 'Interface', value: status.interfaceName || status.tunnelAddress ? `${status.interfaceName ?? '?'} ${status.tunnelAddress ?? ''}`.trim() : '—' },
  ];
  if (location) items.push({ label: 'Location', value: location, mono: false });
  if (status.endpoint) items.push({ label: 'Endpoint', value: status.endpoint });
  if (status.lastHandshake) items.push({ label: 'Last handshake', value: relativeTime(status.lastHandshake) });
  if (status.rxBytes !== undefined) items.push({ label: 'Transfer', value: `${formatSize(status.rxBytes)} in · ${formatSize(status.txBytes)} out` });
  items.push({ label: 'Last checked', value: status.lastChecked ? relativeTime(status.lastChecked) : 'never' });
  return items;
}

/** Status line + key/values. Shared by the live pane and the test result. */
export function VpnStatusFields({ status }: { status: VpnStatus }) {
  const live = status.enabled && status.connected && !status.leak;
  const tone = !status.enabled ? 'off' : status.leak ? 'warn' : status.connected ? 'ok' : 'danger';
  return (
    <div className="al-vpn-status">
      <p className="al-vpn-status__line" data-tone={tone} role="status">
        {live ? <LiveDot /> : null}
        <span>{vpnStatusText(status)}</span>
      </p>
      <KeyValue items={vpnStatusItems(status)} />
    </div>
  );
}

// ---- form --------------------------------------------------------------------------------

function TextRow({
  label,
  caption,
  value,
  onChange,
  type = 'text',
  placeholder,
  mono = true,
}: {
  label: string;
  caption?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption}>
      <Input id={id} type={type} mono={mono} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function ToggleRow({ label, caption, checked, onChange }: { label: string; caption: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} captionInline>
      <Toggle id={id} checked={checked} label={caption} onChange={(e) => onChange(e.currentTarget.checked)} />
    </FormRow>
  );
}

function ProviderFields({ provider, onChange }: { provider: VpnProviderSettings; onChange: (p: VpnProviderSettings) => void }) {
  switch (provider.type) {
    case 'gluetun':
      return (
        <>
          <TextRow
            label="Control server URL"
            caption="Gluetun's HTTP control server (HTTP_CONTROL_SERVER_ADDRESS)."
            value={provider.controlUrl ?? ''}
            placeholder="http://localhost:8000"
            onChange={(v) => onChange({ ...provider, controlUrl: v })}
          />
          <TextRow
            label="API key"
            type="password"
            caption="Sent as X-API-Key. Leave empty when the control server is open."
            value={provider.apiKey ?? ''}
            onChange={(v) => onChange({ ...provider, apiKey: v })}
          />
          <TextRow
            label="Username"
            mono={false}
            caption="Basic auth, if your Gluetun uses it instead of an API key."
            value={provider.username ?? ''}
            onChange={(v) => onChange({ ...provider, username: v })}
          />
          <TextRow label="Password" type="password" value={provider.password ?? ''} onChange={(v) => onChange({ ...provider, password: v })} />
        </>
      );
    case 'wireguard-windows':
      return (
        <>
          <TextRow
            label="WireGuard config (.conf)"
            caption="Path to the WireGuard file, e.g. C:\vpn\proton-nl.conf. Its name is the tunnel name."
            value={provider.configPath}
            onChange={(v) => onChange({ ...provider, configPath: v })}
          />
          <TextRow
            label="wireguard.exe"
            caption="Leave empty for C:\Program Files\WireGuard\wireguard.exe."
            value={provider.wireguardExe ?? ''}
            onChange={(v) => onChange({ ...provider, wireguardExe: v })}
          />
          <ToggleRow
            label="Auto-start"
            caption="Install the tunnel service when it is not running"
            checked={provider.autoStart}
            onChange={(v) => onChange({ ...provider, autoStart: v })}
          />
          <ToggleRow
            label="Kill switch"
            caption="Stop grabs and torrent traffic when the tunnel drops"
            checked={provider.killSwitch}
            onChange={(v) => onChange({ ...provider, killSwitch: v })}
          />
        </>
      );
    case 'interface-binding':
      return (
        <TextRow
          label="Adapter name"
          caption='The VPN network adapter, e.g. "ProtonVPN" or "wg0".'
          value={provider.interfaceName}
          onChange={(v) => onChange({ ...provider, interfaceName: v })}
        />
      );
  }
}

function LiveStatusPane() {
  const status = useVpnStatus();
  const refresh = useVpnAction('refresh');
  const connect = useVpnAction('connect');
  const disconnect = useVpnAction('disconnect');
  const native = status.data?.provider === 'wireguard-windows';
  return (
    <Pane
      chamfer="tl"
      title="Live status"
      aria-label="Live status"
      actions={
        <>
          {native ? (
            status.data?.connected ? (
              <Button size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" loading={connect.isPending} onClick={() => connect.mutate()}>
                Connect
              </Button>
            )
          ) : null}
          <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh
          </Button>
        </>
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title="Couldn't read the VPN status" onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <VpnStatusFields status={status.data} />
      )}
    </Pane>
  );
}

function VpnForm({ data, advanced, onAdvanced }: { data: VpnSettingsResponse; advanced: boolean; onAdvanced: (v: boolean) => void }) {
  const draft = useDraft(data);
  // Per-provider drafts so flipping the selector back and forth keeps what was typed.
  const drafts = useRef(new Map<VpnProviderType, VpnProviderSettings>([[data.provider.type, data.provider]]));
  useEffect(() => {
    drafts.current.set(data.provider.type, data.provider);
  }, [data]);
  const save = useSaveVpnSettings();
  const test = useTestVpn();
  const providerId = useId();
  const pollId = useId();
  const value = draft.value;
  const set = <K extends keyof VpnSettingsResponse>(key: K, v: VpnSettingsResponse[K]) => draft.set((d) => ({ ...d, [key]: v }));
  const setProvider = (p: VpnProviderSettings) => {
    drafts.current.set(p.type, p);
    set('provider', p);
  };

  return (
    <SettingsPage
      title="VPN"
      description="Watch the tunnel, guard grabs when it drops, and keep the forwarded port in sync."
      advanced={{ value: advanced, onChange: onAdvanced }}
      actions={
        <Button size="sm" loading={test.isPending} onClick={() => test.mutate(toVpnUpdate(value))}>
          Test
        </Button>
      }
      save={{ count: draft.changes, onSave: () => save.mutate(toVpnUpdate(value)), onDiscard: draft.discard, saving: save.isPending }}
      aside={<LiveStatusPane />}
      after={
        test.isError || test.data ? (
          <Pane title="Test result" aria-label="Test result">
            {test.isError ? (
              <ErrorBlock title="The test failed">{errorMessage(test.error)}</ErrorBlock>
            ) : test.data ? (
              <VpnStatusFields status={test.data} />
            ) : null}
          </Pane>
        ) : null
      }
    >
      <SettingsSection label="Connection">
        <div className="al-vpn-rows">
          <ToggleRow label="VPN monitoring" caption="Watch the VPN and guard grabs" checked={value.enabled} onChange={(v) => set('enabled', v)} />
          <FormRow label="Provider" htmlFor={providerId}>
            <Select
              id={providerId}
              className="al-vpn-select"
              value={value.provider.type}
              options={PROVIDER_OPTIONS}
              onChange={(e) => {
                const type = e.currentTarget.value as VpnProviderType;
                setProvider(drafts.current.get(type) ?? defaultProvider(type));
              }}
            />
          </FormRow>
          <ProviderFields provider={value.provider} onChange={setProvider} />
        </div>
      </SettingsSection>
      <SettingsSection label="Protection">
        <div className="al-vpn-rows">
          {value.provider.type === 'gluetun' ? (
            <ToggleRow
              label="Sync forwarded port"
              caption="Set qBittorrent's listening port to the forwarded port"
              checked={value.syncForwardedPortToDownloadClient}
              onChange={(v) => set('syncForwardedPortToDownloadClient', v)}
            />
          ) : null}
          <ToggleRow label="Pause grabs when down" caption="Hold grabs while the VPN is down or leaking" checked={value.pauseGrabsWhenDown} onChange={(v) => set('pauseGrabsWhenDown', v)} />
          <TextRow
            label="Home public IP"
            caption="Your ISP address. If the VPN reports it, traffic is leaking."
            value={value.homePublicIp ?? ''}
            placeholder="optional"
            onChange={(v) => set('homePublicIp', v)}
          />
          {advanced && value.provider.type !== 'gluetun' ? (
            <TextRow
              label="Public IP check URL"
              caption="Answers with your public IP (JSON {ip} or plain text)."
              value={value.publicIpCheckUrl}
              onChange={(v) => set('publicIpCheckUrl', v)}
            />
          ) : null}
          {advanced ? (
            <FormRow label="Poll interval" htmlFor={pollId} caption="How often the status is checked, 10 to 3600 seconds.">
              <Input
                id={pollId}
                type="number"
                mono
                min={10}
                max={3600}
                className="al-vpn-num"
                end="s"
                value={value.pollIntervalSeconds}
                onChange={(e) => set('pollIntervalSeconds', Number(e.currentTarget.value))}
              />
            </FormRow>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

export function VpnSettingsPage() {
  const settings = useVpnSettings();
  const [advanced, setAdvanced] = useState(false);
  if (settings.isSuccess) return <VpnForm data={settings.data} advanced={advanced} onAdvanced={setAdvanced} />;
  return (
    <SettingsPage title="VPN" aside={<LiveStatusPane />}>
      {settings.isError ? (
        <ErrorBlock title="Couldn't load VPN settings" onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={6} />
      )}
    </SettingsPage>
  );
}
