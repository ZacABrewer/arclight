import { useId } from 'react';
import { DEFAULT_COMMUNITY_CATALOGUE_URL, type CommunityCatalogueSettings, type CommunityCatalogueStatus, type CommunityCatalogueSyncResult } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, FormRow, FormSection, Input, KeyValue, Pane, Skeleton, Toggle, type KeyValueItem } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useCommunityCatalogueStatus, useRollbackCommunityCatalogue, useSaveCommunityCatalogueSettings, useSyncCommunityCatalogue } from '../../../hooks/indexers.js';
import { relativeTime } from '../../../lib/format.js';
import { formatStamp } from '../../system/format.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import '../indexers/indexers.css';
import { t } from '../../../i18n/index.js';

/** "3 added · 1 updated · 570 unchanged · 2 failed" (or "Listing unchanged"). */
export function communitySyncSummary(r: CommunityCatalogueSyncResult): string {
  if (r.notModified) return t('settings.indexerCatalogue.listingUnchanged', { total: r.total });
  return t('settings.indexerCatalogue.syncSummary', { added: r.added, updated: r.updated, removed: r.removed, unchanged: r.unchanged, failed: r.failed.length });
}

export function validateCommunitySettings(v: CommunityCatalogueSettings): Partial<Record<'url' | 'intervalHours', string>> {
  const errors: Partial<Record<'url' | 'intervalHours', string>> = {};
  try {
    const u = new URL(v.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.url = t('settings.indexerCatalogue.useAnHttpUrl');
  } catch {
    errors.url = t('settings.indexerCatalogue.enterAFullUrl');
  }
  if (!Number.isInteger(v.intervalHours) || v.intervalHours < 1 || v.intervalHours > 168) errors.intervalHours = t('settings.indexerCatalogue.use1To168Hours');
  return errors;
}

const when = (iso: string | null) => (iso ? relativeTime(iso) : t('settings.indexerCatalogue.never'));

function statusItems(s: CommunityCatalogueStatus): KeyValueItem[] {
  return [
    { key: 'last', label: t('common.lastSync'), value: <span title={s.lastSyncAt ? formatStamp(s.lastSyncAt) : undefined}>{when(s.lastSyncAt)}</span> },
    { key: 'ok', label: t('common.lastSuccess'), value: <span title={s.lastSuccessAt ? formatStamp(s.lastSuccessAt) : undefined}>{when(s.lastSuccessAt)}</span> },
    { key: 'files', label: t('settings.indexerCatalogue.definitionFiles'), value: String(s.files) },
    { key: 'supported', label: t('settings.indexerCatalogue.load'), value: String(s.supported) },
    { key: 'limited', label: t('settings.indexerCatalogue.limited'), value: String(s.limited) },
    { key: 'unsupported', label: t('settings.indexerCatalogue.notSupportedYet'), value: String(s.unsupported) },
    { key: 'overridden', label: t('settings.indexerCatalogue.overridden'), value: String(s.overridden) },
  ];
}

function SourcesForm({ saved }: { saved: CommunityCatalogueSettings }) {
  const draft = useDraft(saved);
  const save = useSaveCommunityCatalogueSettings();
  const v = draft.value;
  const errors = validateCommunitySettings(v);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof CommunityCatalogueSettings>(k: K, value: CommunityCatalogueSettings[K]) => draft.set((d) => ({ ...d, [k]: value }));
  const ids = { builtin: useId(), community: useId(), url: useId(), interval: useId() };
  return (
    <form
      aria-label={t('settings.indexerCatalogue.catalogueSources')}
      className="al-feed-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(v);
      }}
    >
      <FormSection label={t('settings.indexerCatalogue.sources')}>
        <FormRow label={t('settings.indexerCatalogue.arclightBuiltin')} htmlFor={ids.builtin} caption={t('settings.indexerCatalogue.arclightBuiltinCaption')} captionInline>
          <Toggle id={ids.builtin} checked disabled label={t('settings.indexerCatalogue.alwaysOn')} readOnly />
        </FormRow>
        <FormRow label={t('settings.indexerCatalogue.communityCatalogue')} htmlFor={ids.community} caption={t('settings.indexerCatalogue.communityCaption')}>
          <Toggle id={ids.community} checked={v.enabled} label={t('settings.indexerCatalogue.useCommunityDefinitions')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        </FormRow>
        <FormRow label={t('settings.indexerCatalogue.sourceUrl')} htmlFor={ids.url} caption={t('settings.indexerCatalogue.sourceUrlCaption')} error={errors.url}>
          <Input id={ids.url} mono spellCheck={false} invalid={errors.url ? true : undefined} value={v.url} onChange={(e) => set('url', e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('settings.indexerCatalogue.syncInterval')} htmlFor={ids.interval} caption={t('common.n1To168Hours')} error={errors.intervalHours}>
          <Input
            id={ids.interval}
            type="number"
            mono
            min={1}
            max={168}
            end="h"
            className="al-input--num"
            invalid={errors.intervalHours ? true : undefined}
            value={Number.isFinite(v.intervalHours) ? String(v.intervalHours) : ''}
            onChange={(e) => set('intervalHours', Number(e.currentTarget.value))}
          />
        </FormRow>
      </FormSection>
      <div className="al-catalogue-settings__actions">
        {v.url !== DEFAULT_COMMUNITY_CATALOGUE_URL ? (
          <Button variant="ghost" onClick={() => set('url', DEFAULT_COMMUNITY_CATALOGUE_URL)}>
            {t('settings.indexerCatalogue.useDefaultUrl')}
          </Button>
        ) : null}
        {draft.dirty ? (
          <>
            <Button variant="ghost" onClick={draft.discard} disabled={save.isPending}>
              {t('common.discard')}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
              {t('settings.indexerCatalogue.saveCatalogueSettings')}
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}

/** Settings → Indexer catalogue: which sources fill the add-indexer chooser, and the community sync. */
export function IndexerCataloguePage() {
  const status = useCommunityCatalogueStatus();
  const sync = useSyncCommunityCatalogue();
  const rollback = useRollbackCommunityCatalogue();
  const toast = useToast();
  const s = status.data;
  return (
    <SettingsPage title={t('settings.indexerCatalogue.title')} description={t('settings.indexerCatalogue.description')}>
      {status.isPending ? (
        <Skeleton lines={6} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.indexerCatalogue.couldntLoad')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : s ? (
        <div className="al-catalogue-settings">
          <SourcesForm saved={s.settings} />
          <Pane
            title={t('settings.indexerCatalogue.communityCatalogue')}
            aria-label={t('settings.indexerCatalogue.communityStatus')}
            actions={
              <div className="al-catalogue-settings__actions">
                {s.previousAvailable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={rollback.isPending}
                    onClick={() => rollback.mutate(undefined, { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.indexerCatalogue.rolledBack') }) })}
                  >
                    {t('settings.indexerCatalogue.rollBack')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!s.settings.enabled}
                  loading={sync.isPending}
                  onClick={() =>
                    sync.mutate(undefined, {
                      onSuccess: (r) => toast.push({ tone: r.failed.length ? 'warning' : 'ok', title: t('settings.indexerCatalogue.synced'), message: communitySyncSummary(r) }),
                    })
                  }
                >
                  {t('common.syncNow')}
                </Button>
              </div>
            }
          >
            <div className="al-catalogue-settings">
              {!s.settings.enabled ? <p>{t('settings.indexerCatalogue.turnedOffNote')}</p> : null}
              {s.lastError ? (
                <p className="al-catalogue-settings__error" role="alert">
                  {t('settings.indexerCatalogue.lastSyncFailed', { error: s.lastError })}
                </p>
              ) : null}
              {s.stale ? <p className="al-catalogue-settings__error">{t('settings.indexerCatalogue.staleNote')}</p> : null}
              <KeyValue layout="grid" columns={4} items={statusItems(s)} />
              {s.sourceUrl ? (
                <p className="al-catalogue__hint">
                  {t('settings.indexerCatalogue.filesFrom')} <span className="al-num">{s.sourceUrl}</span>
                </p>
              ) : null}
              {s.topReasons.length ? (
                <section aria-label={t('settings.indexerCatalogue.whyNotEverything')}>
                  <div className="al-label">{t('settings.indexerCatalogue.whyNotEverything')}</div>
                  <ul className="al-catalogue-settings__reasons">
                    {s.topReasons.map((r) => (
                      <li key={r.reason}>
                        <span className="al-num">{r.count}</span>
                        {r.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </Pane>
        </div>
      ) : null}
    </SettingsPage>
  );
}
