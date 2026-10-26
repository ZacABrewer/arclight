import { useId } from 'react';
import type { DefinitionFeedInstalled, DefinitionFeedSettings, DefinitionFeedStatus, DefinitionFeedSyncResult } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, EmptyState, ErrorBlock, FormRow, FormSection, Input, KeyValue, Pane, Segmented, Skeleton, Table, Toggle, type Column, type KeyValueItem } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useDefinitionFeedStatus, useRollbackDefinition, useSaveDefinitionFeedSettings, useSyncDefinitionFeed } from '../../../hooks/indexers.js';
import { relativeTime } from '../../../lib/format.js';
import { formatStamp } from '../../system/format.js';
import { useDraft } from '../settings-layout.js';
import './definition-feed.css';
import { t } from '../../../i18n/index.js';

/** "2 added · 1 updated · 40 unchanged" (or "Index unchanged"). */
export function feedSyncSummary(r: DefinitionFeedSyncResult): string {
  if (r.notModified) return t('settings.indexerOptions.definitionFeedPanel.indexUnchanged');
  const parts = [
    r.added.length ? `${r.added.length} added` : '',
    r.updated.length ? `${r.updated.length} updated` : '',
    r.removed.length ? `${r.removed.length} removed` : '',
    `${r.unchanged} unchanged`,
    r.rejected.length ? `${r.rejected.length} rejected` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

export function validateFeedSettings(v: DefinitionFeedSettings): Partial<Record<'url' | 'intervalHours', string>> {
  const errors: Partial<Record<'url' | 'intervalHours', string>> = {};
  try {
    const u = new URL(v.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.url = t('settings.indexerOptions.definitionFeedPanel.useAnHttpSUrl');
  } catch {
    errors.url = t('settings.indexerOptions.definitionFeedPanel.enterAFullUrl');
  }
  if (!Number.isInteger(v.intervalHours) || v.intervalHours < 1 || v.intervalHours > 168) errors.intervalHours = t('settings.indexerOptions.definitionFeedPanel.use1To168Hours');
  return errors;
}

function when(iso: string | null): string {
  return iso ? relativeTime(iso) : 'never';
}

function feedStatusItems(s: DefinitionFeedStatus): KeyValueItem[] {
  return [
    { key: 'last', label: t('common.lastSync'), value: <span title={s.lastSyncAt ? formatStamp(s.lastSyncAt) : undefined}>{when(s.lastSyncAt)}</span> },
    { key: 'ok', label: t('common.lastSuccess'), value: <span title={s.lastSuccessAt ? formatStamp(s.lastSuccessAt) : undefined}>{when(s.lastSuccessAt)}</span> },
    { key: 'schema', label: t('settings.indexerOptions.definitionFeedPanel.indexSchema'), value: s.schemaVersion === null ? '—' : `v${s.schemaVersion}` },
    { key: 'installed', label: t('settings.indexerOptions.definitionFeedPanel.installed'), value: String(s.installed.length) },
  ];
}

function FeedSettingsForm({ saved }: { saved: DefinitionFeedSettings }) {
  const draft = useDraft(saved);
  const save = useSaveDefinitionFeedSettings();
  const v = draft.value;
  const errors = validateFeedSettings(v);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof DefinitionFeedSettings>(k: K, value: DefinitionFeedSettings[K]) => draft.set((d) => ({ ...d, [k]: value }));
  const ids = { enabled: useId(), url: useId(), interval: useId() };
  return (
    <form
      aria-label={t('settings.indexerOptions.definitionFeedPanel.definitionFeedSettings')}
      className="al-feed-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(v);
      }}
    >
      <FormSection label={t('common.feed')}>
        <FormRow label={t('settings.indexerOptions.definitionFeedPanel.definitionFeed')} htmlFor={ids.enabled} captionInline>
          <Toggle id={ids.enabled} checked={v.enabled} label={t('settings.indexerOptions.definitionFeedPanel.downloadDefinitionUpdates')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        </FormRow>
        <FormRow label={t('settings.indexerOptions.definitionFeedPanel.feedUrl')} htmlFor={ids.url} caption={t('settings.indexerOptions.definitionFeedPanel.baseUrlServingIndexJson')} error={errors.url}>
          <Input id={ids.url} mono spellCheck={false} invalid={errors.url ? true : undefined} value={v.url} onChange={(e) => set('url', e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('settings.indexerOptions.definitionFeedPanel.syncInterval')} htmlFor={ids.interval} caption={t('common.n1To168Hours')} error={errors.intervalHours}>
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
        <FormRow label={t('common.mode')} caption={v.mode === 'auto' ? t('settings.indexerOptions.definitionFeedPanel.syncOnTheIntervalAnd') : t('settings.indexerOptions.definitionFeedPanel.onlySyncWhenYouPress')}>
          <Segmented
            aria-label={t('settings.indexerOptions.definitionFeedPanel.feedMode')}
            value={v.mode}
            onChange={(m) => set('mode', m)}
            options={[
              { value: 'auto', label: t('settings.indexerOptions.definitionFeedPanel.automatic') },
              { value: 'manual', label: t('settings.indexerOptions.definitionFeedPanel.manual') },
            ]}
          />
        </FormRow>
      </FormSection>
      {draft.dirty ? (
        <div className="al-feed-form__save">
          <Button variant="ghost" onClick={draft.discard} disabled={save.isPending}>
            {t('common.discard')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
            {t('settings.indexerOptions.definitionFeedPanel.saveFeedSettings')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function InstalledTable({ rows }: { rows: readonly DefinitionFeedInstalled[] }) {
  const rollback = useRollbackDefinition();
  const toast = useToast();
  const columns: Column<DefinitionFeedInstalled>[] = [
    { key: 'id', header: t('settings.indexerOptions.definitionFeedPanel.definition'), mono: true, cell: (r) => r.id, sortValue: (r) => r.id },
    { key: 'version', header: t('common.version'), mono: true, cell: (r) => r.version },
    { key: 'installed', header: t('settings.indexerOptions.definitionFeedPanel.installed'), mono: true, muted: true, cell: (r) => <span title={formatStamp(r.installedAt)}>{relativeTime(r.installedAt)}</span>, sortValue: (r) => r.installedAt },
    {
      key: 'state',
      header: t('common.state'),
      cell: (r) =>
        r.active ? (
          <Chip tone="accent">{t('settings.indexerOptions.definitionFeedPanel.active')}</Chip>
        ) : (
          <Chip tone="muted" title={t('settings.indexerOptions.definitionFeedPanel.aCustomDefinitionWithThe')}>
            {t('settings.indexerOptions.definitionFeedPanel.overridden')}
          </Chip>
        ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) =>
        r.previousVersion ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('settings.indexerOptions.definitionFeedPanel.rollBackIdToPreviousversion', { id: r.id, previousVersion: r.previousVersion })}
            loading={rollback.isPending && rollback.variables === r.id}
            disabled={rollback.isPending}
            onClick={() => rollback.mutate(r.id, { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.indexerOptions.definitionFeedPanel.idRolledBackToPreviousversion', { id: r.id, previousVersion: r.previousVersion }) }) })}
          >
            {t('settings.indexerOptions.definitionFeedPanel.rollBackToPreviousversion', { previousVersion: r.previousVersion })}
          </Button>
        ) : null,
    },
  ];
  return (
    <Table
      caption={t('settings.indexerOptions.definitionFeedPanel.installedFeedDefinitions')}
      density="dense"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      defaultSort={{ key: 'id', direction: 'asc' }}
      empty={<EmptyState title={t('settings.indexerOptions.definitionFeedPanel.nothingInstalledFromTheFeed')}>{t('settings.indexerOptions.definitionFeedPanel.theBundledDefinitionsAreIn')}</EmptyState>}
    />
  );
}

/** Settings → Indexer options: the definition feed (settings, status, rollback list). */
export function DefinitionFeedPanel() {
  const status = useDefinitionFeedStatus();
  const sync = useSyncDefinitionFeed();
  const toast = useToast();
  return (
    <Pane
      title={t('settings.indexerOptions.definitionFeedPanel.definitionFeed')}
      aria-label={t('settings.indexerOptions.definitionFeedPanel.definitionFeed')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={sync.isPending}
          onClick={() => sync.mutate(undefined, { onSuccess: (r) => toast.push({ tone: r.rejected.length ? 'warning' : 'ok', title: t('settings.indexerOptions.definitionFeedPanel.definitionFeedSynced'), message: feedSyncSummary(r) }) })}
        >
          {t('common.syncNow')}
        </Button>
      }
    >
      {status.isPending ? (
        <Skeleton lines={5} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.indexerOptions.definitionFeedPanel.couldntReadTheDefinitionFeed')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <div className="al-feed">
          {status.data.lastError ? (
            <p className="al-feed__error" role="alert">
              {t('settings.indexerOptions.definitionFeedPanel.lastSyncFailedLasterror', { lastError: status.data.lastError })}
            </p>
          ) : null}
          <KeyValue layout="grid" columns={4} items={feedStatusItems(status.data)} />
          <FeedSettingsForm saved={status.data.settings} />
          <section className="al-feed__section" aria-label={t('settings.indexerOptions.definitionFeedPanel.installedFromTheFeed')}>
            <div className="al-label">{t('settings.indexerOptions.definitionFeedPanel.installedInstalledcount', { installedCount: status.data.installed.length })}</div>
            <InstalledTable rows={status.data.installed} />
          </section>
          {status.data.rejected.length ? (
            <section className="al-feed__section" aria-label={t('settings.indexerOptions.definitionFeedPanel.rejected')}>
              <div className="al-label" data-tone="warn">
                {t('settings.indexerOptions.definitionFeedPanel.rejectedRejectedcount', { rejectedCount: status.data.rejected.length })}
              </div>
              <ul className="al-feed__rejected">
                {status.data.rejected.map((r) => (
                  <li key={`${r.id}:${r.version ?? ''}`}>
                    <span className="al-num">
                      {r.id}
                      {r.version ? ` ${r.version}` : ''}
                    </span>{t('settings.indexerOptions.definitionFeedPanel.reasonTheInstalledVersionStays', { reason: r.reason })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Pane>
  );
}
