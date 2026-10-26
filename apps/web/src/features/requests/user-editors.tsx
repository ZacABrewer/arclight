import { useEffect, useState } from 'react';
import {
  PERMISSION_INFO,
  Permission,
  REQUEST_SECRET_MASK,
  type PermissionInfo,
  type QuotaInfo,
  type UserNotificationTestResult,
  type UserNotificationTypes,
  type UserQuota,
  type UserRequestSettings,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, Chip, Field, Input, SectionLabel, Skeleton, Toggle } from '../../arclight/index.js';
import { ErrorView } from '../../components/error-boundary.js';
import { useToast } from '../../components/toast.js';
import {
  useSetUserPermissions,
  useSetUserQuota,
  useSetUserRequestSettings,
  useTestUserNotifications,
  useUserPermissions,
  useUserQuota,
  useUserRequestSettings,
} from '../../hooks/requests.js';
import { SaveError } from '../../pages/settings/shared.js';
import './requests.css';

// ---------------------------------------------------------------------------------------
// Permissions matrix
// ---------------------------------------------------------------------------------------

export const PERMISSION_GROUP_LABELS: Record<PermissionInfo['group'], string> = {
  admin: 'Administration',
  request: 'Requesting',
  autoApprove: 'Auto-approve',
  autoRequest: 'Auto-request (watchlist sync)',
  issues: 'Issues',
  view: 'Visibility',
};

/** Set or clear one permission bit. */
export function togglePermission(value: number, bit: number, on: boolean): number {
  return on ? value | bit : value & ~bit;
}

/** PERMISSION_INFO grouped by `group`, in first-seen order. */
export function groupedPermissions(): Array<[PermissionInfo['group'], PermissionInfo[]]> {
  const groups = new Map<PermissionInfo['group'], PermissionInfo[]>();
  for (const info of PERMISSION_INFO) {
    const list = groups.get(info.group) ?? [];
    list.push(info);
    groups.set(info.group, list);
  }
  return [...groups.entries()];
}

export function PermissionsMatrix({
  value,
  onChange,
  lockAdmin = false,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  /** The ADMIN bit follows the role and cannot be toggled here. */
  lockAdmin?: boolean;
  disabled?: boolean;
}) {
  const isAdmin = (value & Permission.ADMIN) !== 0;
  return (
    <div data-testid="permissions-matrix">
      {groupedPermissions().map(([group, items]) => (
        <fieldset key={group} className="req-group">
          <legend className="al-label">{PERMISSION_GROUP_LABELS[group]}</legend>
          <div className="req-check-grid">
            {items.map((p) => {
              const locked = disabled || (lockAdmin && p.value === Permission.ADMIN);
              return (
                <Checkbox
                  key={p.name}
                  label={p.label}
                  hint={p.description}
                  aria-label={p.label}
                  checked={(value & p.value) === p.value}
                  disabled={locked}
                  onChange={(e) => onChange(togglePermission(value, p.value, e.currentTarget.checked))}
                />
              );
            })}
          </div>
        </fieldset>
      ))}
      {isAdmin ? <p className="al-muted">Admin passes every check; the other boxes have no effect.</p> : null}
    </div>
  );
}

export function UserPermissionsEditor({ userId, lockAdmin = true }: { userId: number; lockAdmin?: boolean }) {
  const query = useUserPermissions(userId);
  const save = useSetUserPermissions(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.permissions);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (draft === null) return <Skeleton lines={4} />;
  return (
    <div className="req-stack">
      <PermissionsMatrix value={draft} onChange={setDraft} lockAdmin={lockAdmin} />
      <SaveError error={save.error} />
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res.permissions);
                toast.push({ tone: 'ok', title: 'Permissions saved' });
              },
            })
          }
        >
          Save permissions
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------------------

const numOrNull = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** Four number inputs; blank means null (global default on a user, "no quota" globally). */
export function QuotaFields({ value, onChange, blankHint }: { value: UserQuota; onChange: (next: UserQuota) => void; blankHint: string }) {
  const field = (key: keyof UserQuota, label: string) => (
    <Field label={label} hint={blankHint}>
      <Input
        type="number"
        min={0}
        aria-label={label}
        value={value[key] ?? ''}
        onChange={(e) => onChange({ ...value, [key]: numOrNull(e.currentTarget.value) })}
      />
    </Field>
  );
  return (
    <div className="req-stack">
      <div className="req-fields-2">
        {field('movieLimit', 'Movie request limit')}
        {field('movieDays', 'Movie window (days)')}
      </div>
      <div className="req-fields-2">
        {field('tvLimit', 'Series request limit')}
        {field('tvDays', 'Series window (days)')}
      </div>
    </div>
  );
}

export function quotaSummary(info: QuotaInfo): string {
  if (!info.limit) return `${info.used} used · unlimited`;
  const window = info.days ? ` per ${info.days} days` : ' in total';
  return `${info.used} of ${info.limit}${window} · ${info.remaining ?? 0} left`;
}

export function UserQuotaEditor({ userId }: { userId: number }) {
  const query = useUserQuota(userId);
  const save = useSetUserQuota(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<UserQuota | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.overrides);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data || draft === null) return <Skeleton lines={4} />;
  const { effective, status, exempt } = query.data;
  return (
    <div className="req-stack" data-testid="quota-editor">
      {exempt ? (
        <p className="al-notice" role="status">
          This user manages users (or is an admin) and is exempt from quotas.
        </p>
      ) : null}
      <QuotaFields value={draft} onChange={setDraft} blankHint="Blank: use the global default" />
      <div className="req-fields-2">
        <div>
          <SectionLabel>Movies</SectionLabel>
          <p className="req-usage" data-testid="quota-movie">
            Effective: {effective.movieLimit ? `${effective.movieLimit} per ${effective.movieDays ?? '∞'} days` : 'unlimited'} — {quotaSummary(status.movie)}
            {status.movie.restricted ? <Chip tone="danger">limit reached</Chip> : null}
          </p>
        </div>
        <div>
          <SectionLabel>Series</SectionLabel>
          <p className="req-usage" data-testid="quota-series">
            Effective: {effective.tvLimit ? `${effective.tvLimit} per ${effective.tvDays ?? '∞'} days` : 'unlimited'} — {quotaSummary(status.series)}
            {status.series.restricted ? <Chip tone="danger">limit reached</Chip> : null}
          </p>
        </div>
      </div>
      <SaveError error={save.error} />
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res.overrides);
                toast.push({ tone: 'ok', title: 'Quota saved' });
              },
            })
          }
        >
          Save quota
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Personal notification agents, Plex token, watchlist sync
// ---------------------------------------------------------------------------------------

const TYPE_LABELS: Record<keyof UserNotificationTypes, string> = {
  requestApproved: 'Request approved',
  requestDeclined: 'Request declined',
  requestAvailable: 'Request available',
  requestPending: 'Request pending approval (managers)',
  issueCreated: 'Issue reported (managers)',
  issueUpdated: 'Issue updated',
};

export function UserRequestSettingsForm({ userId }: { userId: number }) {
  const query = useUserRequestSettings(userId);
  const save = useSetUserRequestSettings(userId);
  const test = useTestUserNotifications(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<UserRequestSettings | null>(null);
  const [testResult, setTestResult] = useState<UserNotificationTestResult | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (draft === null) return <Skeleton lines={4} />;
  const n = draft.notifications;
  const setN = (patch: Partial<UserRequestSettings['notifications']>) => setDraft({ ...draft, notifications: { ...n, ...patch } });

  return (
    <div className="req-stack" data-testid="request-settings-form">
      <SectionLabel>Discord</SectionLabel>
      <Field label="Enabled" inline>
        <Toggle aria-label="Discord enabled" checked={n.discordEnabled} onChange={(e) => setN({ discordEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label="Webhook URL" hint="A webhook into a private channel or DM server.">
        <Input
          value={n.discordWebhookUrl ?? ''}
          onChange={(e) => setN(optionalText('discordWebhookUrl', e.currentTarget.value))}
          placeholder="https://discord.com/api/webhooks/…"
        />
      </Field>

      <SectionLabel>Telegram</SectionLabel>
      <Field label="Enabled" inline>
        <Toggle aria-label="Telegram enabled" checked={n.telegramEnabled} onChange={(e) => setN({ telegramEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label="Chat id" hint="Uses the bot of the first enabled Telegram connection.">
        <Input value={n.telegramChatId ?? ''} onChange={(e) => setN(optionalText('telegramChatId', e.currentTarget.value))} />
      </Field>
      <Field label="Send silently" inline>
        <Toggle checked={n.telegramSendSilently} onChange={(e) => setN({ telegramSendSilently: e.currentTarget.checked })} />
      </Field>

      <SectionLabel>Email</SectionLabel>
      <Field label="Enabled" inline>
        <Toggle aria-label="Email enabled" checked={n.emailEnabled} onChange={(e) => setN({ emailEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label="Address" hint="Blank: the account email.">
        <Input type="email" value={n.email ?? ''} onChange={(e) => setN(optionalText('email', e.currentTarget.value))} />
      </Field>

      <SectionLabel>Notify me about</SectionLabel>
      <div className="req-check-grid">
        {(Object.keys(TYPE_LABELS) as Array<keyof UserNotificationTypes>).map((k) => (
          <Checkbox key={k} label={TYPE_LABELS[k]} checked={n.types[k]} onChange={(e) => setN({ types: { ...n.types, [k]: e.currentTarget.checked } })} />
        ))}
      </div>

      <SectionLabel>Plex watchlist</SectionLabel>
      <Field label="Plex token" hint="Stored masked; leave the mask to keep the saved token.">
        <Input
          type="password"
          autoComplete="off"
          value={draft.plexToken ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            const { plexToken: _omit, ...rest } = draft;
            void _omit;
            setDraft(v ? { ...rest, plexToken: v } : rest);
          }}
          placeholder={REQUEST_SECRET_MASK}
        />
      </Field>
      <Field label="Sync movies" inline>
        <Toggle checked={draft.watchlistSyncMovies} onChange={(e) => setDraft({ ...draft, watchlistSyncMovies: e.currentTarget.checked })} />
      </Field>
      <Field label="Sync series" inline>
        <Toggle checked={draft.watchlistSyncSeries} onChange={(e) => setDraft({ ...draft, watchlistSyncSeries: e.currentTarget.checked })} />
      </Field>

      <SaveError error={save.error ?? test.error} />
      {testResult ? (
        <ul className="req-results" aria-label="Test results">
          {testResult.results.length === 0 ? <li className="al-muted">No personal agent is enabled.</li> : null}
          {testResult.results.map((r) => (
            <li key={r.agent} data-ok={r.ok}>
              {r.agent}: {r.ok ? 'sent' : (r.error ?? 'failed')}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res);
                toast.push({ tone: 'ok', title: 'Notification settings saved' });
              },
            })
          }
        >
          Save
        </Button>
        <Button
          variant="secondary"
          loading={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: setTestResult,
              onError: (err) => toast.error('Test failed', errorMessage(err)),
            })
          }
        >
          Send test
        </Button>
      </div>
    </div>
  );
}

/** Patch for an optional string field: blank clears it (undefined is dropped by JSON.stringify). */
function optionalText<K extends 'discordWebhookUrl' | 'telegramChatId' | 'email'>(key: K, raw: string): Partial<UserRequestSettings['notifications']> {
  return raw === '' ? ({ [key]: undefined } as Partial<UserRequestSettings['notifications']>) : ({ [key]: raw } as Partial<UserRequestSettings['notifications']>);
}
