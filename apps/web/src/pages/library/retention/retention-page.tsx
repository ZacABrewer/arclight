import { useEffect, useMemo, useState } from 'react';
import type { RetentionCandidate, RetentionCandidateStatus, RetentionRule, RetentionSweepResult } from '@arclight/shared';
import { WATCH_CONDITIONS } from '@arclight/shared';
import { Banner, Button, Chip, EmptyState, ErrorBlock, KeyValue, Modal, PageHeader, Pane, Segmented, Skeleton, Table, type Column } from '../../../arclight/index.js';
import { formatBytes } from '../../../components/media/format.js';
import { useToast } from '../../../components/toast.js';
import { useTags } from '../../../hooks/library.js';
import { useCandidateAction, useDeleteRetentionRule, useRetentionCandidates, useRetentionRules, useRetentionSweep } from '../../../hooks/retention.js';
import { ConfirmModal } from '../../system/confirm-modal.js';
import { RuleEditor } from './rule-editor.js';
import { actionLabel, applyAfterText, candidateStatus, conditionLabel, scopeLabel, summarize } from './retention-model.js';
import './retention.css';
import { t } from '../../../i18n/index.js';

type StatusFilter = 'all' | RetentionCandidateStatus;

function SummaryCards({ candidates, rules }: { candidates: readonly RetentionCandidate[]; rules: readonly RetentionRule[] }) {
  const s = summarize(candidates);
  const enabled = rules.filter((r) => r.enabled).length;
  const cards = [
    { label: t('library.retention.rules'), value: String(rules.length), caption: t('library.retention.enabledEnabled', { enabled }) },
    { label: t('library.retention.waiting2'), value: String(s.pending), caption: t('library.retention.bytesToFree', { bytes: formatBytes(s.pendingBytes) }) },
    { label: t('library.retention.dueIn7Days'), value: String(s.dueSoon), caption: t('library.retention.appliedByTheNextSweeps'), warn: s.dueSoon > 0 },
    { label: t('library.retention.kept2'), value: String(s.kept), caption: s.failed ? t('library.retention.failedFailed', { failed: s.failed }) : t('library.retention.pinnedByAnAdmin'), warn: s.failed > 0 },
  ];
  return (
    <div className="ret-cards" role="list" aria-label={t('library.retention.retentionSummary')}>
      {cards.map((c) => (
        <Pane key={c.label} className="ret-card" role="listitem" aria-label={c.label.toLowerCase()}>
          <div className="al-label" data-tone={c.warn ? 'warn' : undefined}>
            {c.label}
          </div>
          <div className="ret-card__value al-num">{c.value}</div>
          <div className="al-caption">{c.caption}</div>
        </Pane>
      ))}
    </div>
  );
}

function RulesPane({ onEdit }: { onEdit: (rule: RetentionRule | null) => void }) {
  const rules = useRetentionRules();
  const tags = useTags();
  const del = useDeleteRetentionRule();
  const [deleting, setDeleting] = useState<RetentionRule | null>(null);
  const columns: Column<RetentionRule>[] = [
    { key: 'name', header: t('library.retention.rule'), cell: (r) => <span className="ret-strong">{r.name}</span>, sortValue: (r) => r.name },
    { key: 'type', header: t('common.type'), cell: (r) => (r.mediaType === 'movie' ? t('common.movies') : t('common.series')), sortValue: (r) => r.mediaType },
    {
      key: 'conditions',
      header: t('common.conditions'),
      cell: (r) => (
        <div className="ret-chips">
          {r.conditions.map((c, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <Chip key={i} tone="neutral" dot="none">
              {conditionLabel(c)}
            </Chip>
          ))}
          <span className="al-caption">{scopeLabel(r.scope, tags.data)}</span>
        </div>
      ),
    },
    { key: 'action', header: t('common.action'), cell: (r) => actionLabel(r.action) },
    { key: 'grace', header: t('library.retention.grace'), mono: true, cell: (r) => `${r.graceDays}d` },
    {
      key: 'state',
      header: t('common.state'),
      cell: (r) => (
        <div className="ret-chips">
          {r.enabled ? <Chip tone="accent">{t('common.enabled')}</Chip> : <Chip tone="muted">{t('common.disabled')}</Chip>}
          {r.dryRun ? <Chip tone="muted">{t('common.dryRun')}</Chip> : null}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <div className="ret-actions">
          <Button size="sm" variant="secondary" onClick={() => onEdit(r)} aria-label={t('library.retention.editName', { name: r.name })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(r)} aria-label={t('library.retention.deleteName', { name: r.name })}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];
  return (
    <Pane title={t('library.retention.rules2')} flush aria-label={t('library.retention.rules2')}>
      {rules.isError ? (
        <ErrorBlock title={t('library.retention.couldntLoadRetentionRules')} onRetry={() => void rules.refetch()} />
      ) : (
        <Table
          caption={t('library.retention.retentionRules')}
          columns={columns}
          rows={rules.data}
          rowKey={(r) => r.id}
          loading={rules.isPending}
          empty={
            <EmptyState title={t('library.retention.noRetentionRules')} action={<Button variant="primary" onClick={() => onEdit(null)}>{t('common.addRule')}</Button>}>
              {t('library.retention.rulesUnmonitorOrDeleteTitles')}
            </EmptyState>
          }
        />
      )}
      <ConfirmModal
        open={deleting !== null}
        title={t('library.retention.deleteValue', { value: deleting?.name ?? 'rule' })}
        confirmLabel={t('library.retention.deleteRule')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      >
        <p>{t('library.retention.itsWaitingCandidatesAreRemoved')}</p>
      </ConfirmModal>
    </Pane>
  );
}

function CandidatesPane() {
  const candidates = useRetentionCandidates();
  const act = useCandidateAction();
  const toast = useToast();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [applying, setApplying] = useState<RetentionCandidate | null>(null);
  const rows = useMemo(() => (candidates.data ?? []).filter((c) => filter === 'all' || c.status === filter), [candidates.data, filter]);

  const columns: Column<RetentionCandidate>[] = [
    {
      key: 'title',
      header: t('common.title'),
      cell: (c) => (
        <div>
          <div className="ret-strong">
            {c.title} {c.year ? <span className="al-num ret-muted">{c.year}</span> : null}
          </div>
          <div className="al-caption">
            {c.ruleName} · {actionLabel(c.action)}
          </div>
        </div>
      ),
      sortValue: (c) => c.title,
    },
    {
      key: 'reasons',
      header: t('library.retention.why'),
      cell: (c) => (
        <div className="ret-chips">
          {c.reasons.map((r) => (
            <Chip key={r} tone="neutral" dot="none">
              {r}
            </Chip>
          ))}
        </div>
      ),
    },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (c) => formatBytes(c.sizeBytes), sortValue: (c) => c.sizeBytes },
    {
      key: 'status',
      header: t('common.status'),
      cell: (c) => {
        const s = candidateStatus(c);
        return <Chip tone={s.tone}>{s.label}</Chip>;
      },
      sortValue: (c) => c.status,
    },
    { key: 'applyAfter', header: t('library.retention.applies'), mono: true, cell: (c) => applyAfterText(c), sortValue: (c) => c.applyAfter },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (c) =>
        c.status === 'applied' ? (
          <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: c.id, action: 'remove' })} aria-label={t('library.retention.removeTitle', { title: c.title })}>
            {t('common.remove')}
          </Button>
        ) : (
          <div className="ret-actions">
            {c.status !== 'kept' ? (
              <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: c.id, action: 'keep' })} aria-label={t('library.retention.keepTitle', { title: c.title })}>
                {t('common.keep')}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: c.id, action: 'remove' })} aria-label={t('library.retention.unpinTitle', { title: c.title })}>
                {t('library.retention.unpin')}
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => setApplying(c)} aria-label={t('library.retention.applyNowTitle', { title: c.title })}>
              {t('library.retention.applyNow')}
            </Button>
          </div>
        ),
    },
  ];

  return (
    <Pane
      title={t('library.retention.candidates')}
      flush
      aria-label={t('library.retention.candidates')}
      actions={
        <Segmented
          aria-label={t('library.retention.candidateStatus')}
          variant="soft"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'pending', label: t('library.retention.waiting') },
            { value: 'kept', label: t('library.retention.kept') },
            { value: 'failed', label: t('status.failed') },
            { value: 'applied', label: t('common.applied') },
          ]}
        />
      }
    >
      {candidates.isError ? (
        <ErrorBlock title={t('library.retention.couldntLoadCandidates')} onRetry={() => void candidates.refetch()} />
      ) : (
        <Table
          caption={t('library.retention.retentionCandidates')}
          density="rich"
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          loading={candidates.isPending}
          empty={<EmptyState title={t('library.retention.noCandidates')}>{t('library.retention.theDailySweepStagesTitles')}</EmptyState>}
        />
      )}
      <ConfirmModal
        open={applying !== null}
        title={t('library.retention.applyConfirmTitle', { action: applying ? actionLabel(applying.action) : t('common.apply'), title: applying?.title ?? '' })}
        confirmLabel={applying ? `${actionLabel(applying.action)} ${applying.title}` : t('library.retention.apply')}
        onCancel={() => setApplying(null)}
        onConfirm={async () => {
          if (!applying) return;
          const result = await act.mutateAsync({ id: applying.id, action: 'apply' });
          setApplying(null);
          if (result && result.status === 'failed') toast.push({ tone: 'error', title: t('library.retention.couldNotApplyToTitle', { title: result.title }), message: result.error ?? undefined });
          else toast.push({ tone: 'ok', title: `${actionLabel(applying.action)}: ${applying.title}` });
        }}
      >
        <p>{t('library.retention.thisIgnoresTheGracePeriod')}</p>
      </ConfirmModal>
    </Pane>
  );
}

export function SweepPreview({ result }: { result: RetentionSweepResult }) {
  const columns: Column<RetentionSweepResult['matches'][number]>[] = [
    { key: 'title', header: t('common.title'), cell: (m) => m.title, sortValue: (m) => m.title },
    { key: 'rule', header: t('library.retention.rule'), muted: true, cell: (m) => m.ruleName },
    { key: 'action', header: t('common.action'), cell: (m) => actionLabel(m.action) },
    { key: 'reasons', header: t('library.retention.why'), muted: true, cell: (m) => m.reasons.join(' · ') },
    { key: 'size', header: t('common.size'), mono: true, align: 'right', cell: (m) => formatBytes(m.sizeBytes), sortValue: (m) => m.sizeBytes },
  ];
  const total = result.matches.reduce((n, m) => n + m.sizeBytes, 0);
  return (
    <div className="ret-sweep">
      <KeyValue
        layout="grid"
        columns={3}
        items={[
          { label: t('library.retention.rulesEvaluated'), value: String(result.rulesEvaluated) },
          { label: t('library.retention.matches'), value: String(result.matches.length) },
          { label: t('library.retention.wouldFree'), value: formatBytes(total) },
        ]}
      />
      {result.serverErrors.map((e) => (
        <Banner key={e.server} tone="warn">
          {e.server} could not be read: {e.message}
        </Banner>
      ))}
      {result.rulesSkipped.length ? (
        <ul className="ret-skipped" aria-label={t('library.retention.skippedRules')}>
          {result.rulesSkipped.map((s) => (
            <li key={s.ruleId}>
              <span className="ret-strong">{s.ruleName}</span> {t('library.retention.skippedReason', { reason: s.reason })}
            </li>
          ))}
        </ul>
      ) : null}
      <Table caption={t('library.retention.sweepMatches')} columns={columns} rows={result.matches} rowKey={(m) => `${m.ruleId}:${m.mediaType}:${m.mediaId}`} empty={<EmptyState title={t('library.retention.nothingMatchesRightNow')} />} />
    </div>
  );
}

/** Library → Retention (/library/retention, admin). */
export function RetentionPage() {
  const rules = useRetentionRules();
  const candidates = useRetentionCandidates();
  const sweep = useRetentionSweep();
  const [editing, setEditing] = useState<{ rule: RetentionRule | null } | null>(null);
  const [preview, setPreview] = useState<RetentionSweepResult | null>(null);
  useEffect(() => {
    document.title = t('library.retention.retentionArclight');
  }, []);
  const watchRules = (rules.data ?? []).some((r) => r.enabled && r.conditions.some((c) => WATCH_CONDITIONS.has(c.type)));
  const otherNames = (rules.data ?? []).filter((r) => r.id !== editing?.rule?.id).map((r) => r.name);

  return (
    <>
      <PageHeader
        index="02"
        title={t('common.retention')}
        subtitle={watchRules ? t('library.retention.watchStateComesFromMedia') : undefined}
        actions={
          <>
            <Button variant="secondary" loading={sweep.isPending} onClick={() => sweep.mutate(true, { onSuccess: setPreview })}>
              {t('library.retention.sweepNowDryRun')}
            </Button>
            <Button variant="primary" onClick={() => setEditing({ rule: null })}>
              {t('common.addRule')}
            </Button>
          </>
        }
      />
      <div className="ret-stack">
        {rules.isSuccess && candidates.isSuccess ? <SummaryCards rules={rules.data} candidates={candidates.data} /> : <Skeleton lines={2} />}
        <RulesPane onEdit={(rule) => setEditing({ rule })} />
        <CandidatesPane />
      </div>
      <RuleEditor open={editing !== null} rule={editing?.rule ?? null} otherNames={otherNames} onClose={() => setEditing(null)} />
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        size={1100}
        title={t('library.retention.sweepPreview')}
        footer={
          <Button variant="primary" onClick={() => setPreview(null)}>
            {t('library.retention.done')}
          </Button>
        }
      >
        <p className="al-caption">{t('library.retention.aDryRunNothingWas')}</p>
        {preview ? <SweepPreview result={preview} /> : null}
      </Modal>
    </>
  );
}
