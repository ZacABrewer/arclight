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
} from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input, Toggle } from '../../components/form.js';
import { LoadingBlock } from '../../components/spinner.js';
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
        <fieldset key={group} className="perm-group">
          <legend>{PERMISSION_GROUP_LABELS[group]}</legend>
          <div className="check-grid">
            {items.map((p) => {
              const locked = disabled || (lockAdmin && p.value === Permission.ADMIN);
              return (
                <label key={p.name} className="perm-item">
                  <input
                    type="checkbox"
                    aria-label={p.label}
                    checked={(value & p.value) === p.value}
                    disabled={locked}
                    onChange={(e) => onChange(togglePermission(value, p.value, e.currentTarget.checked))}
                  />
                  <span>
                    {p.label}
                    <small>{p.description}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      {isAdmin ? <p className="muted small">Admin passes every check; the other boxes have no effect.</p> : null}
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
  if (draft === null) return <LoadingBlock />;
  return (
    <div className="stack-sm">
      <PermissionsMatrix value={draft} onChange={setDraft} lockAdmin={lockAdmin} />
      <SaveError error={save.error} />
      <div className="row">
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
    <FormField label={label} hint={blankHint}>
      <Input
        type="number"
        min={0}
        aria-label={label}
        value={value[key] ?? ''}
        onChange={(e) => onChange({ ...value, [key]: numOrNull(e.currentTarget.value) })}
      />
    </FormField>
  );
  return (
    <div className="stack-sm">
      <div className="fields-row">
        {field('movieLimit', 'Movie request limit')}
        {field('movieDays', 'Movie window (days)')}
      </div>
      <div className="fields-row">
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
  if (!query.data || draft === null) return <LoadingBlock />;
  const { effective, status, exempt } = query.data;
  return (
    <div className="stack-sm" data-testid="quota-editor">
      {exempt ? (
        <p className="notice" role="status">
          This user manages users (or is an admin) and is exempt from quotas.
        </p>
      ) : null}
      <QuotaFields value={draft} onChange={setDraft} blankHint="Blank: use the global default" />
      <div className="fields-row">
        <div>
          <strong>Movies</strong>
          <p className="muted small" data-testid="quota-movie">
            Effective: {effective.movieLimit ? `${effective.movieLimit} per ${effective.movieDays ?? '∞'} days` : 'unlimited'} — {quotaSummary(status.movie)}
            {status.movie.restricted ? <Badge tone="error">limit reached</Badge> : null}
          </p>
        </div>
        <div>
          <strong>Series</strong>
          <p className="muted small" data-testid="quota-series">
            Effective: {effective.tvLimit ? `${effective.tvLimit} per ${effective.tvDays ?? '∞'} days` : 'unlimited'} — {quotaSummary(status.series)}
            {status.series.restricted ? <Badge tone="error">limit reached</Badge> : null}
          </p>
        </div>
      </div>
      <SaveError error={save.error} />
      <div className="row">
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
  if (draft === null) return <LoadingBlock />;
  const n = draft.notifications;
  const setN = (patch: Partial<UserRequestSettings['notifications']>) => setDraft({ ...draft, notifications: { ...n, ...patch } });

  return (
    <div className="stack-sm" data-testid="request-settings-form">
      <h3 className="section-title">Discord</h3>
      <FormField label="Enabled" inline>
        <Toggle aria-label="Discord enabled" checked={n.discordEnabled} onChange={(e) => setN({ discordEnabled: e.currentTarget.checked })} />
      </FormField>
      <FormField label="Webhook URL" hint="A webhook into a private channel or DM server.">
        <Input
          value={n.discordWebhookUrl ?? ''}
          onChange={(e) => setN(optionalText('discordWebhookUrl', e.currentTarget.value))}
          placeholder="https://discord.com/api/webhooks/…"
        />
      </FormField>

      <h3 className="section-title">Telegram</h3>
      <FormField label="Enabled" inline>
        <Toggle aria-label="Telegram enabled" checked={n.telegramEnabled} onChange={(e) => setN({ telegramEnabled: e.currentTarget.checked })} />
      </FormField>
      <FormField label="Chat id" hint="Uses the bot of the first enabled Telegram connection.">
        <Input value={n.telegramChatId ?? ''} onChange={(e) => setN(optionalText('telegramChatId', e.currentTarget.value))} />
      </FormField>
      <FormField label="Send silently" inline>
        <Toggle checked={n.telegramSendSilently} onChange={(e) => setN({ telegramSendSilently: e.currentTarget.checked })} />
      </FormField>

      <h3 className="section-title">Email</h3>
      <FormField label="Enabled" inline>
        <Toggle aria-label="Email enabled" checked={n.emailEnabled} onChange={(e) => setN({ emailEnabled: e.currentTarget.checked })} />
      </FormField>
      <FormField label="Address" hint="Blank: the account email.">
        <Input type="email" value={n.email ?? ''} onChange={(e) => setN(optionalText('email', e.currentTarget.value))} />
      </FormField>

      <h3 className="section-title">Notify me about</h3>
      <div className="check-grid">
        {(Object.keys(TYPE_LABELS) as Array<keyof UserNotificationTypes>).map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={n.types[k]} onChange={(e) => setN({ types: { ...n.types, [k]: e.currentTarget.checked } })} />
            {TYPE_LABELS[k]}
          </label>
        ))}
      </div>

      <h3 className="section-title">Plex watchlist</h3>
      <FormField label="Plex token" hint="Stored masked; leave the mask to keep the saved token.">
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
      </FormField>
      <FormField label="Sync movies" inline>
        <Toggle checked={draft.watchlistSyncMovies} onChange={(e) => setDraft({ ...draft, watchlistSyncMovies: e.currentTarget.checked })} />
      </FormField>
      <FormField label="Sync series" inline>
        <Toggle checked={draft.watchlistSyncSeries} onChange={(e) => setDraft({ ...draft, watchlistSyncSeries: e.currentTarget.checked })} />
      </FormField>

      <SaveError error={save.error ?? test.error} />
      {testResult ? (
        <ul className="test-result-list" aria-label="Test results">
          {testResult.results.length === 0 ? <li className="muted">No personal agent is enabled.</li> : null}
          {testResult.results.map((r) => (
            <li key={r.agent} className={r.ok ? 'text-ok' : 'text-error'}>
              {r.agent}: {r.ok ? 'sent' : (r.error ?? 'failed')}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
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
