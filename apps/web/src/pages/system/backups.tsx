import { useEffect, useRef, useState } from 'react';
import type { Backup, BackupSettings, BackupType } from '@arclight/shared';
import { backupApi } from '../../api/backup.js';
import { Button, Chip, EmptyState, ErrorBlock, Field, FormSection, Input, LinkButton, Pane, Skeleton, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { ResourceBulkBar, tableSelection } from '../../components/resource-bulk-actions.js';
import { useSelection } from '../../components/bulk-actions.js';
import { ListSearchBar, ListSearchEmpty, useClientListSearch } from '../../components/list-search.js';
import { useBackups, useBackupSettings, useCreateBackup, useDeleteBackup, useRestoreBackup, useSaveBackupSettings } from '../../hooks/backup.js';
import { relativeTime } from '../../lib/format.js';
import { ConfirmModal } from './confirm-modal.js';
import { formatBytes, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';
import { t } from '../../i18n/index.js';

const TYPE_TONES: Record<BackupType, ChipTone> = { scheduled: 'neutral', manual: 'accent', update: 'default' };
const TYPE_LABELS: Record<BackupType, string> = { get scheduled() { return t('system.backups.scheduled'); }, get manual() { return t('system.backups.manual'); }, get update() { return t('system.backups.beforeUpdate'); } };

type Pending = { kind: 'restore'; backup: Backup } | { kind: 'upload'; file: File } | { kind: 'delete'; backup: Backup };

/** System → Backups: list, create, download, restore (stored or uploaded), delete, settings. */
export function SystemBackupsPage() {
  const backups = useBackups();
  const create = useCreateBackup();
  const remove = useDeleteBackup();
  const restore = useRestoreBackup();
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Search: file name, type and the shown date (`?q=` in the URL). Select all picks the matches only.
  const search = useClientListSearch(backups.data, (b) => [b.name, b.type, TYPE_LABELS[b.type], formatStamp(b.time)]);
  const backupKeys = (search.rows ?? []).map((b) => b.id);
  const selection = useSelection(backupKeys);

  const restored = () => {
    setPending(null);
    toast.push({ tone: 'warning', title: t('system.backups.backupRestored'), message: t('system.backups.restartArclightToFinishLoading') });
  };

  const confirm = async () => {
    if (!pending) return;
    if (pending.kind === 'delete') {
      await remove.mutateAsync(pending.backup.id);
      setPending(null);
    } else if (pending.kind === 'restore') {
      await restore.mutateAsync({ id: pending.backup.id });
      restored();
    } else {
      await restore.mutateAsync({ file: pending.file });
      restored();
    }
  };

  const columns: Column<Backup>[] = [
    { key: 'name', header: t('common.name'), mono: true, cell: (b) => <span className="sys-break">{b.name}</span>, sortValue: (b) => b.name },
    { key: 'type', header: t('common.type'), width: '140px', cell: (b) => <Chip tone={TYPE_TONES[b.type]}>{TYPE_LABELS[b.type]}</Chip>, sortValue: (b) => b.type },
    { key: 'size', header: t('common.size'), width: '100px', align: 'right', mono: true, cell: (b) => formatBytes(b.size), sortValue: (b) => b.size },
    {
      key: 'time',
      header: t('common.time'),
      width: '180px',
      mono: true,
      sortValue: (b) => b.time,
      cell: (b) => (
        <time dateTime={b.time} title={relativeTime(b.time)}>
          {formatStamp(b.time)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      width: '260px',
      align: 'right',
      cell: (b) => (
        <span className="sys-row-actions">
          <LinkButton size="sm" variant="ghost" href={backupApi.downloadUrl(b.id)} download={b.name} aria-label={t('system.backups.downloadName', { name: b.name })}>
            {t('common.download')}
          </LinkButton>
          <Button size="sm" variant="ghost" aria-label={t('system.backups.restoreName', { name: b.name })} onClick={() => setPending({ kind: 'restore', backup: b })}>
            {t('system.backups.restore')}
          </Button>
          <Button size="sm" variant="danger" aria-label={t('system.backups.deleteName', { name: b.name })} onClick={() => setPending({ kind: 'delete', backup: b })}>
            {t('common.delete')}
          </Button>
        </span>
      ),
    },
  ];

  const pendingName = pending ? (pending.kind === 'upload' ? pending.file.name : pending.backup.name) : '';

  return (
    <>
      <SystemHeader
        title={t('common.backups')}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="al-sr-only"
              aria-label={t('system.backups.backupFileToRestore')}
              data-testid="backup-upload"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) setPending({ kind: 'upload', file });
              }}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              {t('system.backups.restoreFromFile')}
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              {t('system.backups.createBackup')}
            </Button>
          </>
        }
      />
      <div className="sys-stack">
        <Pane flush title={t('common.backups')}>
          {backups.isError ? (
            <div className="sys-pad">
              <ErrorBlock title={t('system.backups.couldntListBackups')} onRetry={() => void backups.refetch()} />
            </div>
          ) : (
            <>
            {backups.data?.length || search.active ? (
              <div className="sys-pad">
                <ListSearchBar value={search.q} onChange={search.setQ} placeholder={t('listSearch.ph.backups')} shown={search.shown} total={search.total} />
              </div>
            ) : null}
            <Table
              columns={columns}
              rows={search.rows}
              rowKey={(b) => b.id}
              loading={backups.isLoading}
              caption={t('common.backups')}
              defaultSort={{ key: 'time', direction: 'desc' }}
              {...tableSelection(selection)}
              rowLabel={(b) => t('components.bulkActions.selectName', { name: b.name })}
              empty={
                search.active ? (
                  <ListSearchEmpty query={search.q} onClear={search.clear} />
                ) : (
                  <EmptyState title={t('system.backups.noBackupsYet')}>{t('system.backups.scheduledBackupsAppearHereCreate')}</EmptyState>
                )
              }
            />
            </>
          )}
        </Pane>
        <BackupSettingsPane />
        <ResourceBulkBar resource="backup" selection={selection} allKeys={backupKeys} nameOf={(id) => backups.data?.find((b) => b.id === id)?.name} />
      </div>

      <ConfirmModal
        open={pending !== null}
        title={pending?.kind === 'delete' ? t('system.backups.deleteBackup') : t('system.backups.restoreBackup')}
        confirmLabel={pending?.kind === 'delete' ? t('system.backups.deleteBackup') : t('system.backups.restoreBackup')}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      >
        {pending?.kind === 'delete' ? (
          <p>
            {t('common.delete')} <span className="al-num">{pendingName}</span>{t('system.backups.thisCantBeUndone')}
          </p>
        ) : pending ? (
          <>
            <p>
              {t('system.backups.restore')} <span className="al-num">{pendingName}</span>{t('system.backups.theBackupReplacesTheCurrent')} <span className="al-num">arclight.db.pre-restore</span>.
            </p>
            <p>{t('system.backups.arclightMustBeRestartedAfterwards')}</p>
          </>
        ) : null}
      </ConfirmModal>
    </>
  );
}

type Draft = Record<keyof BackupSettings, string>;

function toDraft(s: BackupSettings): Draft {
  return {
    folder: s.folder,
    intervalDays: String(s.intervalDays),
    hour: String(s.hour),
    retentionCount: String(s.retentionCount),
    retentionDays: String(s.retentionDays),
  };
}

const LIMITS = {
  intervalDays: [0, 365],
  hour: [0, 23],
  retentionCount: [0, 1000],
  retentionDays: [0, 3650],
} as const;

/** Validates the draft; returns settings or per-field errors. */
export function parseBackupDraft(d: Draft): { value: BackupSettings } | { errors: Partial<Record<keyof BackupSettings, string>> } {
  const errors: Partial<Record<keyof BackupSettings, string>> = {};
  const nums = {} as Record<keyof typeof LIMITS, number>;
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const [min, max] = LIMITS[key];
    const n = Number(d[key]);
    if (d[key].trim() === '' || !Number.isInteger(n) || n < min || n > max) errors[key] = t('system.backups.enterAWholeNumberFrom', { min, max });
    nums[key] = n;
  }
  const folder = d.folder.trim();
  if (folder && !/^([a-zA-Z]:[\\/]|[\\/])/.test(folder)) errors.folder = t('system.backups.useAnAbsolutePathOr');
  if (Object.keys(errors).length) return { errors };
  return { value: { folder, ...nums } };
}

function BackupSettingsPane() {
  const query = useBackupSettings();
  const save = useSaveBackupSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof BackupSettings, string>>>({});

  useEffect(() => {
    if (query.data) setDraft(toDraft(query.data));
  }, [query.data]);

  const field = (key: keyof BackupSettings, label: string, hint: string, extra: { type?: string; min?: number; max?: number } = {}) =>
    draft ? (
      <Field inline label={label} hint={hint} error={errors[key]}>
        <Input
          mono
          type={extra.type ?? 'number'}
          {...(extra.min !== undefined ? { min: extra.min } : {})}
          {...(extra.max !== undefined ? { max: extra.max } : {})}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.currentTarget.value })}
        />
      </Field>
    ) : null;

  return (
    <Pane title={t('common.settings')}>
      {query.isError ? (
        <ErrorBlock title={t('system.backups.couldntLoadBackupSettings')} onRetry={() => void query.refetch()} />
      ) : !draft ? (
        <Skeleton lines={4} />
      ) : (
        <form
          aria-label={t('system.backups.backupSettings')}
          className="sys-form"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseBackupDraft(draft);
            if ('errors' in parsed) {
              setErrors(parsed.errors);
              return;
            }
            setErrors({});
            save.mutate(parsed.value, { onSuccess: () => toast.push({ tone: 'ok', title: t('system.backups.backupSettingsSaved') }) });
          }}
        >
          <FormSection label={t('system.backups.schedule')}>
            {field('folder', t('system.backups.folder'), t('system.backups.folderHelp'), { type: 'text' })}
            {field('intervalDays', t('system.backups.intervalDays'), t('system.backups.intervalDaysHelp'), { min: 0, max: 365 })}
            {field('hour', t('system.backups.hourOfDay'), t('system.backups.hourOfDayHelp'), { min: 0, max: 23 })}
          </FormSection>
          <FormSection label={t('common.retention')}>
            {field('retentionCount', t('system.backups.keepAtMost'), t('system.backups.keepAtMostHelp'), { min: 0, max: 1000 })}
            {field('retentionDays', t('system.backups.keepForDays'), t('system.backups.keepForDaysHelp'), { min: 0, max: 3650 })}
          </FormSection>
          <div className="sys-form__actions">
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t('common.saveChanges')}
            </Button>
          </div>
        </form>
      )}
    </Pane>
  );
}
