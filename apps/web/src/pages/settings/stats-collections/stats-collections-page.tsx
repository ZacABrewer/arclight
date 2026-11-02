import { useId, type ReactNode } from 'react';
import type { CollectionsSettings, NewsletterRun, StatsAudience, WatchStatsSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Banner, Button, Checkbox, ErrorBlock, FormRow, Input, KeyValue, Pane, Select, Skeleton, Table, Toggle, type Column } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useMediaServers } from '../../../hooks/media-servers.js';
import { useNotificationList } from '../../../hooks/settings.js';
import { useCollectionsSettings, useSaveCollectionsSettings } from '../../../hooks/smart-collections.js';
import { useNewsletter, useSaveWatchStatsSettings, useSendNewsletter, useWatchStatsSettings } from '../../../hooks/watch-stats.js';
import { t } from '../../../i18n/index.js';
import { formatDateTime } from '../../../lib/format.js';
import { hourLabel, weekdayName } from '../../../features/watch-stats/stats-model.js';
import { watchServers } from '../media-servers/watch-sync.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SaveError, SettingsSection } from '../shared.js';
import './stats-collections.css';

// Settings → Stats & collections: what the Jellyfin plugin shows, Year in review share links,
// the weekly "recently added" newsletter (sent through an email notification connection) and
// the Leaving Soon collection plus the servers smart collections are kept on.

interface Combined {
  stats: WatchStatsSettings;
  collections: CollectionsSettings;
}

/** Problems that block saving (the api would answer 400). */
export function statsCollectionsErrors(v: Combined): string[] {
  const e: string[] = [];
  const { shareLinkDays } = v.stats.wrapped;
  if (!Number.isInteger(shareLinkDays) || shareLinkDays < 1 || shareLinkDays > 90) e.push(t('settings.statsCollections.errors.shareDays'));
  const { maxItems } = v.stats.newsletter;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) e.push(t('settings.statsCollections.errors.maxItems'));
  if (v.stats.newsletter.enabled && v.stats.newsletter.notificationId === null) e.push(t('settings.statsCollections.errors.connection'));
  const { days, name } = v.collections.leavingSoon;
  if (!Number.isInteger(days) || days < 1 || days > 90) e.push(t('settings.statsCollections.errors.leavingDays'));
  if (!name.trim() || name.trim().length > 100) e.push(t('settings.statsCollections.errors.leavingName'));
  return e;
}

function NumberRow({ label, caption, value, min, max, onChange }: { label: string; caption?: ReactNode; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const id = useId();
  const bad = !Number.isInteger(value) || value < min || value > max;
  return (
    <FormRow label={label} htmlFor={id} caption={caption} error={bad ? t('settings.statsCollections.errors.range', { min, max }) : undefined}>
      <Input
        id={id}
        mono
        inputMode="numeric"
        className="stc-number"
        value={Number.isNaN(value) ? '' : String(value)}
        invalid={bad}
        onChange={(e) => onChange(e.currentTarget.value.trim() === '' ? NaN : Number(e.currentTarget.value))}
      />
    </FormRow>
  );
}

function NewsletterPreviewPane() {
  const nl = useNewsletter();
  const send = useSendNewsletter();
  const toast = useToast();
  const runColumns: Column<NewsletterRun>[] = [
    { key: 'sentAt', header: t('settings.statsCollections.newsletter.sentAt'), mono: true, mobile: 'primary', cell: (r) => formatDateTime(r.sentAt) },
    { key: 'trigger', header: t('settings.statsCollections.newsletter.trigger'), cell: (r) => (r.trigger === 'manual' ? t('settings.statsCollections.newsletter.manual') : t('settings.statsCollections.newsletter.scheduled')) },
    { key: 'recipients', header: t('settings.statsCollections.newsletter.recipients'), mono: true, align: 'right', cell: (r) => r.recipients },
    { key: 'items', header: t('settings.statsCollections.newsletter.items'), mono: true, align: 'right', cell: (r) => r.items },
    { key: 'error', header: t('settings.statsCollections.newsletter.result'), mobile: 'end', cell: (r) => (r.error ? <span className="stc-error">{r.error}</span> : t('settings.statsCollections.newsletter.sent')) },
  ];
  return (
    <Pane
      title={t('settings.statsCollections.newsletter.previewTitle')}
      aria-label={t('settings.statsCollections.newsletter.previewTitle')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={send.isPending}
          disabled={!nl.data || nl.data.preview.recipients === 0 || nl.data.preview.problem !== null}
          onClick={() =>
            send.mutate(undefined, {
              onSuccess: (run) =>
                toast.push(
                  run.error
                    ? { tone: 'error', title: t('settings.statsCollections.newsletter.sendFailed'), message: run.error }
                    : { tone: 'ok', title: t('settings.statsCollections.newsletter.sentTo', { count: run.recipients }) },
                ),
              onError: (err) => toast.push({ tone: 'error', title: t('settings.statsCollections.newsletter.sendFailed'), message: errorMessage(err) }),
            })
          }
        >
          {t('settings.statsCollections.newsletter.sendNow')}
        </Button>
      }
    >
      {nl.isError ? (
        <ErrorBlock title={t('settings.statsCollections.newsletter.couldNotLoad')} onRetry={() => void nl.refetch()}>
          {errorMessage(nl.error)}
        </ErrorBlock>
      ) : nl.isPending ? (
        <Skeleton lines={5} />
      ) : (
        <div className="stc-stack">
          <p className="al-caption stc-note">{t('settings.statsCollections.newsletter.previewNote')}</p>
          {nl.data.preview.problem ? <Banner tone="warn">{nl.data.preview.problem}</Banner> : null}
          <KeyValue
            items={[
              { label: t('settings.statsCollections.newsletter.subject'), value: nl.data.preview.subject, mono: false },
              { label: t('settings.statsCollections.newsletter.recipients'), value: String(nl.data.preview.recipients) },
              { label: t('settings.statsCollections.newsletter.items'), value: String(nl.data.preview.items.length) },
            ]}
          />
          <iframe className="stc-frame" title={t('settings.statsCollections.newsletter.htmlPreview')} sandbox="" srcDoc={nl.data.preview.html} />
          <Table
            caption={t('settings.statsCollections.newsletter.history')}
            columns={runColumns}
            rows={nl.data.runs}
            rowKey={(r) => r.id}
            density="dense"
            empty={<p className="al-caption">{t('settings.statsCollections.newsletter.noRuns')}</p>}
          />
        </div>
      )}
    </Pane>
  );
}

function Form({ data }: { data: Combined }) {
  const draft = useDraft(data);
  const saveStats = useSaveWatchStatsSettings();
  const saveCollections = useSaveCollectionsSettings();
  const notifications = useNotificationList();
  const servers = useMediaServers();
  const ids = { audience: useId(), connection: useId(), recipients: useId(), weekday: useId(), hour: useId(), leavingName: useId() };
  const v = draft.value;
  const setStats = <K extends keyof WatchStatsSettings>(k: K, patch: Partial<WatchStatsSettings[K]>) =>
    draft.set((d) => ({ ...d, stats: { ...d.stats, [k]: { ...d.stats[k], ...patch } } }));
  const setLeaving = (patch: Partial<CollectionsSettings['leavingSoon']>) =>
    draft.set((d) => ({ ...d, collections: { ...d.collections, leavingSoon: { ...d.collections.leavingSoon, ...patch } } }));
  const errors = statsCollectionsErrors(v);
  const emailConnections = (notifications.data ?? []).filter((n) => n.implementation === 'email');
  // Collections sync to Jellyfin and Emby only (watch history also covers Plex).
  const mediaServers = watchServers(servers.data ?? []).filter((s) => s.kind !== 'plex');
  const onSave = () => {
    if (JSON.stringify(v.stats) !== JSON.stringify(data.stats)) saveStats.mutate(v.stats);
    if (JSON.stringify(v.collections) !== JSON.stringify(data.collections)) saveCollections.mutate({ ...v.collections, leavingSoon: { ...v.collections.leavingSoon, name: v.collections.leavingSoon.name.trim() } });
  };
  const toggleServer = (id: string, on: boolean) =>
    draft.set((d) => ({ ...d, collections: { ...d.collections, serverIds: on ? [...d.collections.serverIds, id] : d.collections.serverIds.filter((s) => s !== id) } }));
  const nl = v.stats.newsletter;

  return (
    <SettingsPage
      title={t('nav.statsCollections')}
      description={t('settings.statsCollections.description')}
      save={{ count: draft.changes, onSave, onDiscard: draft.discard, saving: saveStats.isPending || saveCollections.isPending, disabled: errors.length > 0 }}
      after={<NewsletterPreviewPane />}
    >
      <SaveError error={saveStats.error ?? saveCollections.error} />
      <SettingsSection label={t('settings.statsCollections.jellyfin.section')}>
        <FormRow label={t('settings.statsCollections.jellyfin.myStats')} captionInline caption={t('settings.statsCollections.jellyfin.myStatsCaption')}>
          <Toggle aria-label={t('settings.statsCollections.jellyfin.myStats')} checked={v.stats.jellyfin.myStats} onChange={(e) => setStats('jellyfin', { myStats: e.currentTarget.checked })} />
        </FormRow>
        <FormRow label={t('settings.statsCollections.jellyfin.wrapped')} captionInline caption={t('settings.statsCollections.jellyfin.wrappedCaption')}>
          <Toggle aria-label={t('settings.statsCollections.jellyfin.wrapped')} checked={v.stats.jellyfin.wrapped} onChange={(e) => setStats('jellyfin', { wrapped: e.currentTarget.checked })} />
        </FormRow>
        <FormRow label={t('settings.statsCollections.jellyfin.serverStats')} htmlFor={ids.audience} caption={t('settings.statsCollections.jellyfin.serverStatsCaption')}>
          <Select id={ids.audience} value={v.stats.jellyfin.serverStats} onChange={(e) => setStats('jellyfin', { serverStats: e.currentTarget.value as StatsAudience })}>
            <option value="nobody">{t('settings.statsCollections.audience.nobody')}</option>
            <option value="admins">{t('settings.statsCollections.audience.admins')}</option>
            <option value="everyone">{t('settings.statsCollections.audience.everyone')}</option>
          </Select>
        </FormRow>
        <FormRow label={t('settings.statsCollections.jellyfin.showUserNames')} captionInline caption={t('settings.statsCollections.jellyfin.showUserNamesCaption')}>
          <Toggle aria-label={t('settings.statsCollections.jellyfin.showUserNames')} checked={v.stats.jellyfin.showUserNames} onChange={(e) => setStats('jellyfin', { showUserNames: e.currentTarget.checked })} />
        </FormRow>
      </SettingsSection>

      <SettingsSection label={t('settings.statsCollections.wrapped.section')}>
        <FormRow label={t('settings.statsCollections.wrapped.shareLinks')} captionInline caption={t('settings.statsCollections.wrapped.shareLinksCaption')}>
          <Toggle aria-label={t('settings.statsCollections.wrapped.shareLinks')} checked={v.stats.wrapped.shareLinks} onChange={(e) => setStats('wrapped', { shareLinks: e.currentTarget.checked })} />
        </FormRow>
        {v.stats.wrapped.shareLinks ? (
          <NumberRow label={t('settings.statsCollections.wrapped.shareLinkDays')} caption={t('settings.statsCollections.wrapped.shareLinkDaysCaption')} value={v.stats.wrapped.shareLinkDays} min={1} max={90} onChange={(n) => setStats('wrapped', { shareLinkDays: n })} />
        ) : null}
      </SettingsSection>

      <SettingsSection label={t('settings.statsCollections.newsletter.section')}>
        <FormRow label={t('settings.statsCollections.newsletter.enable')} captionInline caption={t('settings.statsCollections.newsletter.enableCaption')}>
          <Toggle aria-label={t('settings.statsCollections.newsletter.enable')} checked={nl.enabled} onChange={(e) => setStats('newsletter', { enabled: e.currentTarget.checked })} />
        </FormRow>
        <FormRow
          label={t('settings.statsCollections.newsletter.connection')}
          htmlFor={ids.connection}
          caption={emailConnections.length ? t('settings.statsCollections.newsletter.connectionCaption') : t('settings.statsCollections.newsletter.noConnections')}
          error={nl.enabled && nl.notificationId === null ? t('settings.statsCollections.errors.connection') : undefined}
        >
          <Select
            id={ids.connection}
            value={nl.notificationId === null ? '' : String(nl.notificationId)}
            onChange={(e) => setStats('newsletter', { notificationId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
          >
            <option value="">{t('settings.statsCollections.newsletter.pickConnection')}</option>
            {emailConnections.map((n) => (
              <option key={n.id} value={String(n.id)}>
                {n.name}
              </option>
            ))}
          </Select>
        </FormRow>
        <FormRow label={t('settings.statsCollections.newsletter.recipients')} htmlFor={ids.recipients}>
          <Select id={ids.recipients} value={nl.recipients} onChange={(e) => setStats('newsletter', { recipients: e.currentTarget.value as 'connection' | 'users' })}>
            <option value="connection">{t('settings.statsCollections.newsletter.toConnection')}</option>
            <option value="users">{t('settings.statsCollections.newsletter.toUsers')}</option>
          </Select>
        </FormRow>
        <FormRow label={t('settings.statsCollections.newsletter.schedule')} htmlFor={ids.weekday} caption={t('settings.statsCollections.newsletter.scheduleCaption')}>
          <div className="stc-inline">
            <Select id={ids.weekday} value={String(nl.weekday)} onChange={(e) => setStats('newsletter', { weekday: Number(e.currentTarget.value) })}>
              {Array.from({ length: 7 }, (_, d) => (
                <option key={d} value={String(d)}>
                  {weekdayName(d)}
                </option>
              ))}
            </Select>
            <Select aria-label={t('settings.statsCollections.newsletter.hour')} value={String(nl.hour)} onChange={(e) => setStats('newsletter', { hour: Number(e.currentTarget.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={String(h)}>
                  {hourLabel(h)}
                </option>
              ))}
            </Select>
          </div>
        </FormRow>
        <NumberRow label={t('settings.statsCollections.newsletter.maxItems')} caption={t('settings.statsCollections.newsletter.maxItemsCaption')} value={nl.maxItems} min={1} max={100} onChange={(n) => setStats('newsletter', { maxItems: n })} />
      </SettingsSection>

      <SettingsSection label={t('settings.statsCollections.collections.section')}>
        <FormRow label={t('settings.statsCollections.collections.leavingSoon')} captionInline caption={t('settings.statsCollections.collections.leavingSoonCaption')}>
          <Toggle aria-label={t('settings.statsCollections.collections.leavingSoon')} checked={v.collections.leavingSoon.enabled} onChange={(e) => setLeaving({ enabled: e.currentTarget.checked })} />
        </FormRow>
        <NumberRow label={t('settings.statsCollections.collections.days')} caption={t('settings.statsCollections.collections.daysCaption')} value={v.collections.leavingSoon.days} min={1} max={90} onChange={(n) => setLeaving({ days: n })} />
        <FormRow label={t('settings.statsCollections.collections.name')} htmlFor={ids.leavingName} error={v.collections.leavingSoon.name.trim() ? undefined : t('settings.statsCollections.errors.leavingName')}>
          <Input id={ids.leavingName} value={v.collections.leavingSoon.name} maxLength={100} invalid={!v.collections.leavingSoon.name.trim()} onChange={(e) => setLeaving({ name: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t('settings.statsCollections.collections.showInJellyfin')} captionInline caption={t('settings.statsCollections.collections.showInJellyfinCaption')}>
          <Toggle aria-label={t('settings.statsCollections.collections.showInJellyfin')} checked={v.collections.leavingSoon.showInJellyfin} onChange={(e) => setLeaving({ showInJellyfin: e.currentTarget.checked })} />
        </FormRow>
        <FormRow
          label={t('settings.statsCollections.collections.servers')}
          caption={mediaServers.length ? t('settings.statsCollections.collections.serversCaption') : t('settings.statsCollections.collections.noServers')}
        >
          <div className="stc-checklist" role="group" aria-label={t('settings.statsCollections.collections.servers')}>
            {mediaServers.map((s) => (
              <Checkbox key={s.id} label={s.name} checked={v.collections.serverIds.includes(s.id)} onChange={(e) => toggleServer(s.id, e.currentTarget.checked)} />
            ))}
          </div>
        </FormRow>
      </SettingsSection>
    </SettingsPage>
  );
}

export function StatsCollectionsSettingsPage() {
  const stats = useWatchStatsSettings(true);
  const collections = useCollectionsSettings();
  if (stats.isSuccess && collections.isSuccess) return <Form data={{ stats: stats.data, collections: collections.data }} />;
  const failed = stats.isError ? stats : collections.isError ? collections : null;
  return (
    <SettingsPage title={t('nav.statsCollections')}>
      {failed ? (
        <ErrorBlock title={t('settings.statsCollections.couldNotLoad')} onRetry={() => void failed.refetch()}>
          {errorMessage(failed.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={8} />
      )}
    </SettingsPage>
  );
}
