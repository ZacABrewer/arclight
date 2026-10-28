import { useEffect, useState } from 'react';
import type { ThemeSettings } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useSaveThemeSettings, useSyncThemes, useThemeStatus } from '../../../features/themes/use-themes.js';
import { formatDateTime } from '../../../lib/ui-preferences.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

const INTERVALS = [6, 12, 24, 48, 168] as const;

const same = (a: ThemeSettings, b: ThemeSettings) =>
  a.defaultTheme === b.defaultTheme &&
  a.allowUserChoice === b.allowUserChoice &&
  a.syncEnabled === b.syncEnabled &&
  a.syncIntervalHours === b.syncIntervalHours &&
  a.sourceUrl === b.sourceUrl;

/**
 * Server-wide theme settings (admins): the default theme for everyone, whether users may pick
 * their own, and the theme pack sync from the repository. Its own Save, like the UI section.
 */
export function ThemesSection() {
  const status = useThemeStatus();
  const save = useSaveThemeSettings();
  const sync = useSyncThemes();
  const toast = useToast();
  const saved = status.data?.settings;
  const [draft, setDraft] = useState<ThemeSettings | null>(saved ?? null);
  useEffect(() => setDraft(saved ?? null), [saved]);
  const dirty = !!draft && !!saved && !same(draft, saved);
  const set = (patch: Partial<ThemeSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const onSave = () =>
    draft &&
    save.mutate(draft, {
      onSuccess: () => toast.push({ tone: 'ok', title: t('settings.general.themes.saved') }),
    });

  const onSync = () =>
    sync.mutate(undefined, {
      onSuccess: (r) => {
        if (!r.ok) toast.push({ tone: 'error', title: t('features.themes.couldNotSync'), message: r.error ?? undefined });
        else if (r.changed.length > 0) toast.push({ tone: 'ok', title: t('settings.general.themes.installed', { names: r.changed.join(', ') }) });
        else toast.push({ tone: 'ok', title: t('settings.general.themes.upToDate') });
        for (const s of r.skipped) toast.push({ tone: 'warning', title: t('settings.general.themes.skipped', { id: s.id }), message: s.reason });
      },
    });

  const sync_ = status.data?.sync;
  const lastSync = sync_?.lastSyncAt
    ? sync_.lastError
      ? t('settings.general.themes.lastSyncFailed', { when: formatDateTime(sync_.lastSyncAt), error: sync_.lastError })
      : t('settings.general.themes.lastSync', { when: formatDateTime(sync_.lastSyncAt) })
    : t('settings.general.themes.neverSynced');

  return (
    <SettingsSection
      label={t('settings.general.themes.label')}
      action={
        draft ? (
          <div className="mk-row">
            {dirty ? (
              <Button size="sm" variant="ghost" onClick={() => setDraft(saved ?? null)}>
                {t('common.discard')}
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={onSave}>
              {t('settings.general.themes.save')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.general.themes.couldNotLoad')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : draft && status.data ? (
        <>
          <FormRow label={t('settings.general.themes.defaultTheme')} htmlFor="themes-default" caption={t('settings.general.themes.defaultThemeCaption')}>
            <Select
              id="themes-default"
              value={draft.defaultTheme}
              options={status.data.themes.map((th) => ({ value: th.id, label: th.name }))}
              onChange={(e) => set({ defaultTheme: e.currentTarget.value })}
            />
          </FormRow>
          <FormRow label={t('settings.general.themes.allowUserChoice')} caption={t('settings.general.themes.allowUserChoiceCaption')}>
            <Toggle aria-label={t('settings.general.themes.allowUserChoice')} checked={draft.allowUserChoice} onChange={(e) => set({ allowUserChoice: e.currentTarget.checked })} />
          </FormRow>
          <FormRow label={t('settings.general.themes.syncEnabled')} caption={t('settings.general.themes.syncEnabledCaption')}>
            <Toggle aria-label={t('settings.general.themes.syncEnabled')} checked={draft.syncEnabled} onChange={(e) => set({ syncEnabled: e.currentTarget.checked })} />
          </FormRow>
          <FormRow label={t('settings.general.themes.syncInterval')} htmlFor="themes-interval">
            <Select
              id="themes-interval"
              value={String(draft.syncIntervalHours)}
              disabled={!draft.syncEnabled}
              options={INTERVALS.map((h) => ({ value: String(h), label: t('settings.general.themes.everyHours', { count: h }) }))}
              onChange={(e) => set({ syncIntervalHours: Number(e.currentTarget.value) })}
            />
          </FormRow>
          <FormRow label={t('settings.general.themes.sourceUrl')} htmlFor="themes-source" caption={t('settings.general.themes.sourceUrlCaption')}>
            <Input id="themes-source" mono value={draft.sourceUrl} onChange={(e) => set({ sourceUrl: e.currentTarget.value })} />
          </FormRow>
          <FormRow label={t('settings.general.themes.installedPacks')} caption={lastSync}>
            <div className="mk-row">
              <span className="al-body">{status.data.themes.map((th) => `${th.name} ${th.version}`).join(' · ')}</span>
              <Button size="sm" variant="secondary" loading={sync.isPending} onClick={onSync}>
                {t('settings.general.themes.syncNow')}
              </Button>
            </div>
          </FormRow>
        </>
      ) : null}
    </SettingsSection>
  );
}
