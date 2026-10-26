import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApprovalBudget, type ApprovalWindow, type PublicPortalSettings, type RequestsSettings, type User } from '@arclight/shared';
import { usersApi } from '../../../api/auth.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, EmptyState, Field, FormRow, Input, Modal, Select, Table, Textarea, Toggle, buttonClass, type Column } from '../../../arclight/index.js';
import { getActiveUiPreferences } from '../../../lib/ui-preferences.js';
import { hourLabel, t, weekdayNames } from '../../../i18n/index.js';
import { EditorFooter, SettingsSection } from '../shared.js';

// Settings → Requests: approval policies (size limit, rolling budgets, weekly windows) and the
// public request portal. Both edit the RequestsSettings draft of the page; the page's save
// bar sends the whole section (PUT /settings/requests).

type SetSetting = <K extends keyof RequestsSettings>(key: K, v: RequestsSettings[K]) => void;

/** "12.5" → 12.5; blank or junk → null. */
export function parseGb(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---- windows -----------------------------------------------------------------------------

export function newWindow(): ApprovalWindow {
  return { days: [1, 2, 3, 4, 5], startHour: 22, endHour: 6, action: 'autoApprove' };
}

/** Add or remove a weekday (0 = Sunday), keeping the list sorted. */
export function toggleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}

/** "Mon, Tue · 22:00–06:00 next day · Auto-approve". */
export function windowSummary(w: ApprovalWindow, format = getActiveUiPreferences().timeFormat): string {
  const names = weekdayNames(0, 'short');
  const days = w.days.length === 7 ? t('settings.requests.policies.everyDay') : w.days.map((d) => names[d] ?? String(d)).join(', ');
  const wraps = w.endHour <= w.startHour;
  const range = t('settings.requests.policies.hourRange', { start: hourLabel(w.startHour, format), end: hourLabel(w.endHour, format), wraps: wraps ? 'yes' : 'no' });
  const action = w.action === 'autoApprove' ? t('settings.requests.policies.actionAutoApprove') : t('settings.requests.policies.actionHold');
  return `${days} · ${range} · ${action}`;
}

/** Problems that would make PUT /settings/requests answer 400 (the save bar stays blocked). */
export function policyErrors(value: Pick<RequestsSettings, 'approvalWindows'>): string[] {
  return value.approvalWindows.some((w) => w.days.length === 0) ? [t('settings.requests.policies.windowNeedsDay')] : [];
}

// ---- budgets -----------------------------------------------------------------------------

export interface BudgetDraft {
  scope: ApprovalBudget['scope'];
  role: '' | 'admin' | 'user';
  userIds: number[];
  movieGb: string;
  tvSeasons: string;
  periodDays: string;
  underGb: string;
}

export function toBudgetDraft(b: ApprovalBudget | null): BudgetDraft {
  return {
    scope: b?.scope ?? 'user',
    role: b?.role ?? '',
    userIds: b?.userIds ?? [],
    movieGb: b?.movieGb === undefined ? '' : String(b.movieGb),
    tvSeasons: b?.tvSeasons === undefined ? '' : String(b.tvSeasons),
    periodDays: String(b?.periodDays ?? 30),
    underGb: b?.autoApproveUnder.sizeGb === undefined ? '' : String(b.autoApproveUnder.sizeGb),
  };
}

/** Draft → contract budget, or the first problem to show. Blank limits are left out. */
export function fromBudgetDraft(d: BudgetDraft): { budget: ApprovalBudget } | { error: string } {
  const movieGb = parseGb(d.movieGb);
  const tvSeasons = parseGb(d.tvSeasons);
  if (movieGb === null && tvSeasons === null) return { error: t('settings.requests.policies.budgetNeedsLimit') };
  const periodDays = Number(d.periodDays);
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 365) return { error: t('settings.requests.policies.budgetPeriodRange') };
  const underGb = parseGb(d.underGb);
  const raw = {
    scope: d.scope,
    ...(d.scope === 'role' && d.role ? { role: d.role } : {}),
    ...(d.scope === 'user' && d.userIds.length ? { userIds: d.userIds } : {}),
    ...(movieGb !== null ? { movieGb } : {}),
    ...(tvSeasons !== null ? { tvSeasons: Math.floor(tvSeasons) } : {}),
    periodDays,
    autoApproveUnder: underGb !== null ? { sizeGb: underGb } : {},
  };
  const parsed = ApprovalBudget.safeParse(raw);
  return parsed.success ? { budget: parsed.data } : { error: parsed.error.issues[0]?.message ?? t('settings.requests.policies.budgetInvalid') };
}

/** Who a budget covers: "Each user", "amy, bob", "Each role", "Role user", "Everyone (shared)". */
export function budgetScopeLabel(b: ApprovalBudget, users: readonly Pick<User, 'id' | 'username' | 'displayName'>[] = []): string {
  if (b.scope === 'all') return t('settings.requests.policies.scopeAll');
  if (b.scope === 'role') return b.role ? t('settings.requests.policies.scopeRoleOne', { role: b.role }) : t('settings.requests.policies.scopeRole');
  if (!b.userIds?.length) return t('settings.requests.policies.scopeUser');
  const names = b.userIds.map((id) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.displayName ?? u.username) : `#${id}`;
  });
  return names.join(', ');
}

/** "200 GB of movies · 10 seasons" for the budgets table. */
export function budgetLimits(b: ApprovalBudget): string {
  const parts = [
    b.movieGb !== undefined ? t('settings.requests.policies.limitMovies', { gb: b.movieGb }) : null,
    b.tvSeasons !== undefined ? t('settings.requests.policies.limitSeasons', { count: b.tvSeasons }) : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' · ') || '—';
}

// ---- sections ----------------------------------------------------------------------------

export function ApprovalPolicySections({ value, set }: { value: RequestsSettings; set: SetSetting }) {
  const sizeId = useId();
  return (
    <>
      <SettingsSection label={t('settings.requests.policies.sizeSection')}>
        <FormRow label={t('settings.requests.policies.sizeLimit')} htmlFor={sizeId} caption={t('settings.requests.policies.sizeLimitCaption')}>
          <Input
            id={sizeId}
            type="number"
            min={0}
            step="any"
            mono
            end="GB"
            placeholder={t('common.off')}
            value={value.autoApproveIfSizeBelowGb ?? ''}
            onChange={(e) => set('autoApproveIfSizeBelowGb', parseGb(e.currentTarget.value))}
          />
        </FormRow>
      </SettingsSection>
      <BudgetsSection budgets={value.approvalBudgets} onChange={(v) => set('approvalBudgets', v)} />
      <WindowsSection windows={value.approvalWindows} onChange={(v) => set('approvalWindows', v)} />
    </>
  );
}

function useUserList() {
  return useQuery({ queryKey: authKeys.users, queryFn: usersApi.list, retry: false });
}

function BudgetsSection({ budgets, onChange }: { budgets: ApprovalBudget[]; onChange: (v: ApprovalBudget[]) => void }) {
  const users = useUserList();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const rows = budgets.map((b, index) => ({ b, index }));
  const columns: Array<Column<{ b: ApprovalBudget; index: number }>> = [
    { key: 'scope', header: t('settings.requests.policies.appliesTo'), cell: ({ b }) => budgetScopeLabel(b, users.data) },
    { key: 'limits', header: t('settings.requests.policies.limits'), mono: true, cell: ({ b }) => budgetLimits(b) },
    { key: 'period', header: t('settings.requests.policies.period'), mono: true, cell: ({ b }) => t('settings.requests.policies.periodDays', { count: b.periodDays }) },
    {
      key: 'under',
      header: t('settings.requests.policies.onlyUnder'),
      mono: true,
      muted: true,
      cell: ({ b }) => (b.autoApproveUnder.sizeGb !== undefined ? `${b.autoApproveUnder.sizeGb} GB` : '—'),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: ({ index }) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" aria-label={t('settings.requests.policies.editBudget', { n: index + 1 })} onClick={() => setEditing(index)}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="danger" aria-label={t('settings.requests.policies.removeBudget', { n: index + 1 })} onClick={() => onChange(budgets.filter((_, i) => i !== index))}>
            {t('common.remove')}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <SettingsSection
      label={t('settings.requests.policies.budgets')}
      count={budgets.length}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          {t('settings.requests.policies.addBudget')}
        </Button>
      }
    >
      {budgets.length === 0 ? (
        <EmptyState title={t('settings.requests.policies.noBudgets')}>{t('settings.requests.policies.noBudgetsHelp')}</EmptyState>
      ) : (
        <Table caption={t('settings.requests.policies.budgets')} density="dense" columns={columns} rows={rows} rowKey={(r) => r.index} />
      )}
      {editing !== null ? (
        <BudgetEditor
          budget={editing === 'new' ? null : (budgets[editing] ?? null)}
          users={users.data ?? []}
          onClose={() => setEditing(null)}
          onSave={(b) => {
            onChange(editing === 'new' ? [...budgets, b] : budgets.map((x, i) => (i === editing ? b : x)));
            setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function BudgetEditor({ budget, users, onClose, onSave }: { budget: ApprovalBudget | null; users: readonly User[]; onClose: () => void; onSave: (b: ApprovalBudget) => void }) {
  const [d, setD] = useState<BudgetDraft>(() => toBudgetDraft(budget));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BudgetDraft>(k: K, v: BudgetDraft[K]) => setD({ ...d, [k]: v });
  const submit = () => {
    const res = fromBudgetDraft(d);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    onSave(res.budget);
  };
  return (
    <Modal
      open
      size={640}
      onClose={onClose}
      title={budget ? t('settings.requests.policies.editBudgetTitle') : t('settings.requests.policies.addBudget')}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saveLabel={t('settings.requests.policies.keepBudget')} />}
    >
      <div className="al-editor-stack">
        <div className="al-field-grid al-field-grid--2">
          <Field label={t('settings.requests.policies.scope')}>
            <Select
              aria-label={t('settings.requests.policies.scope')}
              value={d.scope}
              onChange={(e) => set('scope', e.currentTarget.value as BudgetDraft['scope'])}
              options={[
                { value: 'user', label: t('settings.requests.policies.scopeUser') },
                { value: 'role', label: t('settings.requests.policies.scopeRole') },
                { value: 'all', label: t('settings.requests.policies.scopeAll') },
              ]}
            />
          </Field>
          {d.scope === 'role' ? (
            <Field label={t('common.role')}>
              <Select
                aria-label={t('common.role')}
                value={d.role}
                onChange={(e) => set('role', e.currentTarget.value as BudgetDraft['role'])}
                options={[
                  { value: '', label: t('settings.requests.policies.everyRole') },
                  { value: 'user', label: t('common.user') },
                  { value: 'admin', label: t('common.admin') },
                ]}
              />
            </Field>
          ) : null}
        </div>
        {d.scope === 'user' ? (
          <FormRow label={t('common.users')} caption={t('settings.requests.policies.usersCaption')}>
            <div className="al-tag-toggles" role="group" aria-label={t('common.users')}>
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="al-tag al-tag-toggle"
                  aria-pressed={d.userIds.includes(u.id)}
                  onClick={() => set('userIds', d.userIds.includes(u.id) ? d.userIds.filter((x) => x !== u.id) : [...d.userIds, u.id])}
                >
                  {u.displayName ?? u.username}
                </button>
              ))}
            </div>
          </FormRow>
        ) : null}
        <div className="al-field-grid al-field-grid--2">
          <Field label={t('settings.requests.policies.movieGb')} hint={t('settings.requests.policies.movieGbHint')}>
            <Input type="number" min={0} step="any" mono end="GB" aria-label={t('settings.requests.policies.movieGb')} value={d.movieGb} onChange={(e) => set('movieGb', e.currentTarget.value)} />
          </Field>
          <Field label={t('settings.requests.policies.tvSeasons')} hint={t('settings.requests.policies.tvSeasonsHint')}>
            <Input type="number" min={0} step={1} mono aria-label={t('settings.requests.policies.tvSeasons')} value={d.tvSeasons} onChange={(e) => set('tvSeasons', e.currentTarget.value)} />
          </Field>
          <Field label={t('settings.requests.policies.period')} hint={t('settings.requests.policies.periodHint')}>
            <Input type="number" min={1} max={365} step={1} mono end="d" aria-label={t('settings.requests.policies.period')} value={d.periodDays} onChange={(e) => set('periodDays', e.currentTarget.value)} />
          </Field>
          <Field label={t('settings.requests.policies.onlyUnder')} hint={t('settings.requests.policies.onlyUnderHint')}>
            <Input type="number" min={0} step="any" mono end="GB" aria-label={t('settings.requests.policies.onlyUnder')} value={d.underGb} onChange={(e) => set('underGb', e.currentTarget.value)} />
          </Field>
        </div>
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function WindowsSection({ windows, onChange }: { windows: ApprovalWindow[]; onChange: (v: ApprovalWindow[]) => void }) {
  const format = getActiveUiPreferences().timeFormat;
  const names = weekdayNames(0, 'short');
  const firstDay = getActiveUiPreferences().firstDayOfWeek;
  const dayOrder = Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
  const startHours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h, format) }));
  const endHours = Array.from({ length: 25 }, (_, h) => ({ value: String(h), label: hourLabel(h, format) })).slice(1);
  const update = (i: number, patch: Partial<ApprovalWindow>) => onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <SettingsSection
      label={t('settings.requests.policies.windows')}
      count={windows.length}
      action={
        <Button size="sm" variant="secondary" onClick={() => onChange([...windows, newWindow()])}>
          {t('settings.requests.policies.addWindow')}
        </Button>
      }
    >
      <p className="al-caption" style={{ margin: '0 0 12px' }}>
        {t('settings.requests.policies.windowsHelp')}
      </p>
      {windows.length === 0 ? null : (
        <ol className="al-order-list" aria-label={t('settings.requests.policies.windows')}>
          {windows.map((w, i) => (
            <li key={i} className="al-window-row" aria-label={t('settings.requests.policies.windowN', { n: i + 1 })}>
              <div className="al-tag-toggles" role="group" aria-label={t('settings.requests.policies.days')}>
                {dayOrder.map((d) => (
                  <button key={d} type="button" className="al-tag al-tag-toggle" aria-pressed={w.days.includes(d)} onClick={() => update(i, { days: toggleDay(w.days, d) })}>
                    {names[d]}
                  </button>
                ))}
              </div>
              <div className="al-window-row__controls">
                <Select aria-label={t('settings.requests.policies.from')} value={String(w.startHour)} onChange={(e) => update(i, { startHour: Number(e.currentTarget.value) })} options={startHours} />
                <Select aria-label={t('settings.requests.policies.until')} value={String(w.endHour)} onChange={(e) => update(i, { endHour: Number(e.currentTarget.value) })} options={endHours} />
                <Select
                  aria-label={t('settings.requests.policies.action')}
                  value={w.action}
                  onChange={(e) => update(i, { action: e.currentTarget.value as ApprovalWindow['action'] })}
                  options={[
                    { value: 'autoApprove', label: t('settings.requests.policies.actionAutoApprove') },
                    { value: 'hold', label: t('settings.requests.policies.actionHold') },
                  ]}
                />
                <Button size="sm" variant="danger" aria-label={t('settings.requests.policies.removeWindow', { n: i + 1 })} onClick={() => onChange(windows.filter((_, j) => j !== i))}>
                  {t('common.remove')}
                </Button>
              </div>
              <p className="al-caption al-num al-window-row__summary">{w.days.length ? windowSummary(w, format) : t('settings.requests.policies.windowNeedsDay')}</p>
            </li>
          ))}
        </ol>
      )}
    </SettingsSection>
  );
}

// ---- public portal -----------------------------------------------------------------------

export function PublicPortalSection({ value, onChange }: { value: PublicPortalSettings; onChange: (v: PublicPortalSettings) => void }) {
  const messageId = useId();
  return (
    <SettingsSection
      label={t('settings.requests.portal.section')}
      action={
        <Link to="/portal" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          {t('settings.requests.portal.open')}
        </Link>
      }
    >
      <FormRow label={t('settings.requests.portal.enabled')} captionInline caption={t('settings.requests.portal.enabledCaption')}>
        <Toggle aria-label={t('settings.requests.portal.enabled')} checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label={t('settings.requests.portal.anonymousDiscover')} captionInline caption={t('settings.requests.portal.anonymousDiscoverCaption')}>
        <Toggle
          aria-label={t('settings.requests.portal.anonymousDiscover')}
          disabled={!value.enabled}
          checked={value.allowAnonymousDiscover}
          onChange={(e) => onChange({ ...value, allowAnonymousDiscover: e.currentTarget.checked })}
        />
      </FormRow>
      <FormRow label={t('settings.requests.portal.message')} htmlFor={messageId} caption={t('settings.requests.portal.messageCaption', { count: value.message.length })}>
        <Textarea id={messageId} rows={4} maxLength={2000} value={value.message} onChange={(e) => onChange({ ...value, message: e.currentTarget.value })} />
      </FormRow>
    </SettingsSection>
  );
}
