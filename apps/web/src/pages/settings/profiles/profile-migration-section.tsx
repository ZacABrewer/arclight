import { useEffect, useId, useState } from 'react';
import type { ProfileMigrationProgress, ProfileMigrationSettings, ProfileMismatchAction, QualityProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Field, Input, Meter, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { ProfileMigrationDialog } from '../../../components/media/profile-migration-dialog.js';
import { mismatchActionLabel } from '../../../components/media/profile-fit.js';
import { useToast } from '../../../components/toast.js';
import { useRootFolders, useTags } from '../../../hooks/library.js';
import {
  useProfileMigrationProgressList,
  useProfileMigrationSearchAll,
  useProfileMigrationSettings,
  useRetryFailedMigration,
  useSaveProfileMigrationSettings,
  useUpdateProfileMigration,
} from '../../../hooks/profile-migration.js';
import { CardGrid, ItemCard, SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

const ACTIONS: ProfileMismatchAction[] = ['none', 'replace', 'replaceIfBetter'];

/** "27 items don't meet this profile" line for a quality profile card. */
export function MismatchCount({ progress }: { progress: ProfileMigrationProgress | undefined }) {
  if (!progress || progress.mismatchedItems === 0) return null;
  return (
    <span className="al-caption" data-testid="profile-mismatch-count">
      {t('profileMigration.profile.mismatchedItems', { count: progress.mismatchedItems })}
    </span>
  );
}

/**
 * Settings -> Profiles -> Profile migration: per profile what happens to files that do not
 * meet it, the automatic mode and its progress, plus the global automatic-mode limits.
 */
export function ProfileMigrationSection({ profiles }: { profiles: readonly QualityProfile[] | undefined }) {
  const list = useProfileMigrationProgressList();
  const [moving, setMoving] = useState<ProfileMigrationProgress | null>(null);
  const rootFolders = useRootFolders();
  const tags = useTags();

  return (
    <SettingsSection label={t('profileMigration.section')}>
      <p className="al-caption">{t('profileMigration.sectionIntro')}</p>
      <GlobalSettings />
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('profileMigration.couldNotLoad')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label={t('profileMigration.section')}>
          {list.data.map((p) => (
            <ProfileMigrationCard key={p.qualityProfileId} progress={p} onMove={() => setMoving(p)} />
          ))}
        </CardGrid>
      )}
      <ProfileMigrationDialog
        open={moving !== null}
        onClose={() => setMoving(null)}
        selection={{ fromProfileId: moving?.qualityProfileId ?? 0 }}
        profiles={profiles}
        filters={{ rootFolders: rootFolders.data, tags: tags.data }}
        subject={moving ? t('profileMigration.profile.everythingOn', { name: moving.qualityProfileName }) : ''}
      />
    </SettingsSection>
  );
}

function ProfileMigrationCard({ progress, onMove }: { progress: ProfileMigrationProgress; onMove: () => void }) {
  const update = useUpdateProfileMigration();
  const searchAll = useProfileMigrationSearchAll();
  const retry = useRetryFailedMigration();
  const toast = useToast();
  const autoId = useId();
  const [confirm, setConfirm] = useState(false);
  const { settings, queue } = progress;
  const id = progress.qualityProfileId;
  const total = queue.remaining + queue.inProgress + queue.done + queue.failed;
  const hasRule = settings.mismatchAction !== 'none';

  return (
    <ItemCard
      title={progress.qualityProfileName}
      status={
        hasRule && settings.autoEnabled ? (
          <Chip tone={settings.paused ? 'muted' : 'accent'}>{settings.paused ? t('profileMigration.profile.paused') : t('profileMigration.profile.automatic')}</Chip>
        ) : null
      }
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onMove}>
            {t('profileMigration.profile.moveItems')}
          </Button>
          <Button size="sm" disabled={!hasRule || queue.remaining === 0} loading={searchAll.isPending} onClick={() => setConfirm(true)}>
            {t('profileMigration.profile.searchAllNow')}
          </Button>
          {hasRule && settings.autoEnabled ? (
            <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => update.mutate({ id, body: { paused: !settings.paused } })}>
              {settings.paused ? t('profileMigration.profile.resume') : t('profileMigration.profile.pause')}
            </Button>
          ) : null}
          {queue.failed > 0 ? (
            <Button size="sm" variant="ghost" loading={retry.isPending} onClick={() => retry.mutate(id)}>
              {t('profileMigration.profile.retryFailed')}
            </Button>
          ) : null}
        </>
      }
    >
      <span className="al-caption">
        {progress.mismatchedItems > 0
          ? t('profileMigration.profile.mismatchedItems', { count: progress.mismatchedItems })
          : t('profileMigration.profile.allMeet')}
      </span>
      <span className="al-caption al-num">
        {t('profileMigration.profile.files', { meets: progress.files.meets, upgradeAllowed: progress.files.upgradeAllowed, notAllowed: progress.files.notAllowed })}
      </span>
      <Field label={t('profileMigration.profile.rule')}>
        <Select
          aria-label={t('profileMigration.profile.ruleFor', { name: progress.qualityProfileName })}
          value={settings.mismatchAction}
          onChange={(e) => update.mutate({ id, body: { mismatchAction: e.currentTarget.value as ProfileMismatchAction } })}
          options={ACTIONS.map((a) => ({ value: a, label: mismatchActionLabel(a) }))}
        />
      </Field>
      <Toggle
        id={autoId}
        checked={settings.autoEnabled}
        disabled={!hasRule}
        label={t('profileMigration.profile.autoLabel')}
        onChange={(e) => update.mutate({ id, body: { autoEnabled: e.currentTarget.checked } })}
      />
      {total > 0 ? (
        <>
          <Meter
            value={((queue.done + queue.failed) / total) * 100}
            label={t('profileMigration.profile.progressFor', { name: progress.qualityProfileName })}
            valueText={`${queue.done}/${total}`}
          />
          <span className="al-caption al-num" data-testid="migration-progress">
            {t('profileMigration.profile.progress', queue)}
          </span>
        </>
      ) : null}
      <ConfirmDialog
        open={confirm}
        danger={false}
        title={t('profileMigration.profile.confirmTitle', { name: progress.qualityProfileName })}
        confirmLabel={t('profileMigration.profile.confirmLabel', { count: progress.pendingSearches })}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          const r = await searchAll.mutateAsync(id);
          toast.push({ tone: 'info', title: t('profileMigration.profile.searchesStarted', { count: r.searches }) });
          setConfirm(false);
        }}
      >
        <p>{t('profileMigration.profile.confirmBody', { count: progress.pendingSearches })}</p>
      </ConfirmDialog>
    </ItemCard>
  );
}

const NUMBER_FIELDS = ['intervalMinutes', 'searchesPerRun', 'maxSearchesPerDay', 'maxAttempts', 'retryAfterHours'] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];

function GlobalSettings() {
  const settings = useProfileMigrationSettings();
  const save = useSaveProfileMigrationSettings();
  const [draft, setDraft] = useState<ProfileMigrationSettings | null>(null);
  const enabledId = useId();
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  if (!draft) return settings.isError ? <ErrorBlock title={t('profileMigration.couldNotLoad')}>{errorMessage(settings.error)}</ErrorBlock> : null;

  const labels: Record<NumberField, string> = {
    intervalMinutes: t('profileMigration.settings.intervalMinutes'),
    searchesPerRun: t('profileMigration.settings.searchesPerRun'),
    maxSearchesPerDay: t('profileMigration.settings.maxSearchesPerDay'),
    maxAttempts: t('profileMigration.settings.maxAttempts'),
    retryAfterHours: t('profileMigration.settings.retryAfterHours'),
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data);
  return (
    <div className="mk-stack-sm" aria-label={t('profileMigration.settings.title')} role="group">
      <Toggle
        id={enabledId}
        checked={draft.enabled}
        label={t('profileMigration.settings.enabled')}
        onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}
      />
      <div className="mk-row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {NUMBER_FIELDS.map((key) => (
          <Field key={key} label={labels[key]}>
            <Input
              type="number"
              mono
              min={1}
              value={draft[key]}
              onChange={(e) => {
                const n = Number.parseInt(e.currentTarget.value, 10);
                if (!Number.isNaN(n)) setDraft({ ...draft, [key]: n });
              }}
            />
          </Field>
        ))}
        <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
          {t('common.save')}
        </Button>
      </div>
      <p className="al-caption">{t('profileMigration.settings.hint')}</p>
    </div>
  );
}
