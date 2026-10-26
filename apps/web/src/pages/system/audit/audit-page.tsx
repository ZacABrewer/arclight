import { useEffect, useId, useState } from 'react';
import type { AuditEvent } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { auditApi, type AuditFilter } from '../../../api/audit.js';
import { Chip, EmptyState, ErrorBlock, FilterBar, Input, LinkButton, Pane, Paginator, Select, Table, Toggle, type ChipTone, type Column } from '../../../arclight/index.js';
import { useAuditActions, useAuditPage, useAuditSettings, useSaveAuditSettings } from '../../../hooks/audit.js';
import { relativeTime } from '../../../lib/format.js';
import { formatStamp } from '../format.js';
import { SystemHeader } from '../system-header.js';
import './audit.css';
import { t } from '../../../i18n/index.js';

export const AUDIT_PAGE_SIZE = 50;

/** Draft filter as typed in the bar: dates are YYYY-MM-DD. */
export interface AuditFilterDraft {
  user: string;
  action: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTER: AuditFilterDraft = { user: '', action: '', from: '', to: '' };

/**
 * Bar values → api filter. `from` is the start of that day (inclusive) and `to` the start of
 * the day after (the api's `to` is exclusive), both in UTC ISO.
 */
export function toAuditFilter(draft: AuditFilterDraft): AuditFilter {
  const day = (d: string, plus = 0) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
    const date = new Date(`${d}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + plus);
    return date.toISOString();
  };
  return {
    ...(draft.user.trim() ? { user: draft.user.trim() } : {}),
    ...(draft.action ? { action: draft.action } : {}),
    ...(day(draft.from) ? { from: day(draft.from) } : {}),
    ...(day(draft.to, 1) ? { to: day(draft.to, 1) } : {}),
  };
}

export function activeAuditFilters(draft: AuditFilterDraft): number {
  return Object.values(draft).filter((v) => v.trim() !== '').length;
}

/** Tone by outcome: failed logins and error responses read as danger, deletes as warn. */
export function auditTone(e: Pick<AuditEvent, 'action' | 'statusCode'>): ChipTone {
  if (e.action === 'login.failed' || (e.statusCode !== null && e.statusCode >= 400)) return 'danger';
  if (e.action.endsWith('.delete')) return 'warn';
  return 'neutral';
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const item = setTimeout(() => setV(value), ms);
    return () => clearTimeout(item);
  }, [value, ms]);
  return v;
}

function RetentionLine() {
  const id = useId();
  const settings = useAuditSettings();
  const save = useSaveAuditSettings();
  if (!settings.data) return null;
  const s = settings.data;
  return (
    <div className="al-audit__settings">
      <Toggle id={id} label={t('system.audit.recordChanges')} checked={s.enabled} disabled={save.isPending} onChange={(e) => save.mutate({ ...s, enabled: e.currentTarget.checked })} />
      <span className="al-caption">
        {t('system.audit.keptFor')} <span className="al-num">{s.retentionDays === 0 ? t('system.audit.ever') : t('system.audit.retentiondaysD', { retentionDays: s.retentionDays })}</span>
      </span>
    </div>
  );
}

/** System → Audit (/system/audit): who changed what, filterable, paged, exportable as CSV. */
export function SystemAuditPage() {
  const [draft, setDraft] = useState<AuditFilterDraft>(EMPTY_AUDIT_FILTER);
  const [page, setPage] = useState(1);
  const debouncedUser = useDebounced(draft.user);
  const filter = toAuditFilter({ ...draft, user: debouncedUser });
  const audit = useAuditPage(filter, page, AUDIT_PAGE_SIZE);
  const actions = useAuditActions();
  const set = (k: keyof AuditFilterDraft, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setPage(1);
  };
  const pageCount = audit.data ? Math.max(1, Math.ceil(audit.data.totalRecords / AUDIT_PAGE_SIZE)) : 1;

  const columns: Column<AuditEvent>[] = [
    {
      key: 'time',
      header: t('common.time'),
      width: '170px',
      mono: true,
      cell: (e) => (
        <time dateTime={e.time} title={relativeTime(e.time)}>
          {formatStamp(e.time)}
        </time>
      ),
    },
    { key: 'user', header: t('common.user'), cell: (e) => e.username ?? (e.userId !== null ? `#${e.userId}` : <span className="al-caption">{t('system.audit.apiKeyLocal')}</span>) },
    { key: 'ip', header: t('system.audit.ip'), mono: true, muted: true, cell: (e) => e.ip ?? '—' },
    { key: 'action', header: t('common.action'), cell: (e) => <Chip tone={auditTone(e)}>{e.action}</Chip> },
    { key: 'target', header: t('system.audit.target'), cell: (e) => e.target ?? '—' },
    { key: 'route', header: t('common.request'), mono: true, muted: true, cell: (e) => (e.method || e.route ? `${e.method ?? ''} ${e.route ?? ''}`.trim() : '—') },
    { key: 'status', header: t('common.status'), mono: true, align: 'right', cell: (e) => (e.statusCode === null ? '—' : String(e.statusCode)) },
  ];

  return (
    <>
      <SystemHeader
        title={t('system.audit.audit')}
        subtitle={t('system.audit.everyChangeMadeThroughThe')}
        actions={
          <LinkButton variant="secondary" href={auditApi.exportUrl(filter)} download="arclight-audit.csv">
            {t('system.audit.exportCsv')}
          </LinkButton>
        }
      />
      <div className="sys-stack">
        <FilterBar onClear={() => (setDraft(EMPTY_AUDIT_FILTER), setPage(1))} activeCount={activeAuditFilters(draft)} end={<RetentionLine />} className="al-audit__filters">
          <Input aria-label={t('common.user')} placeholder={t('system.audit.userNameOrId')} value={draft.user} onChange={(e) => set('user', e.currentTarget.value)} className="al-audit__user" />
          <Select
            aria-label={t('common.action')}
            value={draft.action}
            onChange={(e) => set('action', e.currentTarget.value)}
            options={[{ value: '', label: t('system.audit.allActions') }, ...(actions.data ?? []).map((a) => ({ value: a, label: a }))]}
          />
          <label className="al-audit__date">
            <span className="al-label">{t('system.audit.from')}</span>
            <Input type="date" mono aria-label={t('system.audit.from')} value={draft.from} max={draft.to || undefined} onChange={(e) => set('from', e.currentTarget.value)} />
          </label>
          <label className="al-audit__date">
            <span className="al-label">{t('system.audit.to')}</span>
            <Input type="date" mono aria-label={t('system.audit.to')} value={draft.to} min={draft.from || undefined} onChange={(e) => set('to', e.currentTarget.value)} />
          </label>
        </FilterBar>
        <Pane flush>
          {audit.isError ? (
            <ErrorBlock title={t('system.audit.couldntLoadTheAuditLog')} onRetry={() => void audit.refetch()}>
              {errorMessage(audit.error)}
            </ErrorBlock>
          ) : (
            <div className="al-audit__table">
              <Table
                caption={t('system.audit.auditEvents')}
                columns={columns}
                rows={audit.data?.records}
                rowKey={(e) => e.id}
                loading={audit.isPending}
                empty={<EmptyState title={activeAuditFilters(draft) ? t('system.audit.noEventsMatchTheseFilters') : t('system.audit.noEventsRecordedYet')} />}
              />
            </div>
          )}
          <div className="al-audit__footer">
            <span className="al-caption">
              <span className="al-num">{audit.data?.totalRecords ?? 0}</span> {t('system.audit.events')}
            </span>
            <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
          </div>
        </Pane>
      </div>
    </>
  );
}
