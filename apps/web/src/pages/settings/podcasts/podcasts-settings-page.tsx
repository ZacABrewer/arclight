import { useId } from 'react';
import { PodcastSettings, type IndexerProxy, type PodcastSubscriptionSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { PathInput } from '../../../components/path-picker/path-input.js';
import { useIndexerProxies } from '../../../hooks/indexers.js';
import { usePodcastSettings, useSavePodcastSettings } from '../../../hooks/podcasts.js';
import { PodcastGate, SubscriptionSettingsFields } from '../../podcasts/podcast-kit.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { t } from '../../../i18n/index.js';

// Settings → Podcasts: GET/PUT /settings/podcasts (contract PodcastSettings). The folder and
// episode formats, how often feeds are polled, the defaults new subscriptions copy, the proxy
// feeds go through, and the directory (Podcast Index / iTunes) used by Add podcast.

/** Tokens the folder and episode formats understand (shown under the inputs). */
export const PODCAST_FORMAT_TOKENS = [
  '{Podcast Title}',
  '{Podcast Author}',
  '{Episode Title}',
  '{Episode Date}',
  '{Episode Year}',
  '{Episode Month}',
  '{Episode Day}',
  '{Season}',
  '{Episode Number}',
] as const;

export interface PodcastSettingsDraft {
  rootFolder: string;
  folderFormat: string;
  episodeFormat: string;
  refreshIntervalMinutes: string;
  respectTtl: boolean;
  maxConcurrentDownloads: string;
  defaults: PodcastSubscriptionSettings;
  /** '' = direct. */
  proxyId: string;
  podcastIndexKey: string;
  /** The mask while a stored secret is untouched. */
  podcastIndexSecret: string;
  itunesCountry: string;
}

export function toPodcastSettingsDraft(s: PodcastSettings): PodcastSettingsDraft {
  return {
    rootFolder: s.rootFolder,
    folderFormat: s.folderFormat,
    episodeFormat: s.episodeFormat,
    refreshIntervalMinutes: String(s.refreshIntervalMinutes),
    respectTtl: s.respectTtl,
    maxConcurrentDownloads: String(s.maxConcurrentDownloads),
    defaults: { ...s.defaults },
    proxyId: s.proxyId === null ? '' : String(s.proxyId),
    podcastIndexKey: s.podcastIndexKey ?? '',
    podcastIndexSecret: s.podcastIndexSecret ?? '',
    itunesCountry: s.itunesCountry,
  };
}

const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

function fieldLabel(key: string): string {
  switch (key) {
    case 'folderFormat':
      return t('podcasts.settings.folderFormat');
    case 'episodeFormat':
      return t('podcasts.settings.episodeFormat');
    case 'refreshIntervalMinutes':
      return t('podcasts.settings.refreshInterval');
    case 'maxConcurrentDownloads':
      return t('podcasts.settings.maxDownloads');
    case 'itunesCountry':
      return t('podcasts.settings.itunesCountry');
    default:
      return key;
  }
}

/** Draft → PUT body (the secret stays the mask when untouched), or the first problem as a sentence. */
export function toPodcastSettingsBody(d: PodcastSettingsDraft): { ok: true; body: PodcastSettings } | { ok: false; error: string; field: string } {
  const parsed = PodcastSettings.safeParse({
    rootFolder: d.rootFolder,
    folderFormat: d.folderFormat,
    episodeFormat: d.episodeFormat,
    refreshIntervalMinutes: num(d.refreshIntervalMinutes),
    respectTtl: d.respectTtl,
    maxConcurrentDownloads: num(d.maxConcurrentDownloads),
    defaults: d.defaults,
    proxyId: d.proxyId === '' ? null : Number(d.proxyId),
    podcastIndexKey: d.podcastIndexKey.trim() || null,
    podcastIndexSecret: d.podcastIndexSecret.trim() || null,
    itunesCountry: d.itunesCountry,
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  return { ok: false, field, error: t('podcasts.settings.checkField', { field: fieldLabel(field) }) };
}

/** Feeds can go through http and socks5 proxies (FlareSolverr only answers indexer pages). */
export function feedProxies(proxies: readonly IndexerProxy[] | undefined) {
  return (proxies ?? []).filter((p) => p.type === 'http' || p.type === 'socks5');
}

function TokenList() {
  return (
    <span className="pod-tokens">
      {PODCAST_FORMAT_TOKENS.map((tok) => (
        <code key={tok}>{tok}</code>
      ))}
    </span>
  );
}

function PodcastSettingsForm({ data }: { data: PodcastSettings }) {
  const draft = useDraft(toPodcastSettingsDraft(data));
  const d = draft.value;
  const save = useSavePodcastSettings();
  const proxies = useIndexerProxies();
  const set = <K extends keyof PodcastSettingsDraft>(key: K, value: PodcastSettingsDraft[K]) => draft.set((prev) => ({ ...prev, [key]: value }));
  const result = toPodcastSettingsBody(d);
  const invalid = result.ok ? null : result.field;
  const ids = {
    root: useId(),
    folder: useId(),
    episode: useId(),
    interval: useId(),
    ttl: useId(),
    max: useId(),
    proxy: useId(),
    key: useId(),
    secret: useId(),
    country: useId(),
  };

  return (
    <SettingsPage
      title={t('common.podcasts')}
      description={t('podcasts.settings.description')}
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
      <form aria-label={t('podcasts.settings.formLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 30 }} onSubmit={(e) => e.preventDefault()}>
        <FormSection label={t('podcasts.settings.files')}>
          <FormRow label={t('podcasts.settings.rootFolder')} htmlFor={ids.root} caption={t('podcasts.settings.rootFolderCaption')}>
            <PathInput id={ids.root} aria-label={t('podcasts.settings.rootFolder')} value={d.rootFolder} onChange={(v) => set('rootFolder', v)} />
          </FormRow>
          <FormRow label={t('podcasts.settings.folderFormat')} htmlFor={ids.folder} caption={<TokenList />}>
            <Input id={ids.folder} mono spellCheck={false} invalid={invalid === 'folderFormat'} value={d.folderFormat} onChange={(e) => set('folderFormat', e.currentTarget.value)} />
          </FormRow>
          <FormRow label={t('podcasts.settings.episodeFormat')} htmlFor={ids.episode} caption={t('podcasts.settings.episodeFormatCaption')}>
            <Input id={ids.episode} mono spellCheck={false} invalid={invalid === 'episodeFormat'} value={d.episodeFormat} onChange={(e) => set('episodeFormat', e.currentTarget.value)} />
          </FormRow>
        </FormSection>

        <FormSection label={t('podcasts.settings.polling')}>
          <FormRow label={t('podcasts.settings.refreshInterval')} htmlFor={ids.interval} caption={t('podcasts.settings.refreshIntervalCaption')}>
            <Input
              id={ids.interval}
              type="number"
              mono
              className="al-input--num"
              end={t('podcasts.settings.minutes')}
              min={15}
              max={10080}
              invalid={invalid === 'refreshIntervalMinutes'}
              value={d.refreshIntervalMinutes}
              onChange={(e) => set('refreshIntervalMinutes', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('podcasts.settings.respectTtl')} caption={t('podcasts.settings.respectTtlCaption')} captionInline>
            <Toggle id={ids.ttl} aria-label={t('podcasts.settings.respectTtl')} checked={d.respectTtl} onChange={(e) => set('respectTtl', e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('podcasts.settings.maxDownloads')} htmlFor={ids.max} caption={t('podcasts.settings.maxDownloadsCaption')}>
            <Input
              id={ids.max}
              type="number"
              mono
              className="al-input--num"
              min={1}
              max={5}
              invalid={invalid === 'maxConcurrentDownloads'}
              value={d.maxConcurrentDownloads}
              onChange={(e) => set('maxConcurrentDownloads', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('podcasts.settings.proxy')} htmlFor={ids.proxy} caption={t('podcasts.settings.proxyCaption')}>
            <Select
              id={ids.proxy}
              value={d.proxyId}
              onChange={(e) => set('proxyId', e.currentTarget.value)}
              options={[{ value: '', label: t('podcasts.settings.noProxy') }, ...feedProxies(proxies.data).map((p) => ({ value: String(p.id), label: `${p.name} (${p.type})` }))]}
            />
          </FormRow>
        </FormSection>

        <FormSection label={t('podcasts.settings.defaults')}>
          <p className="al-caption">{t('podcasts.settings.defaultsCaption')}</p>
          <SubscriptionSettingsFields value={d.defaults} onChange={(v) => set('defaults', v)} />
        </FormSection>

        <FormSection label={t('podcasts.settings.directory')}>
          <FormRow label={t('podcasts.settings.podcastIndexKey')} htmlFor={ids.key} caption={t('podcasts.settings.podcastIndexCaption')}>
            <Input id={ids.key} mono spellCheck={false} autoComplete="off" value={d.podcastIndexKey} onChange={(e) => set('podcastIndexKey', e.currentTarget.value)} />
          </FormRow>
          <FormRow label={t('podcasts.settings.podcastIndexSecret')} htmlFor={ids.secret}>
            <Input id={ids.secret} type="password" mono autoComplete="new-password" value={d.podcastIndexSecret} onChange={(e) => set('podcastIndexSecret', e.currentTarget.value)} />
          </FormRow>
          <FormRow label={t('podcasts.settings.itunesCountry')} htmlFor={ids.country} caption={t('podcasts.settings.itunesCountryCaption')}>
            <Input
              id={ids.country}
              mono
              maxLength={2}
              spellCheck={false}
              className="al-input--num"
              invalid={invalid === 'itunesCountry'}
              value={d.itunesCountry}
              onChange={(e) => set('itunesCountry', e.currentTarget.value.toLowerCase())}
            />
          </FormRow>
        </FormSection>
      </form>
    </SettingsPage>
  );
}

export function PodcastSettingsPage() {
  return (
    <PodcastGate>
      <PodcastSettingsLoader />
    </PodcastGate>
  );
}

function PodcastSettingsLoader() {
  const settings = usePodcastSettings();
  if (!settings.data) {
    return (
      <SettingsPage title={t('common.podcasts')}>
        {settings.isError ? (
          <ErrorBlock title={t('podcasts.settings.couldNotLoad')} onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        ) : (
          <Skeleton lines={8} />
        )}
      </SettingsPage>
    );
  }
  return <PodcastSettingsForm data={settings.data} />;
}
