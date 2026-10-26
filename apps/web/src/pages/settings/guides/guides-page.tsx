import { useEffect, useId, useMemo, useState } from 'react';
import { GuideApp, TRASH_GUIDES_REPO_URL, type GuideProfileInfo, type GuidesDiff, type GuidesSettings, type GuidesStatus, type QualityProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBlock,
  FormRow,
  Input,
  KeyValue,
  Pane,
  Segmented,
  Select,
  Skeleton,
  Table,
  Toggle,
  type Column,
  type KeyValueItem,
} from '../../../arclight/index.js';
import { TermList } from '../../../components/forms/term-list.js';
import { useToast } from '../../../components/toast.js';
import { useApplyGuides, useGuideProfiles, useGuidesDiff, useGuidesSettings, useGuidesStatus, useSaveGuidesSettings, useSyncGuides } from '../../../hooks/guides.js';
import { useQualityProfileList } from '../../../hooks/profiles.js';
import { relativeTime } from '../../../lib/format.js';
import { formatStamp } from '../../system/format.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { APP_LABELS, applyAllIds, diffItemDetail, diffItemTitle, groupDiff, KIND_LABELS, KIND_TONES, mappingFor, repoLabel, setMapping, validateGuides } from './guides-model.js';
import './guides.css';
import { t } from '../../../i18n/index.js';

function When({ iso, empty = 'never' }: { iso: string | null; empty?: string }) {
  if (!iso) return <span className="al-muted">{empty}</span>;
  return (
    <time dateTime={iso} title={formatStamp(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

export function guidesStatusItems(s: GuidesStatus): KeyValueItem[] {
  return [
    { key: 'repo', label: t('settings.guides.repository'), value: repoLabel(s.source, s.repoUrl, s.branch) },
    { key: 'mode', label: t('common.mode'), value: s.mode === 'apply' ? t('settings.guides.applyAutomatically') : t('settings.guides.notifyOnly'), mono: false },
    { key: 'every', label: t('common.interval'), value: `${s.syncIntervalHours} h` },
    { key: 'last', label: t('common.lastSync'), value: <When iso={s.lastSyncAt} /> },
    { key: 'ok', label: t('common.lastSuccess'), value: <When iso={s.lastSuccessAt} /> },
    { key: 'applied', label: t('settings.guides.lastApplied'), value: <When iso={s.lastAppliedAt} /> },
    { key: 'pending', label: t('settings.guides.pendingChanges'), value: String(s.pendingCount) },
    { key: 'synced', label: t('settings.guides.syncedFormats'), value: String(s.syncedFormats) },
    ...(s.lastFetch ? [{ key: 'fetch', label: t('settings.guides.lastFetch'), value: `${s.lastFetch.files} files · ${s.lastFetch.cached} cached · ${s.lastFetch.requests} requests` }] : []),
  ];
}

function StatusPane() {
  const status = useGuidesStatus();
  const sync = useSyncGuides();
  const toast = useToast();
  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: (r) =>
        toast.push({
          tone: 'ok',
          title: r.changes === 0 ? t('settings.guides.guidesAreUpToDate') : t('settings.guides.changesFound', { changes: r.changes }),
          ...(r.applied ? { message: t('settings.guides.appliedcountAppliedPendingcountPending', { appliedCount: r.applied.applied.length, pendingCount: r.pendingCount }) } : {}),
        }),
    });
  return (
    <Pane
      chamfer="tl"
      title={t('common.status')}
      aria-label={t('settings.guides.guideStatus')}
      actions={
        <Button size="sm" variant="secondary" loading={sync.isPending} onClick={runSync}>
          {t('common.syncNow')}
        </Button>
      }
    >
      {status.isPending ? (
        <Skeleton lines={4} />
      ) : status.isError ? (
        <ErrorBlock title={t('settings.guides.couldntReadTheGuideStatus')} onRetry={() => void status.refetch()}>
          {errorMessage(status.error)}
        </ErrorBlock>
      ) : (
        <div className="al-guides-status">
          {!status.data.enabled ? <p className="al-caption">{t('settings.guides.guideSyncIsOffSync')}</p> : null}
          {status.data.lastError ? (
            <p className="al-guides-status__error" role="alert">
              {t('settings.guides.lastSyncFailedLasterror', { lastError: status.data.lastError })}
            </p>
          ) : null}
          <KeyValue items={guidesStatusItems(status.data)} />
        </div>
      )}
    </Pane>
  );
}

/** Pending guide changes with per-item checkboxes, Apply selected / Apply all. */
export function DiffView({ diff }: { diff: GuidesDiff }) {
  const apply = useApplyGuides();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [diff.revision]);
  const groups = useMemo(() => groupDiff(diff.items), [diff.items]);
  const allIds = applyAllIds(diff.items);
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const run = (ids: string[] | undefined) =>
    apply.mutate(ids, {
      onSuccess: (r) => {
        setSelected(new Set());
        toast.push({
          tone: r.skipped.length ? 'warning' : 'ok',
          title: t('settings.guides.appliedChanges', { appliedCount: r.applied.length }),
          message: [r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.map((s) => s.reason).join('; ')}` : '', `${r.pendingCount} pending`].filter(Boolean).join(' · '),
        });
      },
    });

  return (
    <Pane
      title={t('settings.guides.pendingChanges')}
      aria-label={t('settings.guides.pendingChanges')}
      actions={
        diff.items.length ? (
          <div className="al-guides-diff__actions">
            <Button size="sm" variant="secondary" disabled={selected.size === 0 || apply.isPending} loading={apply.isPending && apply.variables !== undefined} onClick={() => run([...selected])}>
              {t('settings.guides.applySelectedValue', { value: selected.size ? ` (${selected.size})` : '' })}
            </Button>
            <Button size="sm" variant="primary" disabled={allIds.length === 0 || apply.isPending} loading={apply.isPending && apply.variables === undefined} onClick={() => run(undefined)}>
              {t('settings.guides.applyAll')}
            </Button>
          </div>
        ) : null
      }
    >
      {diff.items.length === 0 ? (
        <EmptyState title={t('settings.guides.noPendingChanges')}>{t('settings.guides.customFormatsAndScoresMatch')}</EmptyState>
      ) : (
        <div className="al-guides-diff">
          <p className="al-caption">
            {t('settings.guides.generated')} <When iso={diff.generatedAt} />{t('settings.guides.applyAllSkipsFormatsYou')}
          </p>
          {groups.map((g) => (
            <section key={g.kind} className="al-guides-diff__group" aria-label={KIND_LABELS[g.kind]}>
              <div className="al-label">
                {KIND_LABELS[g.kind]} · {g.items.length}
              </div>
              <ul className="al-guides-diff__list">
                {g.items.map((item) => (
                  <li key={item.id} className="al-guides-diff__row">
                    <Checkbox label={diffItemTitle(item)} checked={selected.has(item.id)} onChange={(e) => toggle(item.id, e.currentTarget.checked)} />
                    <span className="al-guides-diff__meta">
                      <Chip tone={KIND_TONES[item.kind]} dot="none">
                        {KIND_LABELS[item.kind]}
                      </Chip>
                      <span className="al-num al-muted">{item.app}</span>
                      <span className="al-num">{diffItemDetail(item)}</span>
                    </span>
                    {item.kind !== 'setScore' && item.warnings.length ? <p className="al-guides-diff__warn">{item.warnings.join(' · ')}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {diff.staleFormats.length ? (
        <section className="al-guides-diff__group" aria-label={t('settings.guides.droppedByTheGuide')}>
          <div className="al-label">{t('settings.guides.droppedByTheGuideStaleformatscount', { staleFormatsCount: diff.staleFormats.length })}</div>
          <p className="al-caption">{t('settings.guides.theseSyncedFormatsAreNo')}</p>
          <ul className="al-guides-diff__plain">
            {diff.staleFormats.map((f) => (
              <li key={f.formatId}>{f.name}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {diff.warnings.length ? (
        <section className="al-guides-diff__group" aria-label={t('common.warnings')}>
          <div className="al-label" data-tone="warn">{t('settings.guides.warningsWarningscount', { warningsCount: diff.warnings.length })}</div>
          <ul className="al-guides-diff__plain">
            {diff.warnings.map((w) => (
              <li key={w} className="al-guides-diff__warn">
                {w}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Pane>
  );
}

function DiffPane() {
  const diff = useGuidesDiff();
  if (diff.isPending) return <Pane title={t('settings.guides.pendingChanges')} aria-label={t('settings.guides.pendingChanges')}><Skeleton lines={3} /></Pane>;
  if (diff.isError)
    return (
      <Pane title={t('settings.guides.pendingChanges')} aria-label={t('settings.guides.pendingChanges')}>
        <ErrorBlock title={t('settings.guides.couldntLoadPendingChanges')} onRetry={() => void diff.refetch()}>
          {errorMessage(diff.error)}
        </ErrorBlock>
      </Pane>
    );
  return <DiffView diff={diff.data} />;
}

interface MappingRow {
  key: string;
  name: string;
  app: GuideApp;
  formats: number;
  description: string;
}

function MappingTable({
  guideProfiles,
  local,
  value,
  onChange,
}: {
  guideProfiles: readonly GuideProfileInfo[];
  local: readonly QualityProfile[];
  value: GuidesSettings['profiles'];
  onChange: (next: GuidesSettings['profiles']) => void;
}) {
  const rows: MappingRow[] = guideProfiles.map((p) => ({ key: `${p.app}:${p.trashId}`, name: p.name, app: p.app, formats: p.formats.length, description: p.description }));
  // Mappings whose guide profile is not in the list (renamed upstream, or another app).
  const orphans = value.filter((m) => !guideProfiles.some((p) => p.name.toLowerCase() === m.guideProfileName.toLowerCase() && (m.app === undefined || m.app === p.app)));
  const options = [{ value: '', label: t('settings.guides.notMapped') }, ...local.map((p) => ({ value: String(p.id), label: p.name }))];
  const columns: Column<MappingRow>[] = [
    {
      key: 'name',
      header: t('settings.guides.guideProfile'),
      cell: (r) => (
        <span className="al-guides-map__name">
          <span>{r.name}</span>
          {r.description ? <span className="al-caption">{r.description}</span> : null}
        </span>
      ),
    },
    { key: 'app', header: t('settings.guides.app'), mono: true, muted: true, cell: (r) => r.app },
    { key: 'formats', header: t('common.formats'), mono: true, align: 'right', cell: (r) => r.formats },
    {
      key: 'local',
      header: t('settings.guides.localProfile'),
      cell: (r) => (
        <Select
          aria-label={t('settings.guides.localProfileForName', { name: r.name })}
          value={String(mappingFor(value, r.name, r.app) ?? '')}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange(setMapping(value, r.name, r.app, v ? Number(v) : null));
          }}
          options={options}
        />
      ),
    },
  ];
  return (
    <>
      <Table caption={t('settings.guides.profileMappings')} columns={columns} rows={rows} rowKey={(r) => r.key} empty={<EmptyState title={t('settings.guides.theGuideListsNoProfiles')}>{t('settings.guides.checkTheRepositoryAndApps')}</EmptyState>} />
      {orphans.length ? (
        <ul className="al-row-list" aria-label={t('settings.guides.mappingsNotInTheGuide')}>
          {orphans.map((m) => (
            <li key={`${m.app ?? ''}:${m.guideProfileName}`} className="al-row-list__row">
              <span>
                {m.guideProfileName} <span className="al-muted">{t('settings.guides.notInTheGuideValue', { value: local.find((p) => p.id === m.localQualityProfileId)?.name ?? `#${m.localQualityProfileId}` })}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((x) => x !== m))}>
                {t('common.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function GuidesForm({ data }: { data: GuidesSettings }) {
  const draft = useDraft(data);
  const save = useSaveGuidesSettings();
  const guideProfiles = useGuideProfiles();
  const local = useQualityProfileList();
  const v = draft.value;
  const errors = validateGuides(v);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof GuidesSettings>(k: K, value: GuidesSettings[K]) => draft.set((d) => ({ ...d, [k]: value }));
  const ids = { enabled: useId(), repo: useId(), branch: useId(), interval: useId(), include: useId(), exclude: useId(), score: useId() };

  return (
    <SettingsPage
      title={t('common.guides')}
      description={t('settings.guides.keepCustomFormatsAndProfile')}
      save={{ count: draft.changes, onSave: () => valid && save.mutate(v), onDiscard: draft.discard, saving: save.isPending, disabled: !valid }}
      aside={<StatusPane />}
      after={<DiffPane />}
    >
      <SettingsSection label={t('common.source')}>
        <FormRow label={t('settings.guides.guideSync')} htmlFor={ids.enabled} captionInline>
          <Toggle id={ids.enabled} checked={v.enabled} label={t('settings.guides.syncOnASchedule')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        </FormRow>
        <FormRow label={t('common.source')} caption={v.source === 'trash' ? t('settings.guides.theTrashGuidesRepositoryOn') : t('settings.guides.anyRepositoryWithTheSame')}>
          <Segmented
            aria-label={t('common.source')}
            value={v.source}
            onChange={(s) => set('source', s)}
            options={[
              { value: 'trash', label: t('settings.guides.trashGuides') },
              { value: 'custom', label: t('common.custom') },
            ]}
          />
        </FormRow>
        <FormRow label={t('settings.guides.repositoryUrl')} htmlFor={ids.repo} caption={t('settings.guides.rawContentBaseTheBranch')} error={errors.repoUrl}>
          <Input
            id={ids.repo}
            mono
            spellCheck={false}
            disabled={v.source === 'trash'}
            invalid={errors.repoUrl ? true : undefined}
            value={v.source === 'trash' ? TRASH_GUIDES_REPO_URL : v.repoUrl}
            onChange={(e) => set('repoUrl', e.currentTarget.value)}
          />
        </FormRow>
        <FormRow label={t('settings.guides.branch')} htmlFor={ids.branch} error={errors.branch}>
          <Input id={ids.branch} mono spellCheck={false} invalid={errors.branch ? true : undefined} value={v.branch} onChange={(e) => set('branch', e.currentTarget.value)} />
        </FormRow>
        <FormRow label={t('settings.guides.apps')} caption={t('settings.guides.guideSectionsToRead')} error={errors.apps}>
          <div className="al-guides-apps">
            {GuideApp.options.map((app) => (
              <Checkbox
                key={app}
                label={APP_LABELS[app]}
                checked={v.apps.includes(app)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  set('apps', on ? [...v.apps.filter((a) => a !== app), app] : v.apps.filter((a) => a !== app));
                }}
              />
            ))}
          </div>
        </FormRow>
      </SettingsSection>

      <SettingsSection label={t('settings.guides.schedule')}>
        <FormRow label={t('settings.guides.syncInterval')} htmlFor={ids.interval} caption={t('common.n1To168Hours')} error={errors.syncIntervalHours}>
          <Input
            id={ids.interval}
            type="number"
            mono
            min={1}
            max={168}
            end="h"
            className="al-input--num"
            invalid={errors.syncIntervalHours ? true : undefined}
            value={Number.isFinite(v.syncIntervalHours) ? String(v.syncIntervalHours) : ''}
            onChange={(e) => set('syncIntervalHours', Number(e.currentTarget.value))}
          />
        </FormRow>
        <FormRow label={t('common.mode')} caption={v.mode === 'notify' ? t('settings.guides.storeTheChangesAndNotify') : t('settings.guides.applyChangesAsSoonAs')}>
          <Segmented
            aria-label={t('common.mode')}
            value={v.mode}
            onChange={(m) => set('mode', m)}
            options={[
              { value: 'notify', label: t('settings.guides.notify') },
              { value: 'apply', label: t('settings.guides.apply') },
            ]}
          />
        </FormRow>
      </SettingsSection>

      <SettingsSection label={t('common.formats')}>
        <FormRow label={t('settings.guides.include')} htmlFor={ids.include} caption={t('settings.guides.formatsToSyncBesidesThose')}>
          <TermList id={ids.include} value={v.includeFormats} onChange={(entry) => set('includeFormats', entry)} placeholder={t('settings.guides.addANameTrashId')} />
        </FormRow>
        <FormRow label={t('settings.guides.exclude')} htmlFor={ids.exclude} caption={t('settings.guides.neverSyncedEvenWhenA')}>
          <TermList id={ids.exclude} value={v.excludeFormats} onChange={(row) => set('excludeFormats', row)} placeholder={t('settings.guides.addANameTrashId')} />
        </FormRow>
        <FormRow label={t('settings.guides.scoreAllSyncedFormats')} htmlFor={ids.score} captionInline>
          <Toggle id={ids.score} checked={v.scoreAllSyncedFormats} label={t('settings.guides.giveEverySyncedFormatIts')} onChange={(e) => set('scoreAllSyncedFormats', e.currentTarget.checked)} />
        </FormRow>
      </SettingsSection>

      <SettingsSection
        label={t('settings.guides.profileMappings')}
        count={v.profiles.length}
        action={
          <Button size="sm" variant="ghost" loading={guideProfiles.isFetching} onClick={() => void guideProfiles.refetch()}>
            {t('common.refresh')}
          </Button>
        }
      >
        {guideProfiles.isPending || local.isPending ? (
          <Skeleton lines={3} />
        ) : guideProfiles.isError ? (
          <ErrorBlock title={t('settings.guides.couldntReadTheGuidesProfiles')} onRetry={() => void guideProfiles.refetch()}>
            {errorMessage(guideProfiles.error)}
          </ErrorBlock>
        ) : (
          <MappingTable guideProfiles={guideProfiles.data} local={local.data ?? []} value={v.profiles} onChange={(p) => set('profiles', p)} />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

/** Settings → Guides (/settings/guides). */
export function GuidesSettingsPage() {
  const settings = useGuidesSettings();
  if (settings.isSuccess) return <GuidesForm data={settings.data} />;
  return (
    <SettingsPage title={t('common.guides')} aside={<StatusPane />}>
      {settings.isError ? (
        <ErrorBlock title={t('settings.guides.couldntLoadGuideSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : (
        <Skeleton lines={6} />
      )}
    </SettingsPage>
  );
}
