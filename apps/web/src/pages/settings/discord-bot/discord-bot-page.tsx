import { useId, type ReactNode } from 'react';
import { DISCORD_BOT_TOKEN_MASK, type DiscordBotSettings, type DiscordBotState, type DiscordBotStatus } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, FormRow, Input, KeyValue, LiveDot, Pane, Skeleton, Toggle, type ChipTone, type KeyValueItem } from '../../../arclight/index.js';
import { useDiscordBotSettings, useDiscordBotStatus, useSaveDiscordBotSettings, useTestDiscordBot } from '../../../hooks/discord-bot.js';
import { formatDateTime, formatRelative, t } from '../../../i18n/index.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';

// Settings → Discord bot: the bot user's token, the guild it registers slash commands on,
// the channel request events go to and the role that may approve. A live status pane polls
// GET /discordbot/status; Test checks the unsaved draft (POST /discordbot/test).

type IdKey = 'guildId' | 'requestChannelId' | 'adminRoleId';

/** Discord ids are snowflakes: 5 to 25 digits. Blank is allowed (null). */
export function snowflakeError(value: string | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return /^\d{5,25}$/.test(v) ? null : t('settings.discordBot.idDigits');
}

/** Draft → PUT/test body: ids trimmed, blank ids null, the token mask sent back unchanged. */
export function toDiscordBotBody(draft: DiscordBotSettings): DiscordBotSettings {
  const id = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return { ...draft, botToken: draft.botToken.trim(), guildId: id(draft.guildId), requestChannelId: id(draft.requestChannelId), adminRoleId: id(draft.adminRoleId) };
}

/** Problems that block saving (the api would answer 400). */
export function discordBotErrors(draft: DiscordBotSettings): string[] {
  const errors = (['guildId', 'requestChannelId', 'adminRoleId'] as const).map((k) => snowflakeError(draft[k])).filter((e): e is string => e !== null);
  if (draft.enabled && !draft.botToken.trim()) errors.push(t('settings.discordBot.tokenRequired'));
  return errors;
}

export function discordStateLabel(state: DiscordBotState): string {
  switch (state) {
    case 'disabled':
      return t('settings.discordBot.state.disabled');
    case 'connecting':
      return t('settings.discordBot.state.connecting');
    case 'connected':
      return t('common.connected');
    case 'reconnecting':
      return t('settings.discordBot.state.reconnecting');
    case 'error':
      return t('settings.discordBot.state.error');
  }
}

export function discordStateTone(state: DiscordBotState): ChipTone {
  return state === 'connected' ? 'accent' : state === 'error' ? 'danger' : state === 'disabled' ? 'muted' : 'warn';
}

/** Key/value rows for the status pane (mono values). */
export function discordStatusItems(s: DiscordBotStatus, now: number = Date.now()): KeyValueItem[] {
  const items: KeyValueItem[] = [
    { label: t('settings.discordBot.botUser'), value: s.botUser ? `${s.botUser.username} · ${s.botUser.id}` : '—' },
    { label: t('settings.discordBot.connectedSince'), value: s.connectedAt ? `${formatDateTime(s.connectedAt)} · ${formatRelative(s.connectedAt, now)}` : '—' },
    { label: t('settings.discordBot.reconnectAttempts'), value: String(s.reconnectAttempts) },
    { label: t('settings.discordBot.commands'), value: s.commandsRegistered ? t('settings.discordBot.registered') : t('settings.discordBot.notRegistered'), mono: false },
    { label: t('settings.discordBot.linkedUsers'), value: String(s.linkedUsers) },
  ];
  if (s.lastError) items.push({ label: t('settings.discordBot.lastError'), value: s.lastError, mono: false });
  return items;
}

function StatusPane() {
  const status = useDiscordBotStatus();
  return (
    <Pane
      chamfer="tl"
      title={t('common.liveStatus')}
      aria-label={t('common.liveStatus')}
      actions={
        <Button size="sm" variant="ghost" loading={status.isFetching && !status.isPending} onClick={() => void status.refetch()}>
          {t('common.refresh')}
        </Button>
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.discordBot.couldNotReadStatus')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <div className="al-editor-stack">
          <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }} role="status">
            {status.data.state === 'connected' ? <LiveDot /> : null}
            <Chip tone={discordStateTone(status.data.state)}>{discordStateLabel(status.data.state)}</Chip>
          </p>
          <KeyValue items={discordStatusItems(status.data)} />
        </div>
      )}
    </Pane>
  );
}

function TextRow({ label, caption, value, onChange, type = 'text', error, placeholder }: { label: string; caption?: ReactNode; value: string; onChange: (v: string) => void; type?: string; error?: string | null; placeholder?: string }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} caption={caption} error={error ?? undefined}>
      <Input id={id} type={type} mono spellCheck={false} autoComplete="off" value={value} placeholder={placeholder} invalid={Boolean(error)} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function DiscordBotForm({ data }: { data: DiscordBotSettings }) {
  const draft = useDraft(data);
  const save = useSaveDiscordBotSettings();
  const test = useTestDiscordBot();
  const value = draft.value;
  const set = <K extends keyof DiscordBotSettings>(k: K, v: DiscordBotSettings[K]) => draft.set((d) => ({ ...d, [k]: v }));
  const errors = discordBotErrors(value);
  const idRow = (key: IdKey, label: string, caption: string) => (
    <TextRow label={label} caption={caption} value={value[key] ?? ''} error={snowflakeError(value[key])} onChange={(v) => set(key, v === '' ? null : v)} />
  );
  return (
    <SettingsPage
      title={t('nav.discordBot')}
      description={t('settings.discordBot.description')}
      actions={
        <Button size="sm" loading={test.isPending} onClick={() => test.mutate(toDiscordBotBody(value))}>
          {t('common.test')}
        </Button>
      }
      save={{ count: draft.changes, onSave: () => save.mutate(toDiscordBotBody(value)), onDiscard: draft.discard, saving: save.isPending, disabled: errors.length > 0 }}
      aside={<StatusPane />}
      after={
        test.isError || test.data ? (
          <Pane title={t('common.testResult')} aria-label={t('common.testResult')}>
            {test.isError ? (
              <ErrorBlock title={t('settings.discordBot.testFailed')}>{errorMessage(test.error)}</ErrorBlock>
            ) : test.data ? (
              <div className="al-editor-stack" role="status">
                <Chip tone={test.data.ok ? 'accent' : 'danger'}>{test.data.ok ? t('settings.discordBot.testOk') : t('settings.discordBot.testNotOk')}</Chip>
                <KeyValue
                  items={[
                    ...(test.data.botUser ? [{ label: t('settings.discordBot.botUser'), value: `${test.data.botUser.username} · ${test.data.botUser.id}` }] : []),
                    ...(test.data.message ? [{ label: t('settings.discordBot.message'), value: test.data.message, mono: false }] : []),
                  ]}
                />
              </div>
            ) : null}
          </Pane>
        ) : null
      }
    >
      <SettingsSection label={t('settings.discordBot.botSection')}>
        <FormRow label={t('settings.discordBot.enable')} captionInline caption={t('settings.discordBot.enableCaption')}>
          <Toggle aria-label={t('settings.discordBot.enable')} checked={value.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        </FormRow>
        <TextRow
          label={t('settings.discordBot.token')}
          type="password"
          caption={value.botToken === DISCORD_BOT_TOKEN_MASK ? t('settings.discordBot.tokenStored') : t('settings.discordBot.tokenCaption')}
          value={value.botToken}
          error={value.enabled && !value.botToken.trim() ? t('settings.discordBot.tokenRequired') : null}
          onChange={(v) => set('botToken', v)}
        />
      </SettingsSection>
      <SettingsSection label={t('settings.discordBot.serverSection')}>
        {idRow('guildId', t('settings.discordBot.guildId'), t('settings.discordBot.guildIdCaption'))}
        {idRow('requestChannelId', t('settings.discordBot.channelId'), t('settings.discordBot.channelIdCaption'))}
        {idRow('adminRoleId', t('settings.discordBot.adminRoleId'), t('settings.discordBot.adminRoleIdCaption'))}
      </SettingsSection>
    </SettingsPage>
  );
}

export function DiscordBotSettingsPage() {
  const settings = useDiscordBotSettings();
  if (settings.isSuccess) return <DiscordBotForm data={settings.data} />;
  return (
    <SettingsPage title={t('nav.discordBot')} aside={<StatusPane />}>
      {settings.isError ? (
        <ErrorBlock title={t('settings.discordBot.couldNotLoad')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={6} />
      )}
    </SettingsPage>
  );
}
