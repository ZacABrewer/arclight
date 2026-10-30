import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { HealthAction, HealthFinding } from '@arclight/shared';
import { Button, Chip, EmptyState, Menu, Popover, Table, type Column, type RowKey } from '../../../arclight/index.js';
import { useToast } from '../../../components/toast.js';
import { useHealthAction } from '../../../hooks/health-scan.js';
import { relativeTime } from '../../../lib/format.js';
import { ConfirmModal } from '../../system/confirm-modal.js';
import { t } from '../../../i18n/index.js';
import { explain, hasFile, itemLink, mediaLabel, severityLabel, severityTone, typeLabel } from './health-model.js';

// Findings table and the fix actions (replace, re-check, ignore, delete), shared by the
// Health tab of Library → Hygiene and the Health tab of each item's page.

interface Confirming {
  action: 'replace' | 'delete';
  findings: HealthFinding[];
}

/** Runs fix actions; replace and delete ask first. Render `dialog` once. */
export function useHealthActions(onDone?: () => void) {
  const mutation = useHealthAction();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState<HealthAction | null>(null);

  const execute = async (action: HealthAction, findings: readonly HealthFinding[]) => {
    const ids = findings.map((f) => f.id);
    if (ids.length === 0) return;
    setBusy(action);
    try {
      const res = await mutation.mutateAsync({ action, ids });
      const failed = res.results.find((r) => !r.ok);
      toast.push({
        tone: res.failed === 0 ? 'ok' : res.succeeded === 0 ? 'error' : 'warning',
        title: t(`library.health.done.${action}`, { count: res.succeeded }),
        message: failed ? t('library.health.someFailed', { count: res.failed, error: failed.error ?? '' }) : undefined,
      });
      onDone?.();
    } finally {
      setBusy(null);
    }
  };

  const run = (action: HealthAction, findings: readonly HealthFinding[]) => {
    if (action === 'replace' || action === 'delete') {
      const withFiles = findings.filter(hasFile);
      if (withFiles.length === 0) {
        toast.push({ tone: 'warning', title: t('library.health.noFileToFix') });
        return;
      }
      setConfirming({ action, findings: withFiles });
      return;
    }
    void execute(action, findings);
  };

  const dialog = (
    <ConfirmModal
      open={confirming !== null}
      title={
        confirming?.action === 'replace'
          ? t('library.health.confirmReplaceTitle', { count: confirming.findings.length })
          : t('library.health.confirmDeleteTitle', { count: confirming?.findings.length ?? 0 })
      }
      confirmLabel={confirming?.action === 'replace' ? t('library.health.replace') : t('library.health.deleteFile')}
      onCancel={() => setConfirming(null)}
      onConfirm={async () => {
        if (!confirming) return;
        await execute(confirming.action, confirming.findings);
        setConfirming(null);
      }}
    >
      <p>{confirming?.action === 'replace' ? t('library.health.confirmReplaceBody') : t('library.health.confirmDeleteBody')}</p>
      <ul className="hyg-confirm-list">
        {confirming?.findings.map((f) => (
          <li key={f.id} className="al-num">
            {f.path}
          </li>
        ))}
      </ul>
    </ConfirmModal>
  );

  return { run, busy, dialog };
}

function RowActions({ finding, run }: { finding: HealthFinding; run: (a: HealthAction, f: HealthFinding[]) => void }) {
  const file = hasFile(finding);
  return (
    <Popover
      trigger={(props) => (
        <Button size="sm" variant="ghost" {...props} aria-label={t('library.health.actionsFor', { title: finding.title })}>
          {t('library.health.fix')}
        </Button>
      )}
      placement="bottom-end"
      width={220}
      label={t('library.health.actionsFor', { title: finding.title })}
    >
      {(close) => (
        <Menu
          onDone={close}
          items={[
            ...(file ? [{ id: 'replace', label: t('library.health.replace'), onSelect: () => run('replace', [finding]) }] : []),
            { id: 'recheck', label: t('library.health.recheck'), onSelect: () => run('recheck', [finding]) },
            finding.status === 'ignored'
              ? { id: 'unignore', label: t('library.health.unignore'), onSelect: () => run('unignore', [finding]) }
              : { id: 'ignore', label: t('library.health.ignore'), onSelect: () => run('ignore', [finding]) },
            ...(file ? [{ id: 'delete', label: t('library.health.deleteFile'), danger: true, separatorBefore: true, onSelect: () => run('delete', [finding]) }] : []),
          ]}
        />
      )}
    </Popover>
  );
}

export interface FindingsTableProps {
  rows: readonly HealthFinding[];
  run: (a: HealthAction, f: HealthFinding[]) => void;
  selected?: ReadonlySet<RowKey> | undefined;
  onSelectionChange?: ((s: Set<RowKey>) => void) | undefined;
  /** Item pages: no item column link, no media column. */
  compact?: boolean | undefined;
  loading?: boolean | undefined;
  empty?: ReactNode | undefined;
}

export function FindingsTable({ rows, run, selected, onSelectionChange, compact, loading, empty }: FindingsTableProps) {
  const columns: Column<HealthFinding>[] = [
    {
      key: 'item',
      header: compact ? t('common.file') : t('library.health.item'),
      sortValue: (f) => f.title,
      cell: (f) => {
        const link = compact ? null : itemLink(f);
        return (
          <div className="hyg-pathcell">
            <div className="hyg-strong">{link ? <Link className="al-link" {...link}>{f.title}</Link> : f.title}</div>
            <div className="al-num al-caption hyg-path">{f.path}</div>
          </div>
        );
      },
    },
    {
      key: 'problem',
      header: t('library.health.problem'),
      sortValue: (f) => `${f.severity === 'error' ? 0 : f.severity === 'warning' ? 1 : 2}${f.type}`,
      cell: (f) => (
        <div className="hl-problem">
          <Chip tone={severityTone(f.severity)} title={severityLabel(f.severity)}>
            {typeLabel(f.type)}
          </Chip>
          <span className="hl-explain">{explain(f)}</span>
        </div>
      ),
    },
    ...(compact
      ? []
      : [{ key: 'media', header: t('library.health.mediaType'), muted: true, cell: (f: HealthFinding) => mediaLabel(f.mediaType), sortValue: (f: HealthFinding) => f.mediaType }]),
    {
      key: 'checked',
      header: t('library.health.lastChecked'),
      muted: true,
      sortValue: (f) => f.lastChecked,
      cell: (f) => <time dateTime={f.lastChecked}>{relativeTime(f.lastChecked)}</time>,
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (f) => <RowActions finding={f} run={run} />,
    },
  ];
  return (
    <Table
      caption={t('library.health.findings')}
      density="rich"
      columns={columns}
      rows={rows}
      loading={loading}
      rowKey={(f) => f.id}
      defaultSort={{ key: 'problem', direction: 'asc' }}
      selectable={onSelectionChange !== undefined}
      selected={selected}
      onSelectionChange={onSelectionChange}
      rowLabel={(f) => t('library.selectTitle', { title: f.title })}
      empty={empty ?? <EmptyState title={t('library.health.noProblems')}>{t('library.health.noProblemsHint')}</EmptyState>}
    />
  );
}
