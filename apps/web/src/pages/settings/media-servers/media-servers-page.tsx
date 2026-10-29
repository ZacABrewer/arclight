import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  REQUEST_SECRET_MASK,
  isLoginCapableKind,
  type MediaServerAccountResource,
  type MediaServerConnectionKind,
  type MediaServerImportResult,
  type MediaServerInputRaw,
  type MediaServerProbeResult,
  type MediaServerResource,
  type MediaServerUser,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { mediaServersApi, signInServerApi } from '../../../api/media-servers.js';
import { Button, Checkbox, Chip, EmptyState, ErrorBlock, FormRow, Input, KeyValue, Modal, Select, Skeleton, Table, Toggle, type Column } from '../../../arclight/index.js';
import { authKeys } from '../../../auth/guard.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import { useToast } from '../../../components/toast.js';
import { mediaServerKeys, useDeleteMediaServer, useImportableUsers, useMediaServerAccounts, useMediaServers, useSaveMediaServer, useSignInServer } from '../../../hooks/media-servers.js';
import { formatDateTime } from '../../../lib/ui-preferences.js';
import { SettingsPage } from '../settings-layout.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError, SettingsSection, type ItemCardSelect } from '../shared.js';
import { useResourceBulk } from '../../../components/resource-bulk-actions.js';
import './media-servers.css';
import { t } from '../../../i18n/index.js';

// Settings → Media servers (/settings/mediaservers): the list of Jellyfin/Emby/Plex and
// Audiobookshelf connections (GET/POST/PUT/DELETE /mediaserver) with what each is used for, a Test per
// server, its accounts, and the sign-in server (GET /settings/mediaserver, a view over the
// first server flagged for sign-in) with user import (/user/import/mediaserver).

export const KIND_LABELS: Record<MediaServerConnectionKind, string> = {
  get jellyfin() {
    return t('common.jellyfin');
  },
  get emby() {
    return t('common.emby');
  },
  get plex() {
    return t('common.plex');
  },
  get audiobookshelf() {
    return t('settings.mediaServers.audiobookshelf');
  },
};
const KIND_OPTIONS = (Object.keys(KIND_LABELS) as MediaServerConnectionKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }));

/** Example address per kind (placeholders only). */
const URL_PLACEHOLDERS: Record<MediaServerConnectionKind, string> = {
  jellyfin: 'http://jellyfin.lan:8096',
  emby: 'http://emby.lan:8096',
  plex: 'http://plex.lan:32400',
  audiobookshelf: 'http://audiobookshelf.lan:13378',
};

type Flag = 'enabled' | 'usedForAvailability' | 'usedForRetention' | 'usedForRefresh' | 'loginEnabled' | 'createUsersOnLogin';

export const FLAG_ROWS: ReadonlyArray<{ key: Flag; label: string; caption: string }> = [
  { key: 'enabled', get label() { return t('common.enabled'); }, get caption() { return t('settings.mediaServers.offKeepsTheConnectionBut'); } },
  { key: 'usedForAvailability', get label() { return t('settings.mediaServers.availability'); }, get caption() { return t('settings.mediaServers.requestsCountAsAvailableOnce'); } },
  { key: 'usedForRetention', get label() { return t('common.retention'); }, get caption() { return t('settings.mediaServers.watchHistoryFromThisServer'); } },
  { key: 'usedForRefresh', get label() { return t('settings.mediaServers.libraryRefresh'); }, get caption() { return t('settings.mediaServers.rescanThisServerAfterImports'); } },
  { key: 'loginEnabled', get label() { return t('settings.mediaServers.signIn'); }, get caption() { return t('settings.mediaServers.usersMaySignInWith'); } },
  { key: 'createUsersOnLogin', get label() { return t('settings.mediaServers.createUsersOnSignIn'); }, get caption() { return t('settings.mediaServers.aFirstSignInCreates'); } },
];

/**
 * The flags a kind can use. Audiobookshelf is a library server only: no availability,
 * retention or sign-in, just "enabled" and the refresh after audiobook imports.
 */
export function flagRowsFor(kind: MediaServerConnectionKind): ReadonlyArray<{ key: Flag; label: string; caption: string }> {
  if (isLoginCapableKind(kind)) return FLAG_ROWS;
  return FLAG_ROWS.filter((f) => f.key === 'enabled' || f.key === 'usedForRefresh').map((f) =>
    f.key === 'usedForRefresh' ? { key: f.key, label: t('settings.mediaServers.refreshAfterImports'), caption: t('settings.mediaServers.absRefreshCaption') } : f,
  );
}

/** Switching kinds: Audiobookshelf drops the video-only uses and is refreshed after imports by default. */
export function withKind(v: MediaServerInputRaw, kind: MediaServerConnectionKind): MediaServerInputRaw {
  if (isLoginCapableKind(kind)) return { ...v, kind };
  return { ...v, kind, usedForAvailability: false, usedForRetention: false, loginEnabled: false, createUsersOnLogin: false, usedForRefresh: true };
}

/** Chips naming what a server is used for: "Availability", "Retention", "Refresh", "Sign-in". */
export function serverUses(s: Pick<MediaServerResource, 'usedForAvailability' | 'usedForRetention' | 'usedForRefresh' | 'loginEnabled'>): string[] {
  const uses: string[] = [];
  if (s.usedForAvailability) uses.push(t('settings.mediaServers.useAvailability'));
  if (s.usedForRetention) uses.push(t('common.retention'));
  if (s.usedForRefresh) uses.push(t('common.refresh'));
  if (s.loginEnabled) uses.push(t('settings.mediaServers.useSignIn'));
  return uses;
}

/** Test result → the shared Test outcome: "Living room · 10.9.1 · 3 libraries" or the cause. */
export function probeOutcome(r: MediaServerProbeResult, kind?: MediaServerConnectionKind): TestOutcome {
  if (r.ok) {
    const libs = r.libraries?.length;
    const parts = [r.serverName, r.version, libs === undefined ? undefined : t('settings.mediaServers.libraryCount', { count: libs })].filter(Boolean);
    const empty = kind === 'audiobookshelf' ? t('settings.mediaServers.absNoLibraries') : t('settings.mediaServers.theServerReportsNoMovie');
    return { ok: true, message: parts.join(' · ') || undefined, warnings: libs === 0 ? [empty] : [], errors: [] };
  }
  return { ok: false, warnings: [], errors: [`${r.message ?? t('settings.mediaServers.serverDidNotAnswer')}${r.code ? ` (${r.code})` : ''}`] };
}

export type ServerErrors = Partial<Record<'name' | 'url' | 'apiKey', string>>;

/** Form validation: name, an http(s) URL (host:port is fine; the api adds http://) and a key for new servers. */
export function validateServer(v: MediaServerInputRaw, isNew: boolean): ServerErrors {
  const errors: ServerErrors = {};
  if (!v.name.trim()) errors.name = t('settings.mediaServers.enterAName');
  const url = v.url.trim();
  if (!url) errors.url = t('settings.mediaServers.enterTheServerAddress');
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) errors.url = t('common.useHttpAddress');
  if (isNew && !v.apiKey?.trim())
    errors.apiKey =
      v.kind === 'plex'
        ? t('settings.mediaServers.enterTheOwnersXPlex')
        : v.kind === 'audiobookshelf'
          ? t('settings.mediaServers.enterAnApiToken')
          : t('settings.mediaServers.enterAnApiKey');
  return errors;
}

function blankServer(): MediaServerInputRaw {
  return {
    kind: 'jellyfin',
    name: '',
    url: '',
    apiKey: '',
    enabled: true,
    usedForAvailability: true,
    usedForRetention: false,
    usedForRefresh: false,
    loginEnabled: false,
    createUsersOnLogin: false,
  };
}

function toInput(s: MediaServerResource): MediaServerInputRaw {
  const { id: _id, ...rest } = s;
  return rest;
}

// ---- editor -------------------------------------------------------------------------------

function ServerEditor({ server, onClose }: { server: MediaServerResource | null; onClose: () => void }) {
  const [value, setValue] = useState<MediaServerInputRaw>(server ? toInput(server) : blankServer());
  const [errors, setErrors] = useState<ServerErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [libraries, setLibraries] = useState<MediaServerProbeResult['libraries'] | null>(null);
  const save = useSaveMediaServer();
  const remove = useDeleteMediaServer();
  const ids = { kind: useId(), name: useId(), url: useId(), key: useId() };
  const set = <K extends keyof MediaServerInputRaw>(k: K, v: MediaServerInputRaw[K]) => setValue((d) => ({ ...d, [k]: v }));
  const check = () => {
    const e = validateServer(value, server === null);
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = () => {
    if (!check()) return;
    // Audiobookshelf is never a sign-in provider (the api rejects it).
    const body = isLoginCapableKind(value.kind) ? value : { ...value, loginEnabled: false, createUsersOnLogin: false };
    save.mutate({ id: server?.id, body }, { onSuccess: onClose });
  };
  const keyLabel =
    value.kind === 'plex' ? t('settings.mediaServers.xPlexToken') : value.kind === 'audiobookshelf' ? t('settings.mediaServers.apiToken') : t('common.apiKey');
  const test = async () => {
    const r = await mediaServersApi.test({ ...value, ...(server ? { id: server.id } : {}) });
    setLibraries(r.ok ? (r.libraries ?? null) : null);
    return probeOutcome(r, value.kind);
  };

  return (
    <>
      <Modal
        open
        size={640}
        onClose={onClose}
        title={server ? t('settings.mediaServers.editName', { name: server.name }) : t('settings.mediaServers.addMediaServer')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={server ? () => setConfirmDelete(true) : undefined}
            extra={<TestButton beforeTest={check} onTest={test} />}
          />
        }
      >
        <div className="al-ms-editor">
          <FormRow label={t('settings.mediaServers.kind')} htmlFor={ids.kind}>
            <Select id={ids.kind} value={value.kind} options={KIND_OPTIONS} onChange={(e) => {
                const next = e.currentTarget.value;
                const kind = KIND_OPTIONS.find((o) => o.value === next)?.value ?? 'jellyfin';
                setValue((d) => withKind(d, kind));
                setLibraries(null);
              }}
            />
          </FormRow>
          <FormRow label={t('common.name')} htmlFor={ids.name} error={errors.name} caption={t('settings.mediaServers.shownAsAvailableOnName')}>
            <Input id={ids.name} invalid={!!errors.name} value={value.name} onChange={(e) => set('name', e.currentTarget.value)} placeholder={KIND_LABELS[value.kind]} />
          </FormRow>
          <FormRow label={t('common.url')} htmlFor={ids.url} error={errors.url} caption={t('settings.mediaServers.baseAddressIncludingAnyUrl')}>
            <Input
              id={ids.url}
              mono
              spellCheck={false}
              invalid={!!errors.url}
              value={value.url}
              onChange={(e) => set('url', e.currentTarget.value)}
              placeholder={URL_PLACEHOLDERS[value.kind]}
            />
          </FormRow>
          <FormRow label={keyLabel} htmlFor={ids.key} error={errors.apiKey} caption={server ? t('settings.mediaServers.leaveTheMaskToKeep') : undefined}>
            <Input
              id={ids.key}
              type="password"
              mono
              autoComplete="off"
              invalid={!!errors.apiKey}
              value={value.apiKey ?? ''}
              placeholder={server ? REQUEST_SECRET_MASK : ''}
              onChange={(e) => set('apiKey', e.currentTarget.value)}
            />
          </FormRow>
          {libraries ? <LibraryList libraries={libraries} /> : null}
          <div className="al-ms-flags" role="group" aria-label={t('settings.mediaServers.useThisServerFor')}>
            {flagRowsFor(value.kind).map((f) => (
              <FormRow key={f.key} label={f.label} caption={f.caption} captionInline>
                <Toggle
                  aria-label={f.label}
                  checked={value[f.key] ?? false}
                  disabled={f.key === 'createUsersOnLogin' && !value.loginEnabled}
                  onChange={(e) => set(f.key, e.currentTarget.checked)}
                />
              </FormRow>
            ))}
          </div>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {server ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.mediaServers.deleteName', { name: server.name })}
          confirmLabel={t('settings.mediaServers.deleteMediaServer')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(server.id);
            onClose();
          }}
        >
          {t('settings.mediaServers.availabilityRetentionAndRefreshStop')}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** The libraries a successful test reported, with what each holds. */
function LibraryList({ libraries }: { libraries: NonNullable<MediaServerProbeResult['libraries']> }) {
  return (
    <FormRow label={t('settings.mediaServers.libraries')} caption={libraries.length === 0 ? t('settings.mediaServers.noLibrariesReported') : undefined}>
      <ul className="al-ms-libraries" aria-label={t('settings.mediaServers.libraries')}>
        {libraries.map((l) => (
          <li key={l.id}>
            <span className="al-ms-libraries__name">{l.name}</span>
            <Chip tone={l.type === 'other' ? 'muted' : 'neutral'} dot="none">
              {t('settings.mediaServers.libraryType', { type: l.type })}
            </Chip>
          </li>
        ))}
      </ul>
    </FormRow>
  );
}

// ---- accounts on one server ----------------------------------------------------------------

function AccountsDialog({ server, onClose }: { server: MediaServerResource; onClose: () => void }) {
  const accounts = useMediaServerAccounts(server.id);
  const columns: Column<MediaServerAccountResource>[] = [
    { key: 'name', header: t('common.account'), cell: (a) => a.name, sortValue: (a) => a.name.toLowerCase() },
    {
      key: 'role',
      header: t('common.role'),
      cell: (a) => (
        <span className="al-ms-chips">
          {a.isAdmin ? <Chip tone="accent">{t('common.admin')}</Chip> : <Chip tone="neutral">{t('common.user')}</Chip>}
          {a.isDisabled ? <Chip tone="muted">{t('common.disabled')}</Chip> : null}
        </span>
      ),
    },
    { key: 'last', header: t('settings.mediaServers.lastActive'), mono: true, cell: (a) => (a.lastActivityAt ? formatDateTime(a.lastActivityAt) : '—'), sortValue: (a) => a.lastActivityAt ?? '' },
  ];
  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={t('settings.mediaServers.accountsOnName', { name: server.name })}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {accounts.isError ? (
        <ErrorBlock title={t('settings.mediaServers.couldntReadTheAccountsOn', { name: server.name })} onRetry={() => void accounts.refetch()}>
          {errorMessage(accounts.error)}
        </ErrorBlock>
      ) : (
        <div className="al-ms-table">
          <Table caption={t('settings.mediaServers.accountsOnName', { name: server.name })} columns={columns} rows={accounts.data} rowKey={(a) => a.id} loading={accounts.isPending} empty={<EmptyState title={t('settings.mediaServers.noAccounts')} />} />
        </div>
      )}
    </Modal>
  );
}

// ---- user import (sign-in server) ----------------------------------------------------------

/** Accounts that can be imported: enabled and not linked to a local user yet. */
export function importableIds(users: readonly MediaServerUser[]): string[] {
  return users.filter((u) => !u.isDisabled && u.linkedUserId === null).map((u) => u.externalId);
}

export function importSummary(r: MediaServerImportResult): string {
  const made = t('settings.mediaServers.usersImported', { count: r.created.length });
  return r.skipped.length ? t('settings.mediaServers.madeSkippedcountSkipped', { made, skippedCount: r.skipped.length }) : made;
}

function ImportUsersDialog({ onClose }: { onClose: () => void }) {
  const users = useImportableUsers(true);
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MediaServerImportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const available = users.data ? importableIds(users.data) : [];
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await signInServerApi.importUsers({ externalIds: [...selected] });
      setResult(r);
      setSelected(new Set());
      toast.push({ tone: 'ok', title: importSummary(r) });
      await Promise.all([qc.invalidateQueries({ queryKey: mediaServerKeys.importable }), qc.invalidateQueries({ queryKey: authKeys.users })]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<MediaServerUser>[] = [
    {
      key: 'pick',
      header: <span className="al-sr-only">{t('common.select')}</span>,
      cell: (u) => (
        <Checkbox
          aria-label={t('settings.mediaServers.selectUsername', { username: u.username })}
          disabled={!available.includes(u.externalId)}
          checked={selected.has(u.externalId)}
          onChange={(e) => toggle(u.externalId, e.currentTarget.checked)}
        />
      ),
    },
    { key: 'name', header: t('common.account'), cell: (u) => u.username, sortValue: (u) => u.username.toLowerCase() },
    { key: 'email', header: t('common.email'), muted: true, cell: (u) => u.email ?? '—' },
    {
      key: 'state',
      header: t('common.state'),
      cell: (u) =>
        u.linkedUserId !== null ? <Chip tone="accent">{t('settings.mediaServers.linked')}</Chip> : u.isDisabled ? <Chip tone="muted">{t('common.disabled')}</Chip> : <Chip tone="neutral">{t('settings.mediaServers.notImported')}</Chip>,
    },
  ];

  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={t('settings.mediaServers.importUsers')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="secondary" disabled={available.length === 0} onClick={() => setSelected(new Set(available))}>
            {t('settings.mediaServers.selectAll')}
          </Button>
          <Button variant="primary" loading={busy} disabled={selected.size === 0} onClick={() => void runImport()}>
            {t('settings.mediaServers.importSelectedValue', { value: selected.size ? ` (${selected.size})` : '' })}
          </Button>
        </>
      }
    >
      <p className="al-caption" style={{ marginTop: 0 }}>
        {t('settings.mediaServers.importedAccountsBecomeArclightUsers')}
      </p>
      {users.isError ? (
        <ErrorBlock title={t('settings.mediaServers.couldntListTheServersAccounts')} onRetry={() => void users.refetch()}>
          {errorMessage(users.error)}
        </ErrorBlock>
      ) : (
        <div className="al-ms-table">
          <Table caption={t('settings.mediaServers.mediaServerAccounts')} columns={columns} rows={users.data} rowKey={(u) => u.externalId} loading={users.isPending} empty={<EmptyState title={t('settings.mediaServers.noAccountsOnTheServer')} />} />
        </div>
      )}
      {result && result.skipped.length ? (
        <ul className="al-ms-skipped" aria-label={t('settings.mediaServers.skippedAccounts')}>
          {result.skipped.map((s) => (
            <li key={s.externalId}>
              <span className="al-num">{s.externalId}</span> · {s.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <SaveError error={error} />
    </Modal>
  );
}

function SignInSection({ servers }: { servers: readonly MediaServerResource[] }) {
  const signIn = useSignInServer();
  const [importing, setImporting] = useState(false);
  const loginServer = servers.find((s) => s.enabled && s.loginEnabled);
  return (
    <SettingsSection
      label={t('settings.mediaServers.signInAndUserImport')}
      action={
        <Button size="sm" variant="secondary" disabled={!signIn.data?.kind} onClick={() => setImporting(true)}>
          {t('settings.mediaServers.importUsers')}
        </Button>
      }
    >
      {signIn.isPending ? (
        <Skeleton lines={2} />
      ) : signIn.isError ? (
        <ErrorBlock title={t('settings.mediaServers.couldntReadTheSignIn')} onRetry={() => void signIn.refetch()}>
          {errorMessage(signIn.error)}
        </ErrorBlock>
      ) : !signIn.data.kind ? (
        <p className="al-caption">{t('settings.mediaServers.noServerIsSetUp')}</p>
      ) : (
        <div className="al-ms-signin">
          <KeyValue
            items={[
              { label: t('settings.mediaServers.server'), value: signIn.data.name || KIND_LABELS[signIn.data.kind], mono: false },
              { label: t('settings.mediaServers.kind'), value: KIND_LABELS[signIn.data.kind], mono: false },
              { label: t('common.url'), value: signIn.data.url || '—' },
              { label: t('settings.mediaServers.signIn'), value: signIn.data.loginEnabled ? t('common.on') : t('common.off'), mono: false },
              { label: t('settings.mediaServers.newUsers'), value: signIn.data.createUsersOnLogin ? t('settings.mediaServers.createdOnFirstSignIn') : t('settings.mediaServers.importOrCreateThemFirst'), mono: false },
            ]}
          />
          {!loginServer ? <p className="al-caption">{t('settings.mediaServers.signInUsesTheFirst')}</p> : null}
          <TestButton
            size="sm"
            label={t('settings.mediaServers.testSignInServer')}
            onTest={async () => {
              const r = await signInServerApi.test();
              return { ok: r.ok, message: [r.serverName, r.version].filter(Boolean).join(' · ') || undefined, warnings: [], errors: r.ok ? [] : [r.message ?? t('settings.mediaServers.theServerDidNotAnswer')] };
            }}
          />
        </div>
      )}
      {importing ? <ImportUsersDialog onClose={() => setImporting(false)} /> : null}
    </SettingsSection>
  );
}

// ---- page ---------------------------------------------------------------------------------

function ServerCard({ server, onEdit, onUsers, select }: { server: MediaServerResource; onEdit: () => void; onUsers: () => void; select?: ItemCardSelect | undefined }) {
  const uses = serverUses(server);
  return (
    <ItemCard
      title={server.name}
      onClick={onEdit}
      select={select}
      muted={!server.enabled}
      status={server.enabled ? <Chip tone="neutral">{KIND_LABELS[server.kind]}</Chip> : <Chip tone="muted">{t('common.disabled')}</Chip>}
      actions={
        <>
          <TestButton size="sm" onTest={async () => probeOutcome(await mediaServersApi.testSaved(server.id), server.kind)} />
          {isLoginCapableKind(server.kind) ? (
            <Button size="sm" variant="secondary" onClick={onUsers} aria-label={t('settings.mediaServers.accountsOnName', { name: server.name })}>
              {t('common.users')}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={t('settings.mediaServers.editName', { name: server.name })}>
            {t('common.edit')}
          </Button>
        </>
      }
    >
      <span className="al-num al-ms-url">{server.url}</span>
      <span className="al-ms-chips">
        {uses.length ? (
          uses.map((u) => (
            <Chip key={u} tone="default" dot="none">
              {u}
            </Chip>
          ))
        ) : (
          <Chip tone="warn">{t('settings.mediaServers.notUsed')}</Chip>
        )}
      </span>
    </ItemCard>
  );
}

/** Settings → Media servers (/settings/mediaservers). */
export function MediaServersPage() {
  const list = useMediaServers();
  const [editing, setEditing] = useState<MediaServerResource | 'new' | null>(null);
  const [accounts, setAccounts] = useState<MediaServerResource | null>(null);
  const bulk = useResourceBulk('mediaserver', list.data, (s) => s.id, (s) => s.name);
  return (
    <SettingsPage
      title={t('settings.mediaServers.mediaServers')}
      description={t('settings.mediaServers.jellyfinEmbyAndPlexServers')}
      actions={
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          {t('settings.mediaServers.addServer')}
        </Button>
      }
    >
      <SettingsSection label={t('settings.mediaServers.servers')} count={list.data?.length}>
        {list.isPending ? (
          <Skeleton lines={3} />
        ) : list.isError ? (
          <ErrorBlock title={t('settings.mediaServers.couldntLoadMediaServers')} onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <>
            <CardGrid label={t('settings.mediaServers.mediaServers')}>
              {list.data.map((s) => (
                <ServerCard key={s.id} server={s} onEdit={() => setEditing(s)} onUsers={() => setAccounts(s)} select={bulk.cardProps(s)} />
              ))}
              <AddCard label={t('settings.mediaServers.addMediaServer')} onClick={() => setEditing('new')} />
            </CardGrid>
            {bulk.bar}
          </>
        )}
      </SettingsSection>
      <SignInSection servers={list.data ?? []} />
      {editing ? <ServerEditor server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {accounts ? <AccountsDialog server={accounts} onClose={() => setAccounts(null)} /> : null}
    </SettingsPage>
  );
}
