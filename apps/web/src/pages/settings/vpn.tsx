import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { VpnProviderSettings, VpnProviderType, VpnSettingsResponse, VpnSettingsUpdate, VpnStatus } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Chip, ErrorBlock, FormRow, Input, KeyValue, LiveDot, Pane, Select, Skeleton, Toggle, type KeyValueItem } from '../../arclight/index.js';
import { useSaveVpnSettings, useTestVpn, useVpnAction, useVpnSettings, useVpnStatus } from '../../hooks/vpn.js';
import { formatSize, formatUptime, relativeTime } from '../../lib/format.js';
import { SettingsPage, useDraft } from './settings-layout.js';
import { SettingsSection } from './shared.js';
import './vpn.css';
import { t } from '../../i18n/index.js';

export const PROVIDER_OPTIONS: Array<{ value: VpnProviderType; label: string }> = [
  { value: 'gluetun', get label() { return t('settings.vpn.gluetunDocker'); } },
  { value: 'wireguard-windows', get label() { return t('settings.vpn.wireguardForWindowsNative'); } },
  { value: 'interface-binding', get label() { return t('settings.vpn.interfaceBindingAnyOs'); } },
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
  if (!status || !status.enabled) return t('common.off');
  if (status.leak) return t('settings.vpn.leakingPublicIpMatchesYour');
  if (status.connected) return t('common.connected');
  return t('settings.vpn.disconnectedValue', { value: status.error ?? 'tunnel is down' });
}

/** Status chip (cyan connected, orange leaking, red disconnected). Kept for other screens. */
export function vpnBadge(status: VpnStatus | undefined) {
  if (!status || !status.enabled) return <Chip tone="muted">{t('common.off')}</Chip>;
  if (status.leak) return <Chip tone="warn">{t('settings.vpn.leaking')}</Chip>;
  return status.connected ? <Chip tone="accent">{t('common.connected')}</Chip> : <Chip tone="danger">{t('settings.vpn.disconnected')}</Chip>;
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
    { label: t('settings.vpn.publicIp'), value: status.publicIp ?? '—' },
    { label: t('settings.vpn.portForward'), value: portText(status) },
    { label: t('settings.vpn.uptime'), value: uptime === null ? '—' : formatUptime(uptime) },
    { label: t('settings.vpn.interface'), value: status.interfaceName || status.tunnelAddress ? `${status.interfaceName ?? '?'} ${status.tunnelAddress ?? ''}`.trim() : '—' },
  ];
  if (location) items.push({ label: t('settings.vpn.location'), value: location, mono: false });
  if (status.endpoint) items.push({ label: t('settings.vpn.endpoint'), value: status.endpoint });
  if (status.lastHandshake) items.push({ label: t('settings.vpn.lastHandshake'), value: relativeTime(status.lastHandshake) });
  if (status.rxBytes !== undefined) items.push({ label: t('settings.vpn.transfer'), value: `${formatSize(status.rxBytes)} in · ${formatSize(status.txBytes)} out` });
  items.push({ label: t('settings.vpn.lastChecked'), value: status.lastChecked ? relativeTime(status.lastChecked) : 'never' });
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
            label={t('settings.vpn.controlServerUrl')}
            caption={t('settings.vpn.gluetunsHttpControlServerHttp')}
            value={provider.controlUrl ?? ''}
            placeholder="http://localhost:8000"
            onChange={(v) => onChange({ ...provider, controlUrl: v })}
          />
          <TextRow
            label={t('common.apiKey')}
            type="password"
            caption={t('settings.vpn.sentAsXApiKey')}
            value={provider.apiKey ?? ''}
            onChange={(v) => onChange({ ...provider, apiKey: v })}
          />
          <TextRow
            label={t('common.username')}
            mono={false}
            caption={t('settings.vpn.basicAuthIfYourGluetun')}
            value={provider.username ?? ''}
            onChange={(v) => onChange({ ...provider, username: v })}
          />
          <TextRow label={t('common.password')} type="password" value={provider.password ?? ''} onChange={(v) => onChange({ ...provider, password: v })} />
        </>
      );
    case 'wireguard-windows':
      return (
        <>
          <TextRow
            label={t('settings.vpn.wireguardConfigConf')}
            caption={t('settings.vpn.pathToTheWireguardFile')}
            value={provider.configPath}
            onChange={(v) => onChange({ ...provider, configPath: v })}
          />
          <TextRow
            label="wireguard.exe"
            caption={t('settings.vpn.leaveEmptyForCProgram')}
            value={provider.wireguardExe ?? ''}
            onChange={(v) => onChange({ ...provider, wireguardExe: v })}
          />
          <ToggleRow
            label={t('settings.vpn.autoStart')}
            caption={t('settings.vpn.installTheTunnelServiceWhen')}
            checked={provider.autoStart}
            onChange={(v) => onChange({ ...provider, autoStart: v })}
          />
          <ToggleRow
            label={t('settings.vpn.killSwitch')}
            caption={t('settings.vpn.stopGrabsAndTorrentTraffic')}
            checked={provider.killSwitch}
            onChange={(v) => onChange({ ...provider, killSwitch: v })}
          />
        </>
      );
    case 'interface-binding':
      return (
        <TextRow
          label={t('settings.vpn.adapterName')}
          caption={t('settings.vpn.theVpnNetworkAdapterE')}
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
      title={t('common.liveStatus')}
      aria-label={t('common.liveStatus')}
      actions={
        <>
          {native ? (
            status.data?.connected ? (
              <Button size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                {t('settings.vpn.disconnect')}
              </Button>
            ) : (
              <Button size="sm" loading={connect.isPending} onClick={() => connect.mutate()}>
                {t('settings.vpn.connect')}
              </Button>
            )
          ) : null}
          <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.vpn.couldntReadTheVpnStatus')} onRetry={() => void status.refetch()}>
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
      title={t('common.vpn')}
      description={t('settings.vpn.watchTheTunnelGuardGrabs')}
      advanced={{ value: advanced, onChange: onAdvanced }}
      actions={
        <Button size="sm" loading={test.isPending} onClick={() => test.mutate(toVpnUpdate(value))}>
          {t('common.test')}
        </Button>
      }
      save={{ count: draft.changes, onSave: () => save.mutate(toVpnUpdate(value)), onDiscard: draft.discard, saving: save.isPending }}
      aside={<LiveStatusPane />}
      after={
        test.isError || test.data ? (
          <Pane title={t('common.testResult')} aria-label={t('common.testResult')}>
            {test.isError ? (
              <ErrorBlock title={t('settings.vpn.theTestFailed')}>{errorMessage(test.error)}</ErrorBlock>
            ) : test.data ? (
              <VpnStatusFields status={test.data} />
            ) : null}
          </Pane>
        ) : null
      }
    >
      <SettingsSection label={t('settings.vpn.connection')}>
        <div className="al-vpn-rows">
          <ToggleRow label={t('settings.vpn.vpnMonitoring')} caption={t('settings.vpn.watchTheVpnAndGuard')} checked={value.enabled} onChange={(v) => set('enabled', v)} />
          <FormRow label={t('common.provider')} htmlFor={providerId}>
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
      <SettingsSection label={t('settings.vpn.protection')}>
        <div className="al-vpn-rows">
          {value.provider.type === 'gluetun' ? (
            <ToggleRow
              label={t('settings.vpn.syncForwardedPort')}
              caption={t('settings.vpn.setQbittorrentsListeningPortTo')}
              checked={value.syncForwardedPortToDownloadClient}
              onChange={(v) => set('syncForwardedPortToDownloadClient', v)}
            />
          ) : null}
          <ToggleRow label={t('settings.vpn.pauseGrabsWhenDown')} caption={t('settings.vpn.holdGrabsWhileTheVpn')} checked={value.pauseGrabsWhenDown} onChange={(v) => set('pauseGrabsWhenDown', v)} />
          <TextRow
            label={t('settings.vpn.homePublicIp')}
            caption={t('settings.vpn.yourIspAddressIfThe')}
            value={value.homePublicIp ?? ''}
            placeholder={t('settings.vpn.optional')}
            onChange={(v) => set('homePublicIp', v)}
          />
          {advanced && value.provider.type !== 'gluetun' ? (
            <TextRow
              label={t('settings.vpn.publicIpCheckUrl')}
              caption={t('settings.vpn.answersWithYourPublicIp')}
              value={value.publicIpCheckUrl}
              onChange={(v) => set('publicIpCheckUrl', v)}
            />
          ) : null}
          {advanced ? (
            <FormRow label={t('settings.vpn.pollInterval')} htmlFor={pollId} caption={t('settings.vpn.howOftenTheStatusIs')}>
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
    <SettingsPage title={t('common.vpn')} aside={<LiveStatusPane />}>
      {settings.isError ? (
        <ErrorBlock title={t('settings.vpn.couldntLoadVpnSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={6} />
      )}
    </SettingsPage>
  );
}
