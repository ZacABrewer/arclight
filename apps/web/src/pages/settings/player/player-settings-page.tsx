import { useId } from 'react';
import { PlayerSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, Input, Skeleton, Toggle } from '../../../arclight/index.js';
import { usePlayerSettings, useSavePlayerSettings } from '../../../features/player/api.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { t } from '../../../i18n/index.js';

// Settings → Player: GET/PUT /settings/player (contract PlayerSettings). Turns the built-in
// music and audiobook player on, and sets the limits for streams from outside the home
// network. Who may use it is set per user (Users → edit user → Player).

export interface PlayerSettingsDraft {
  enabled: boolean;
  allowRemote: boolean;
  remoteMaxBitrateKbps: string;
  streamLinkHours: string;
}

export function toPlayerSettingsDraft(s: PlayerSettings): PlayerSettingsDraft {
  return {
    enabled: s.enabled,
    allowRemote: s.allowRemote,
    remoteMaxBitrateKbps: String(s.remoteMaxBitrateKbps),
    streamLinkHours: String(s.streamLinkHours),
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
  const ids = { enabled: useId(), remote: useId(), bitrate: useId(), hours: useId() };

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
