import { useEffect, useRef, useState } from 'react';
import type { Backup, BackupSettings, BackupType } from '@arclight/shared';
import { backupApi } from '../../api/backup.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Input } from '../../components/form.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column } from '../../components/table.js';
import { useToast } from '../../components/toast.js';
import {
  useBackups,
  useBackupSettings,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
  useSaveBackupSettings,
} from '../../hooks/backup.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { formatBytes } from '../activity/activity-shared.js';

const TYPE_TONES: Record<BackupType, BadgeTone> = { scheduled: 'info', manual: 'ok', update: 'warning' };
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
    { key: 'name', header: 'Name', cell: (b) => <span className="break">{b.name}</span> },
    { key: 'type', header: 'Type', width: '130px', cell: (b) => <Badge tone={TYPE_TONES[b.type]}>{TYPE_LABELS[b.type]}</Badge> },
    { key: 'size', header: 'Size', width: '100px', align: 'right', cell: (b) => formatBytes(b.size) },
    {
      key: 'time',
      header: 'Time',
      width: '170px',
      cell: (b) => (
        <time dateTime={b.time} title={relativeTime(b.time)} className="nowrap">
          {formatDateTime(b.time)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: '250px',
      align: 'right',
      cell: (b) => (
        <span className="row-actions">
          <a className="btn btn-ghost btn-sm" href={backupApi.downloadUrl(b.id)} download={b.name} aria-label={`Download ${b.name}`}>
            Download
          </a>
          <Button size="sm" variant="ghost" aria-label={`Restore ${b.name}`} onClick={() => setPending({ kind: 'restore', backup: b })}>
            Restore
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => setPending({ kind: 'delete', backup: b })}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Backups"
      actions={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label="Backup file to restore"
            data-testid="backup-upload"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) setPending({ kind: 'upload', file });
            }}
          />
          <Button onClick={() => fileRef.current?.click()}>Restore from file…</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            Back up now
          </Button>
        </>
      }
    >
      <Card flush title="Backups">
        {backups.isError ? (
          <ErrorView error={backups.error} onRetry={() => void backups.refetch()} />
        ) : (
          <Table
            columns={columns}
            rows={backups.data}
            rowKey={(b) => b.id}
            loading={backups.isLoading}
            caption="Backups"
            empty={<EmptyState title="No backups yet">Scheduled backups appear here; use “Back up now” to make one.</EmptyState>}
          />
        )}
      </Card>
      <BackupSettingsCard />

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'delete' ? 'Delete backup' : 'Restore backup'}
        confirmLabel={pending?.kind === 'delete' ? 'Delete' : 'Restore'}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      >
        {pending?.kind === 'delete' ? (
          <p>
            Delete <strong>{pending.backup.name}</strong>? This cannot be undone.
          </p>
        ) : pending ? (
          <>
            <p>
              Restore <strong>{pending.kind === 'restore' ? pending.backup.name : pending.file.name}</strong>? The current database
              and config files are replaced by the backup's contents (a copy of the current database is kept as
              <code> arclight.db.pre-restore</code>).
            </p>
            <p>Arclight must be restarted afterwards.</p>
          </>
        ) : null}
      </ConfirmDialog>
    </Page>
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

function BackupSettingsCard() {
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
      <FormField inline label={label} hint={hint} error={errors[key]}>
        <Input
          type={extra.type ?? 'number'}
          {...(extra.min !== undefined ? { min: extra.min } : {})}
          {...(extra.max !== undefined ? { max: extra.max } : {})}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.currentTarget.value })}
        />
      </FormField>
    ) : null;

  return (
    <Card title="Settings">
      {query.isError ? (
        <ErrorView error={query.error} onRetry={() => void query.refetch()} />
      ) : !draft ? (
        <LoadingBlock />
      ) : (
        <form
          aria-label="Backup settings"
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
          {field('folder', 'Folder', 'Where archives are written. Empty: the backups folder inside the config directory.', { type: 'text' })}
          {field('intervalDays', 'Interval (days)', 'Days between scheduled backups; 0 turns them off.', { min: 0, max: 365 })}
          {field('hour', 'Hour of day', 'Local hour (0-23) at which a due scheduled backup runs.', { min: 0, max: 23 })}
          {field('retentionCount', 'Keep at most', 'Automatic backups to keep; 0 for no limit. Manual backups are kept until deleted.', { min: 0, max: 1000 })}
          {field('retentionDays', 'Keep for (days)', 'Delete automatic backups older than this; 0 for no limit.', { min: 0, max: 3650 })}
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
