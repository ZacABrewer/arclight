import { useEffect, useMemo, useState } from 'react';
import type { HygieneFinding } from '@arclight/shared';
import { Button, Chip, EmptyState, ErrorBlock, PageHeader, Pane, Radio, Skeleton, Table, Tabs, type Column } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { useToast } from '../../../components/toast.js';
import { useHygieneDelete, useHygieneFindings, useHygieneScan } from '../../../hooks/hygiene.js';
import { relativeTime } from '../../../lib/format.js';
import { ConfirmModal } from '../../system/confirm-modal.js';
import { DUPLICATE_REASON_LABEL, bestSuggestion, defaultKeep, deletableExcept, fileName, folderOf, groupDuplicates, guessLabel, suggestionLabel, type DuplicateGroup } from './hygiene-model.js';
import { MapDialog } from './map-dialog.js';
import './hygiene.css';
import { t } from '../../../i18n/index.js';

type TabId = 'orphan' | 'duplicate' | 'empty';

interface DeleteTarget {
  findings: HygieneFinding[];
  title: string;
  label: string;
}

function PathCell({ path }: { path: string }) {
  return (
    <div className="hyg-pathcell">
      <div className="hyg-strong">{fileName(path)}</div>
      <div className="al-num al-caption hyg-path">{folderOf(path)}</div>
    </div>
  );
}

function OrphansTable({ rows, onMap, onDelete }: { rows: HygieneFinding[]; onMap: (f: HygieneFinding) => void; onDelete: (deleteTarget: DeleteTarget) => void }) {
  const columns: Column<HygieneFinding>[] = [
    { key: 'path', header: t('common.file'), cell: (f) => <PathCell path={f.path} />, sortValue: (f) => f.path },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (f) => formatBytes(f.sizeBytes), sortValue: (f) => f.sizeBytes },
    { key: 'guess', header: t('library.hygiene.parsedAs'), muted: true, cell: (f) => guessLabel(f.parsed) },
    {
      key: 'suggestion',
      header: t('library.hygiene.bestMatch'),
      cell: (f) => {
        const s = bestSuggestion(f);
        return s ? (
          <Chip tone={s.score >= 1 ? 'accent' : 'default'} dot="none">
            {suggestionLabel(s)}
          </Chip>
        ) : (
          <Chip tone="warn">{t('library.hygiene.noMatch')}</Chip>
        );
      },
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (f) => (
        <div className="hyg-actions">
          <Button size="sm" variant="secondary" onClick={() => onMap(f)} aria-label={t('library.hygiene.mapFilename', { fileName: fileName(f.path) })}>
            {t('library.hygiene.map')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onDelete({ findings: [f], title: t('library.hygiene.deleteFilename', { fileName: fileName(f.path) }), label: t('library.hygiene.deleteFile') })} aria-label={t('library.hygiene.deleteFilename2', { fileName: fileName(f.path) })}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];
  return (
    <Table
      caption={t('library.hygiene.orphanFiles')}
      density="rich"
      columns={columns}
      rows={rows}
      rowKey={(f) => f.id}
      defaultSort={{ key: 'path', direction: 'asc' }}
      empty={<EmptyState title={t('library.hygiene.noOrphanFiles')}>{t('library.hygiene.everyVideoFileUnderThe')}</EmptyState>}
    />
  );
}

function DuplicateGroupPane({ group, onDelete }: { group: DuplicateGroup; onDelete: (item: DeleteTarget) => void }) {
  const [keep, setKeep] = useState(() => defaultKeep(group));
  const others = deletableExcept(group, keep);
  return (
    <Pane
      className="hyg-group"
      aria-label={t('library.hygiene.duplicateSetFilename', { fileName: fileName(group.entries[0]?.path ?? '') })}
      title={group.reason ? DUPLICATE_REASON_LABEL[group.reason] : t('library.hygiene.duplicates')}
      actions={
        <Button
          size="sm"
          variant="danger"
          disabled={others.length === 0}
          onClick={() => onDelete({ findings: others, title: t('library.hygiene.deleteCopiesOfFilename', { othersCount: others.length, fileName: fileName(keep) }), label: others.length === 1 ? t('library.hygiene.deleteCopy') : t('library.hygiene.deleteCopies') })}
        >
          {t('library.hygiene.deleteOthers')}
        </Button>
      }
    >
      <ul className="hyg-group__list">
        {group.entries.map((e) => (
          <li key={e.path} className="hyg-group__row">
            <Radio name={`keep-${group.key}`} checked={keep === e.path} onChange={() => setKeep(e.path)} label={t('common.keep')} aria-label={t('library.hygiene.keepPath', { path: e.path })} />
            <div className="hyg-group__path">
              <div className="al-num hyg-path">{e.path}</div>
              <div className="al-caption">
                {e.finding ? formatBytes(e.finding.sizeBytes) : t('library.hygiene.libraryFile')}
                {e.finding?.mediaFileId != null ? t('library.hygiene.inLibrary') : ''}
              </div>
            </div>
            {e.finding ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={keep === e.path}
                onClick={() => onDelete({ findings: [e.finding as HygieneFinding], title: t('library.hygiene.deleteFilename', { fileName: fileName(e.path) }), label: t('library.hygiene.deleteFile') })}
                aria-label={t('library.hygiene.deletePath', { path: e.path })}
              >
                {t('common.delete')}
              </Button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
    </Pane>
  );
}

function EmptyFoldersTable({ rows, onDelete }: { rows: HygieneFinding[]; onDelete: (entry: DeleteTarget) => void }) {
  const columns: Column<HygieneFinding>[] = [
    { key: 'path', header: t('library.hygiene.folder'), mono: true, cell: (f) => <span className="hyg-path">{f.path}</span>, sortValue: (f) => f.path },
    { key: 'root', header: t('common.rootFolder'), mono: true, muted: true, cell: (f) => f.rootFolderPath },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (f) => (
        <Button size="sm" variant="danger" onClick={() => onDelete({ findings: [f], title: t('library.hygiene.deletePath2', { path: f.path }), label: t('library.hygiene.deleteFolder') })} aria-label={t('library.hygiene.deletePath', { path: f.path })}>
          {t('common.delete')}
        </Button>
      ),
    },
  ];
  return (
    <Table
      caption={t('library.hygiene.emptyFolders')}
      columns={columns}
      rows={rows}
      rowKey={(f) => f.id}
      defaultSort={{ key: 'path', direction: 'asc' }}
      empty={<EmptyState title={t('library.hygiene.noEmptyFolders')} />}
    />
  );
}

/** Library → Hygiene (/library/hygiene, admin): orphans, duplicates and empty folders. */
export function HygienePage() {
  const findings = useHygieneFindings();
  const scan = useHygieneScan();
  const del = useHygieneDelete();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('orphan');
  const [mapping, setMapping] = useState<HygieneFinding | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  useEffect(() => {
    document.title = t('library.hygiene.hygieneArclight');
  }, []);

  const records = findings.data?.records ?? [];
  const orphans = useMemo(() => records.filter((r) => r.type === 'orphan'), [records]);
  const groups = useMemo(() => groupDuplicates(records), [records]);
  const empties = useMemo(() => records.filter((r) => r.type === 'empty'), [records]);
  const counts = findings.data?.counts;
  const lastScan = findings.data?.lastScan ?? null;

  const body = findings.isError ? (
    <ErrorBlock title={t('library.hygiene.couldntLoadTheHygieneFindings')} onRetry={() => void findings.refetch()} />
  ) : findings.isPending ? (
    <Skeleton lines={5} />
  ) : tab === 'orphan' ? (
    <Pane flush bare>
      <OrphansTable rows={orphans} onMap={setMapping} onDelete={setDeleting} />
    </Pane>
  ) : tab === 'duplicate' ? (
    groups.length ? (
      <div className="hyg-groups">
        {groups.map((g) => (
          <DuplicateGroupPane key={g.key} group={g} onDelete={setDeleting} />
        ))}
      </div>
    ) : (
      <EmptyState title={t('library.hygiene.noDuplicateFiles')} />
    )
  ) : (
    <Pane flush bare>
      <EmptyFoldersTable rows={empties} onDelete={setDeleting} />
    </Pane>
  );

  return (
    <>
      <PageHeader
        index="02"
        title={t('common.hygiene')}
        subtitle={
          lastScan ? (
            <>
              {t('library.hygiene.lastScan')} <time dateTime={lastScan}>{relativeTime(lastScan)}</time>
            </>
          ) : (
            t('library.hygiene.notScannedYet')
          )
        }
        actions={
          <Button
            variant="primary"
            loading={scan.isPending}
            onClick={() => scan.mutate(undefined, { onSuccess: () => toast.push({ tone: 'info', title: t('library.hygiene.scanStarted'), message: t('library.hygiene.findingsRefreshWhenTheScan') }) })}
          >
            {t('library.hygiene.scanNow')}
          </Button>
        }
      />
      <div className="hyg-stack">
        <Tabs
          aria-label={t('library.hygiene.findingType')}
          value={tab}
          onChange={(id) => setTab(id as TabId)}
          tabs={[
            { id: 'orphan', label: t('library.hygiene.orphans'), count: counts?.orphan },
            { id: 'duplicate', label: t('library.hygiene.duplicates'), count: counts?.duplicate },
            { id: 'empty', label: t('library.hygiene.emptyFolders'), count: counts?.empty },
          ]}
        />
        {body}
      </div>
      <MapDialog finding={mapping} onClose={() => setMapping(null)} />
      <ConfirmModal
        open={deleting !== null}
        title={deleting?.title ?? ''}
        confirmLabel={deleting?.label ?? t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          for (const f of deleting.findings) await del.mutateAsync(f.id);
          const n = deleting.findings.length;
          setDeleting(null);
          toast.push({ tone: 'ok', title: n === 1 ? t('common.deleted') : t('library.hygiene.deletedNItems', { n }) });
        }}
      >
        <p>{t('library.hygiene.filesGoToTheRecycle')}</p>
        <ul className="hyg-confirm-list">
          {deleting?.findings.map((f) => (
            <li key={f.id} className="al-num">
              {f.path}
            </li>
          ))}
        </ul>
      </ConfirmModal>
    </>
  );
}
