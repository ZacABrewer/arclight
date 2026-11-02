import { useEffect, useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  JELLYFIN_PLUGIN_MANIFEST_URL,
  type JellyfinPluginKey,
  type JellyfinPluginKeyCreated,
  type MediaServerAccountRow,
  type MediaServerResource,
  type MediaServerSyncStatus,
  type WatchHistorySettings,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { jellyfinPluginApi, watchHistoryApi } from '../../../api/watch-history.js';
import { Button, Chip, EmptyState, ErrorBlock, FormRow, Input, KeyValue, Modal, Skeleton, Table, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useToast } from '../../../components/toast.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import {
  useJellyfinPlugin,
  useMediaServerSync,
  usePlexWebhook,
  useRemovePluginKey,
  useSaveWatchHistorySettings,
  useServerAccounts,
  useWatchHistorySettings,
  watchHistoryKeys,
} from '../../../hooks/watch-history.js';
import { t } from '../../../i18n/index.js';
import { formatDateTime } from '../../../lib/ui-preferences.js';
import { SaveError, SettingsSection } from '../shared.js';

// Settings → Media servers, watch history and the Jellyfin plugin: per Jellyfin/Emby server the
// watch-history sync state (GET /mediaserver/:id/sync) with Sync now / Full resync / Sync users,
// the synced accounts (GET /mediaserver/:id/accounts), the sync settings (/settings/watchhistory),
// and the plugin card (/settings/jellyfinplugin): repository URL, plugin keys, last contact.

const when = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '—');

/** "OK" / "Failed" / "Running" chip for a sync run, or "Never" before the first one. */
export function syncChip(status: MediaServerSyncStatus['lastStatus']) {
  if (status === 'ok') return <Chip tone="default">{t('settings.watchSync.statusOk')}</Chip>;
  if (status === 'failed') return <Chip tone="danger">{t('settings.watchSync.statusFailed')}</Chip>;
  if (status === 'running') return <Chip tone="accent">{t('common.running')}</Chip>;
  return <Chip tone="muted">{t('settings.watchSync.never')}</Chip>;
}

/** Jellyfin/Emby/Plex servers: the kinds the watch-history sync reads. */
export function watchServers(servers: readonly MediaServerResource[]): MediaServerResource[] {
  return servers.filter((s) => s.kind === 'jellyfin' || s.kind === 'emby' || s.kind === 'plex');
}

/** The full webhook URL to paste into Plex: this page's origin plus the API path and secret. */
export function plexWebhookUrl(path: string, origin = typeof window === 'undefined' ? '' : window.location.origin): string {
  return `${origin}${path}`;
}

// ---- per-server sync ------------------------------------------------------------------------

function ServerSyncRow({ server }: { server: MediaServerResource }) {
  const sync = useMediaServerSync(server.id);
  const toast = useToast();
  const [accounts, setAccounts] = useState(false);
  const keys = [watchHistoryKeys.sync(server.id), watchHistoryKeys.accounts(server.id)];
  const syncNow = useInvalidatingMutation((full: boolean) => watchHistoryApi.syncNow(server.id, full), keys, { errorTitle: t('settings.watchSync.syncFailed') });
  const syncUsers = useInvalidatingMutation(() => watchHistoryApi.syncUsers(server.id), keys, { errorTitle: t('settings.watchSync.userSyncFailed') });
  const st = sync.data;
  const enabled = st?.watchSyncEnabled ?? server.syncWatchHistory ?? false;

  const runSync = (full: boolean) =>
    syncNow.mutate(full, {
      onSuccess: (r) =>
        r.status === 'failed'
          ? toast.push({ tone: 'error', title: t('settings.watchSync.syncFailed'), message: r.message })
          : toast.push({ tone: 'ok', title: t('settings.watchSync.syncDone', { name: server.name, users: r.users, changed: r.changed }) }),
    });

  return (
    <div className="al-ms-sync" role="group" aria-label={t('settings.watchSync.syncOf', { name: server.name })}>
      <div className="al-ms-sync__head">
        <strong>{server.name}</strong>
        {enabled ? syncChip(st?.lastStatus ?? null) : <Chip tone="muted">{t('settings.watchSync.syncOff')}</Chip>}
      </div>
      {sync.isPending ? (
        <Skeleton lines={2} />
      ) : sync.isError ? (
        <p className="al-caption">{errorMessage(sync.error)}</p>
      ) : (
        <KeyValue
          layout="grid"
          columns={3}
          items={[
            { label: t('settings.watchSync.lastSync'), value: when(st?.lastSyncAt) },
            { label: t('settings.watchSync.lastFullSync'), value: when(st?.lastFullSyncAt) },
            { label: t('settings.watchSync.itemsTracked'), value: String(st?.itemsTracked ?? 0) },
            { label: t('settings.watchSync.accounts'), value: t('settings.watchSync.linkedOfTotal', { linked: st?.linkedUsers ?? 0, total: st?.users ?? 0 }), mono: false },
            { label: t('settings.watchSync.lastUserSync'), value: when(st?.lastUserSyncAt) },
            { label: server.kind === 'plex' ? t('settings.watchSync.lastLiveEvent') : t('settings.watchSync.lastPluginEvent'), value: when(st?.lastEventAt) },
          ]}
        />
      )}
      {server.kind === 'plex' ? <PlexWebhookField server={server} /> : null}
      {st?.lastError ? <p className="al-caption al-ms-sync__error">{st.lastError}</p> : null}
      {st?.lastUserSyncError ? <p className="al-caption al-ms-sync__error">{st.lastUserSyncError}</p> : null}
      <div className="al-ms-sync__actions">
        <Button size="sm" variant="secondary" disabled={!enabled} loading={syncNow.isPending && syncNow.variables === false} onClick={() => runSync(false)}>
          {t('settings.watchSync.syncNow')}
        </Button>
        <Button size="sm" variant="ghost" disabled={!enabled} loading={syncNow.isPending && syncNow.variables === true} onClick={() => runSync(true)}>
          {t('settings.watchSync.fullResync')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={syncUsers.isPending}
          onClick={() =>
            syncUsers.mutate(undefined, {
              onSuccess: (r) =>
                toast.push({ tone: r.status === 'failed' ? 'error' : 'ok', title: r.status === 'failed' ? t('settings.watchSync.userSyncFailed') : t('settings.watchSync.userSyncDone', { added: r.added, renamed: r.renamed, deleted: r.deleted }), message: r.message }),
            })
          }
        >
          {t('settings.watchSync.syncUsers')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAccounts(true)} aria-label={t('settings.watchSync.syncedAccountsOf', { name: server.name })}>
          {t('settings.watchSync.accounts')}
        </Button>
      </div>
      {accounts ? <SyncedAccountsDialog server={server} onClose={() => setAccounts(false)} /> : null}
    </div>
  );
}

/** Plex: the webhook URL (Plex Pass) with a rotate button; sessions are polled either way. */
function PlexWebhookField({ server }: { server: MediaServerResource }) {
  const hook = usePlexWebhook(server.id);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const rotate = useInvalidatingMutation(() => watchHistoryApi.regeneratePlexWebhook(server.id), [watchHistoryKeys.plexWebhook(server.id)], { errorTitle: t('settings.watchSync.plexWebhookRotateFailed') });
  const label = t('settings.watchSync.plexWebhookUrl');
  return (
    <FormRow label={label} caption={t('settings.watchSync.plexWebhookCaption')}>
      {hook.isPending ? (
        <Skeleton lines={1} />
      ) : hook.isError ? (
        <p className="al-caption">{errorMessage(hook.error)}</p>
      ) : (
        <>
          <CopyField value={plexWebhookUrl(hook.data.path)} label={t('settings.watchSync.plexWebhookUrlOf', { name: server.name })} />
          <div>
            <Button size="sm" variant="ghost" loading={rotate.isPending} onClick={() => setConfirm(true)}>
              {t('settings.watchSync.plexWebhookRotate')}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        danger
        title={t('settings.watchSync.plexWebhookRotate')}
        confirmLabel={t('settings.watchSync.plexWebhookRotate')}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await rotate.mutateAsync(undefined);
          setConfirm(false);
          toast.push({ tone: 'ok', title: t('settings.watchSync.plexWebhookRotated') });
        }}
      >
        <p>{t('settings.watchSync.plexWebhookRotateConfirm')}</p>
      </ConfirmDialog>
    </FormRow>
  );
}

function SyncedAccountsDialog({ server, onClose }: { server: MediaServerResource; onClose: () => void }) {
  const accounts = useServerAccounts(server.id);
  const columns: Column<MediaServerAccountRow>[] = [
    { key: 'name', header: t('common.account'), cell: (a) => a.name, sortValue: (a) => a.name.toLowerCase() },
    {
      key: 'state',
      header: t('common.state'),
      cell: (a) => (
        <span className="al-ms-chips">
          {a.isAdmin ? <Chip tone="accent">{t('common.admin')}</Chip> : null}
          {a.deleted ? <Chip tone="warn">{t('settings.watchSync.deleted')}</Chip> : a.disabled ? <Chip tone="muted">{t('common.disabled')}</Chip> : null}
        </span>
      ),
    },
    { key: 'user', header: t('settings.watchSync.arclightUser'), cell: (a) => a.arclightUsername ?? <span className="al-caption">{t('settings.watchSync.notLinked')}</span> },
    { key: 'synced', header: t('settings.watchSync.lastSync'), mono: true, cell: (a) => when(a.lastWatchSyncAt), sortValue: (a) => a.lastWatchSyncAt ?? '' },
  ];
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={t('settings.watchSync.syncedAccountsOf', { name: server.name })}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {accounts.isError ? (
        <ErrorBlock title={t('settings.watchSync.couldNotLoadAccounts')} onRetry={() => void accounts.refetch()}>
          {errorMessage(accounts.error)}
        </ErrorBlock>
      ) : (
        <div className="al-ms-table">
          <Table
            caption={t('settings.watchSync.syncedAccountsOf', { name: server.name })}
            columns={columns}
            rows={accounts.data}
            rowKey={(a) => a.id}
            loading={accounts.isPending}
            empty={<EmptyState title={t('settings.watchSync.noAccountsYet')} />}
          />
        </div>
      )}
    </Modal>
  );
}

function WatchHistorySettingsForm() {
  const settings = useWatchHistorySettings();
  const save = useSaveWatchHistorySettings();
  const toast = useToast();
  const [draft, setDraft] = useState<WatchHistorySettings | null>(null);
  const ids = { interval: useId(), full: useId(), retention: useId() };
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  if (!draft) return settings.isError ? <p className="al-caption">{errorMessage(settings.error)}</p> : <Skeleton lines={2} />;
  const num = (k: keyof WatchHistorySettings) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: Number(e.currentTarget.value) });
  return (
    <form
      className="al-ms-sync-settings"
      aria-label={t('settings.watchSync.settings')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft, { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.watchSync.settingsSaved') }) });
      }}
    >
      <FormRow label={t('settings.watchSync.intervalMinutes')} htmlFor={ids.interval} caption={t('settings.watchSync.intervalCaption')}>
        <Input id={ids.interval} type="number" min={5} max={1440} mono value={draft.syncIntervalMinutes} onChange={num('syncIntervalMinutes')} />
      </FormRow>
      <FormRow label={t('settings.watchSync.fullSyncHours')} htmlFor={ids.full} caption={t('settings.watchSync.fullSyncCaption')}>
        <Input id={ids.full} type="number" min={1} max={168} mono value={draft.fullSyncHours} onChange={num('fullSyncHours')} />
      </FormRow>
      <FormRow label={t('settings.watchSync.retentionDays')} htmlFor={ids.retention} caption={t('settings.watchSync.retentionCaption')}>
        <Input id={ids.retention} type="number" min={7} max={3650} mono value={draft.eventRetentionDays} onChange={num('eventRetentionDays')} />
      </FormRow>
      <div>
        <Button type="submit" size="sm" variant="secondary" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
      <SaveError error={save.error} />
    </form>
  );
}

/** Watch history: sync state per Jellyfin/Emby/Plex server and the sync settings. */
export function WatchHistorySection({ servers }: { servers: readonly MediaServerResource[] }) {
  const jellyfin = watchServers(servers);
  return (
    <SettingsSection label={t('settings.watchSync.watchHistory')} count={jellyfin.length || undefined}>
      <p className="al-caption" style={{ marginTop: 0 }}>
        {t('settings.watchSync.intro')}
      </p>
      {jellyfin.length === 0 ? (
        <p className="al-caption">{t('settings.watchSync.noJellyfinServer')}</p>
      ) : (
        <div className="al-ms-sync-list">
          {jellyfin.map((s) => (
            <ServerSyncRow key={s.id} server={s} />
          ))}
        </div>
      )}
      <WatchHistorySettingsForm />
    </SettingsSection>
  );
}

// ---- Jellyfin plugin ------------------------------------------------------------------------

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="al-api-key">
      <Input readOnly mono aria-label={label} className="al-api-key__input" value={value} onFocus={(e) => e.currentTarget.select()} />
      <div className="al-api-key__actions">
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            )
          }
        >
          {copied ? t('settings.security.apiKey.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

/** "Connected" when the plugin sent something within the last day. */
export function pluginConnected(lastPingAt: string | null, lastEventAt: string | null, now = Date.now()): boolean {
  const latest = [lastPingAt, lastEventAt].filter((d): d is string => d !== null).map((d) => Date.parse(d));
  return latest.some((ms) => now - ms < 24 * 60 * 60_000);
}

export function JellyfinPluginSection() {
  const plugin = useJellyfinPlugin();
  const remove = useRemovePluginKey();
  const create = useInvalidatingMutation((name: string) => jellyfinPluginApi.createKey(name || undefined), [watchHistoryKeys.plugin], { silent: true });
  const [created, setCreated] = useState<JellyfinPluginKeyCreated | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<JellyfinPluginKey | null>(null);
  const nameId = useId();
  const data = plugin.data;

  const columns: Column<JellyfinPluginKey>[] = [
    { key: 'name', header: t('common.name'), cell: (k) => k.name },
    { key: 'prefix', header: t('settings.jellyfinPlugin.key'), mono: true, cell: (k) => `${k.prefix}…` },
    { key: 'used', header: t('settings.jellyfinPlugin.lastUsed'), mono: true, cell: (k) => when(k.lastUsedAt) },
    { key: 'ping', header: t('settings.jellyfinPlugin.lastPing'), mono: true, cell: (k) => when(k.lastPingAt) },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      cell: (k) => (
        <Button size="sm" variant="ghost" onClick={() => setDeleting(k)} aria-label={t('settings.jellyfinPlugin.deleteKeyName', { name: k.name })}>
          {t('common.delete')}
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection
      label={t('settings.jellyfinPlugin.title')}
      action={
        <Button size="sm" variant="secondary" onClick={() => setNaming(true)}>
          {t('settings.jellyfinPlugin.createKey')}
        </Button>
      }
    >
      <p className="al-caption" style={{ marginTop: 0 }}>
        {t('settings.jellyfinPlugin.intro')}
      </p>
      <p className="al-caption" style={{ marginTop: 0 }}>
        <Link to="/settings/statscollections" className="al-link">
          {t('settings.jellyfinPlugin.statsLink')}
        </Link>
      </p>
      <FormRow label={t('settings.jellyfinPlugin.repositoryUrl')} caption={t('settings.jellyfinPlugin.repositoryCaption')}>
        <CopyField value={data?.manifestUrl ?? JELLYFIN_PLUGIN_MANIFEST_URL} label={t('settings.jellyfinPlugin.repositoryUrl')} />
      </FormRow>
      {plugin.isPending ? (
        <Skeleton lines={2} />
      ) : plugin.isError ? (
        <ErrorBlock title={t('settings.jellyfinPlugin.couldNotLoad')} onRetry={() => void plugin.refetch()}>
          {errorMessage(plugin.error)}
        </ErrorBlock>
      ) : data ? (
        <>
          <ul className="al-ms-plugin-servers" aria-label={t('settings.jellyfinPlugin.connection')}>
            {data.servers.map((s) => (
              <li key={s.serverId}>
                <span>{s.name}</span>
                {pluginConnected(data.lastPingAt, s.lastEventAt) ? (
                  <Chip tone="default">{t('settings.jellyfinPlugin.connected')}</Chip>
                ) : (
                  <Chip tone="muted">{t('settings.jellyfinPlugin.notConnected')}</Chip>
                )}
                <span className="al-caption">{t('settings.jellyfinPlugin.lastEvent', { when: when(s.lastEventAt) })}</span>
                {!s.remoteId ? <span className="al-caption">{t('settings.jellyfinPlugin.testToLearnId')}</span> : null}
              </li>
            ))}
          </ul>
          <div className="al-ms-table">
            <Table
              caption={t('settings.jellyfinPlugin.keys')}
              columns={columns}
              rows={data.keys}
              rowKey={(k) => k.id}
              empty={<EmptyState title={t('settings.jellyfinPlugin.noKeys')} />}
            />
          </div>
        </>
      ) : null}
      {naming ? (
        <Modal
          open
          size="sm"
          onClose={() => setNaming(false)}
          title={t('settings.jellyfinPlugin.createKey')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setNaming(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={create.isPending}
                onClick={() =>
                  create.mutate(name.trim(), {
                    onSuccess: (k) => {
                      setCreated(k);
                      setNaming(false);
                      setName('');
                    },
                  })
                }
              >
                {t('settings.jellyfinPlugin.create')}
              </Button>
            </>
          }
        >
          <FormRow label={t('common.name')} htmlFor={nameId}>
            <Input id={nameId} value={name} placeholder={t('settings.jellyfinPlugin.defaultName')} onChange={(e) => setName(e.currentTarget.value)} />
          </FormRow>
          <SaveError error={create.error} />
        </Modal>
      ) : null}
      {created ? (
        <Modal
          open
          size="md"
          onClose={() => setCreated(null)}
          title={t('settings.jellyfinPlugin.keyCreated')}
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              {t('common.close')}
            </Button>
          }
        >
          <p className="al-caption" style={{ marginTop: 0 }}>
            {t('settings.jellyfinPlugin.shownOnce')}
          </p>
          <CopyField value={created.key} label={t('settings.jellyfinPlugin.key')} />
        </Modal>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.jellyfinPlugin.deleteKeyName', { name: deleting?.name ?? '' })}
        confirmLabel={t('settings.jellyfinPlugin.deleteKey')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      >
        {t('settings.jellyfinPlugin.deleteWarning')}
      </ConfirmDialog>
    </SettingsSection>
  );
}

