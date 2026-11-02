import { useId } from 'react';
import { PlayerSettings, isMediaBrowserKind, type MediaServerResource, type PlaybackEngine, type PlayerEngineTestResult } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, FormSection, Input, Segmented, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { usePlayerSettings, useSavePlayerSettings, useTestPlayerEngine } from '../../../features/player/api.js';
import { useMediaServers } from '../../../hooks/media-servers.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { t } from '../../../i18n/index.js';

// Settings → Player: GET/PUT /settings/player (contract PlayerSettings). Turns the built-in
// music and audiobook player on, and sets the limits for streams from outside the home
// network. Who may use it is set per user (Users → edit user → Player). The playback engine is
// Arclight's own, or a Jellyfin/Emby server from Settings → Media servers (streams are proxied).

export interface PlayerSettingsDraft {
  enabled: boolean;
  allowRemote: boolean;
  remoteMaxBitrateKbps: string;
  streamLinkHours: string;
  backend: PlaybackEngine;
  /** '' = the first enabled Jellyfin/Emby server. */
  jellyfinServerId: string;
}

/** Enabled Jellyfin and Emby connections: the servers the player can stream through. */
export function playerEngineServers(servers: readonly MediaServerResource[] | undefined): MediaServerResource[] {
  return (servers ?? []).filter((s) => s.enabled && isMediaBrowserKind(s.kind));
}

/** One line for a Test result. */
export function engineTestLine(r: PlayerEngineTestResult): string {
  if (!r.ok) return t('player.settings.engineTestFailed', { message: r.message ?? '' });
  const server = r.version ? `${r.serverName ?? ''} ${r.version}`.trim() : (r.serverName ?? '');
  return r.sample ? t('player.settings.engineTestOk', { server }) : t('player.settings.engineTestNoSample', { server });
}

export function toPlayerSettingsDraft(s: PlayerSettings): PlayerSettingsDraft {
  return {
    enabled: s.enabled,
    allowRemote: s.allowRemote,
    remoteMaxBitrateKbps: String(s.remoteMaxBitrateKbps),
    streamLinkHours: String(s.streamLinkHours),
    backend: s.backend,
    jellyfinServerId: s.jellyfinServerId ?? '',
  };
}

const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/** Draft → PUT body, or the first problem as a sentence. */
export function toPlayerSettingsBody(d: PlayerSettingsDraft): { ok: true; body: PlayerSettings } | { ok: false; error: string; field: string } {
  const parsed = PlayerSettings.safeParse({
    enabled: d.enabled,
    allowRemote: d.allowRemote,
    remoteMaxBitrateKbps: num(d.remoteMaxBitrateKbps),
    streamLinkHours: num(d.streamLinkHours),
    backend: d.backend,
    jellyfinServerId: d.jellyfinServerId === '' ? null : d.jellyfinServerId,
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  const label = field === 'streamLinkHours' ? t('player.settings.streamLinkHours') : t('player.settings.remoteMaxBitrate');
  return { ok: false, field, error: t('player.settings.checkField', { field: label }) };
}

function PlayerSettingsForm({ data }: { data: PlayerSettings }) {
  const draft = useDraft(toPlayerSettingsDraft(data));
  const d = draft.value;
  const save = useSavePlayerSettings();
  const set = <K extends keyof PlayerSettingsDraft>(key: K, value: PlayerSettingsDraft[K]) => draft.set((prev) => ({ ...prev, [key]: value }));
  const result = toPlayerSettingsBody(d);
  const invalid = result.ok ? null : result.field;
  const ids = { enabled: useId(), remote: useId(), bitrate: useId(), hours: useId(), server: useId() };
  const mediaServers = useMediaServers();
  const servers = playerEngineServers(mediaServers.data);
  const noServers = servers.length === 0;
  const test = useTestPlayerEngine();

  return (
    <SettingsPage
      title={t('player.settings.title')}
      description={t('player.settings.description')}
      save={{
        count: draft.changes,
        onSave: () => {
          if (result.ok) save.mutate(result.body);
        },
        onDiscard: draft.discard,
        saving: save.isPending,
        disabled: !result.ok,
        label: result.ok ? undefined : result.error,
      }}
    >
      <form aria-label={t('player.settings.formLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 30 }} onSubmit={(e) => e.preventDefault()}>
        <FormSection label={t('player.settings.general')}>
          <FormRow label={t('player.settings.enabled')} caption={t('player.settings.enabledCaption')} captionInline>
            <Toggle id={ids.enabled} aria-label={t('player.settings.enabled')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          </FormRow>
        </FormSection>
        <FormSection label={t('player.settings.engine')}>
          <FormRow label={t('player.settings.engineLabel')} caption={noServers ? t('player.settings.engineNoServer') : t('player.settings.engineCaption')}>
            <Segmented<PlaybackEngine>
              aria-label={t('player.settings.engineLabel')}
              variant="soft"
              value={d.backend}
              onChange={(v) => set('backend', v)}
              options={[
                { value: 'arclight', label: t('player.settings.engineArclight') },
                // Disabled without a server, unless it is the saved choice (so it can be switched back).
                { value: 'jellyfin', label: t('player.settings.engineJellyfin'), disabled: noServers && d.backend !== 'jellyfin' },
              ]}
            />
          </FormRow>
          {d.backend === 'jellyfin' ? (
            <FormRow label={t('player.settings.jellyfinServer')} htmlFor={ids.server} caption={t('player.settings.jellyfinServerCaption')}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Select
                  id={ids.server}
                  value={d.jellyfinServerId}
                  disabled={noServers}
                  options={[
                    { value: '', label: t('player.settings.jellyfinServerFirst') },
                    ...servers.map((sv) => ({ value: sv.id, label: `${sv.name} (${sv.kind === 'emby' ? 'Emby' : 'Jellyfin'})` })),
                    // A saved server that is gone or disabled stays visible so the choice is not lost silently.
                    ...(d.jellyfinServerId && !servers.some((sv) => sv.id === d.jellyfinServerId) ? [{ value: d.jellyfinServerId, label: t('player.settings.jellyfinServerMissing') }] : []),
                  ]}
                  onChange={(e) => set('jellyfinServerId', e.currentTarget.value)}
                />
                <Button type="button" disabled={noServers || test.isPending} onClick={() => test.mutate({ jellyfinServerId: d.jellyfinServerId === '' ? null : d.jellyfinServerId })}>
                  {test.isPending ? t('player.settings.engineTesting') : t('player.settings.engineTest')}
                </Button>
              </div>
              {test.data ? (
                <p role="status" style={{ margin: '8px 0 0', color: test.data.ok ? 'var(--al-success, inherit)' : 'var(--al-danger, inherit)' }}>
                  {engineTestLine(test.data)}
                </p>
              ) : test.isError ? (
                <p role="status" style={{ margin: '8px 0 0' }}>
                  {t('player.settings.engineTestFailed', { message: errorMessage(test.error) })}
                </p>
              ) : null}
            </FormRow>
          ) : null}
        </FormSection>
        <FormSection label={t('player.settings.remote')}>
          <FormRow label={t('player.settings.allowRemote')} caption={t('player.settings.allowRemoteCaption')} captionInline>
            <Toggle id={ids.remote} aria-label={t('player.settings.allowRemote')} checked={d.allowRemote} onChange={(e) => set('allowRemote', e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('player.settings.remoteMaxBitrate')} htmlFor={ids.bitrate} caption={t('player.settings.remoteMaxBitrateCaption')}>
            <Input
              id={ids.bitrate}
              type="number"
              mono
              className="al-input--num"
              end={t('player.settings.kbps')}
              min={0}
              max={100000}
              invalid={invalid === 'remoteMaxBitrateKbps'}
              value={d.remoteMaxBitrateKbps}
              onChange={(e) => set('remoteMaxBitrateKbps', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('player.settings.streamLinkHours')} htmlFor={ids.hours} caption={t('player.settings.streamLinkHoursCaption')}>
            <Input
              id={ids.hours}
              type="number"
              mono
              className="al-input--num"
              end={t('player.settings.hours')}
              min={1}
              max={72}
              invalid={invalid === 'streamLinkHours'}
              value={d.streamLinkHours}
              onChange={(e) => set('streamLinkHours', e.currentTarget.value)}
            />
          </FormRow>
        </FormSection>
      </form>
    </SettingsPage>
  );
}

export function PlayerSettingsPage() {
  const settings = usePlayerSettings();
  if (!settings.data) {
    return (
      <SettingsPage title={t('player.settings.title')}>
        {settings.isError ? (
          <ErrorBlock title={t('player.settings.couldNotLoad')} onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        ) : (
          <Skeleton lines={6} />
        )}
      </SettingsPage>
    );
  }
  return <PlayerSettingsForm data={settings.data} />;
}
