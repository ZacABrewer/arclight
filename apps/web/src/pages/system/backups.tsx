import { useEffect, useRef, useState } from 'react';
import type { Backup, BackupSettings, BackupType } from '@arclight/shared';
import { backupApi } from '../../api/backup.js';
import { Button, Chip, EmptyState, ErrorBlock, Field, FormSection, Input, LinkButton, Pane, Skeleton, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useBackups, useBackupSettings, useCreateBackup, useDeleteBackup, useRestoreBackup, useSaveBackupSettings } from '../../hooks/backup.js';
import { relativeTime } from '../../lib/format.js';
import { ConfirmModal } from './confirm-modal.js';
import { formatBytes, formatStamp } from './format.js';
import { SystemHeader } from './system-header.js';

const TYPE_TONES: Record<BackupType, ChipTone> = { scheduled: 'neutral', manual: 'accent', update: 'default' };
const TYPE_LABELS: Record<BackupType, string> = { scheduled: 'Scheduled', manual: 'Manual', update: 'Before update' };

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

  const restored = () => {
    setPending(null);
    toast.push({ tone: 'warning', title: 'Backup restored', message: 'Restart Arclight to finish loading the restored data.' });
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
    { key: 'name', header: 'Name', mono: true, cell: (b) => <span className="sys-break">{b.name}</span>, sortValue: (b) => b.name },
    { key: 'type', header: 'Type', width: '140px', cell: (b) => <Chip tone={TYPE_TONES[b.type]}>{TYPE_LABELS[b.type]}</Chip>, sortValue: (b) => b.type },
    { key: 'size', header: 'Size', width: '100px', align: 'right', mono: true, cell: (b) => formatBytes(b.size), sortValue: (b) => b.size },
    {
      key: 'time',
      header: 'Time',
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
      header: <span className="al-sr-only">Actions</span>,
      width: '260px',
      align: 'right',
      cell: (b) => (
        <span className="sys-row-actions">
          <LinkButton size="sm" variant="ghost" href={backupApi.downloadUrl(b.id)} download={b.name} aria-label={`Download ${b.name}`}>
            Download
          </LinkButton>
          <Button size="sm" variant="ghost" aria-label={`Restore ${b.name}`} onClick={() => setPending({ kind: 'restore', backup: b })}>
            Restore
          </Button>
          <Button size="sm" variant="danger" aria-label={`Delete ${b.name}`} onClick={() => setPending({ kind: 'delete', backup: b })}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  const pendingName = pending ? (pending.kind === 'upload' ? pending.file.name : pending.backup.name) : '';

  return (
    <>
      <SystemHeader
        title="Backups"
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="al-sr-only"
              aria-label="Backup file to restore"
              data-testid="backup-upload"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) setPending({ kind: 'upload', file });
              }}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              Restore from file
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Create backup
            </Button>
          </>
        }
      />
      <div className="sys-stack">
        <Pane flush title="Backups">
          {backups.isError ? (
            <div className="sys-pad">
              <ErrorBlock title="Couldn't list backups" onRetry={() => void backups.refetch()} />
            </div>
          ) : (
            <Table
              columns={columns}
              rows={backups.data}
              rowKey={(b) => b.id}
              loading={backups.isLoading}
              caption="Backups"
              defaultSort={{ key: 'time', direction: 'desc' }}
              empty={<EmptyState title="No backups yet">Scheduled backups appear here. Create one now with Create backup.</EmptyState>}
            />
          )}
        </Pane>
        <BackupSettingsPane />
      </div>

      <ConfirmModal
        open={pending !== null}
        title={pending?.kind === 'delete' ? 'Delete backup' : 'Restore backup'}
        confirmLabel={pending?.kind === 'delete' ? 'Delete backup' : 'Restore backup'}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      >
        {pending?.kind === 'delete' ? (
          <p>
            Delete <span className="al-num">{pendingName}</span>? This can't be undone.
          </p>
        ) : pending ? (
          <>
            <p>
              Restore <span className="al-num">{pendingName}</span>? The backup replaces the current database and config files. A copy of the current database
              is kept as <span className="al-num">arclight.db.pre-restore</span>.
            </p>
            <p>Arclight must be restarted afterwards.</p>
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
    if (d[key].trim() === '' || !Number.isInteger(n) || n < min || n > max) errors[key] = `Enter a whole number from ${min} to ${max}`;
    nums[key] = n;
  }
  const folder = d.folder.trim();
  if (folder && !/^([a-zA-Z]:[\\/]|[\\/])/.test(folder)) errors.folder = 'Use an absolute path, or leave empty for the default';
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
    <Pane title="Settings">
      {query.isError ? (
        <ErrorBlock title="Couldn't load backup settings" onRetry={() => void query.refetch()} />
      ) : !draft ? (
        <Skeleton lines={4} />
      ) : (
        <form
          aria-label="Backup settings"
          className="sys-form"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseBackupDraft(draft);
            if ('errors' in parsed) {
              setErrors(parsed.errors);
              return;
            }
            setErrors({});
            save.mutate(parsed.value, { onSuccess: () => toast.push({ tone: 'ok', title: 'Backup settings saved' }) });
          }}
        >
          <FormSection label="Schedule">
            {field('folder', 'Folder', 'Where archives are written. Empty: the backups folder inside the config directory.', { type: 'text' })}
            {field('intervalDays', 'Interval (days)', 'Days between scheduled backups. 0 turns them off.', { min: 0, max: 365 })}
            {field('hour', 'Hour of day', 'Local hour (0–23) at which a due scheduled backup runs.', { min: 0, max: 23 })}
          </FormSection>
          <FormSection label="Retention">
            {field('retentionCount', 'Keep at most', 'Automatic backups to keep. 0 for no limit. Manual backups stay until deleted.', { min: 0, max: 1000 })}
            {field('retentionDays', 'Keep for (days)', 'Delete automatic backups older than this. 0 for no limit.', { min: 0, max: 3650 })}
          </FormSection>
          <div className="sys-form__actions">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      )}
    </Pane>
  );
}
