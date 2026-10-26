import type { ApprovalBudget, ApprovalWindow, MediaType, PolicyStep, RequestsSettings, UserApprovalPolicy } from '@arclight/shared';

// Approval policies (pure): size threshold, rolling budgets and weekly windows. The service
// gathers the facts (estimated size, budget usage, the user's override) and this decides
// whether a request that permissions, settings and override rules did not approve is
// approved now, held for a window, or left pending for a human.

/** 1 GB in the settings = 1 GiB of release size. */
export const GB = 1024 ** 3;

export type PolicyDecision = 'approve' | 'hold' | 'pending';

export interface BudgetUsage {
  /** Estimated bytes of approved/completed movie requests in the window (unknown sizes count 0). */
  movieBytes: number;
  /** Seasons of approved/completed series requests in the window. */
  seasons: number;
}

export interface PolicyFacts {
  settings: Pick<RequestsSettings, 'approvalBudgets' | 'approvalWindows' | 'autoApproveIfSizeBelowGb'>;
  user: { id: number; role: 'admin' | 'user'; policy: UserApprovalPolicy };
  type: MediaType;
  /** Seasons the request covers (series). */
  seasonCount: number;
  estimatedSizeBytes: number | null;
  /** Usage of a budget, excluding the request being evaluated. */
  usage: (budget: ApprovalBudget) => BudgetUsage;
  now: Date;
}

export interface PolicyResult {
  decision: PolicyDecision;
  steps: PolicyStep[];
  /** Next opening of an autoApprove window (for held requests). */
  nextWindowAt: Date | null;
}

/** True when the window covers `now` (server local time). */
export function windowActive(w: ApprovalWindow, now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();
  if (w.startHour < w.endHour) return w.days.includes(day) && hour >= w.startHour && hour < w.endHour;
  // Wraps past midnight: the evening part on the listed day, the morning part on the next.
  const yesterday = (day + 6) % 7;
  return (w.days.includes(day) && hour >= w.startHour) || (w.days.includes(yesterday) && hour < w.endHour);
}

/** Start of the next hour (local) at which one of `windows` is active and was not the hour before. */
export function nextOpening(windows: readonly ApprovalWindow[], now: Date): Date | null {
  if (windows.length === 0) return null;
  const t = new Date(now);
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    const prev = new Date(t);
    t.setHours(t.getHours() + 1);
    if (windows.some((w) => windowActive(w, t) && !windowActive(w, prev))) return new Date(t);
  }
  return null;
}

/** Whether the budget covers this request at all (scope, role, user list, media type). */
export function budgetApplies(b: ApprovalBudget, user: PolicyFacts['user'], type: MediaType): boolean {
  if (b.scope === 'user' && b.userIds && !b.userIds.includes(user.id)) return false;
  if (b.scope === 'role' && b.role && b.role !== user.role) return false;
  return type === 'movie' ? b.movieGb !== undefined || b.autoApproveUnder.sizeGb !== undefined : b.tvSeasons !== undefined || b.autoApproveUnder.sizeGb !== undefined;
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

function checkBudget(b: ApprovalBudget, f: PolicyFacts, label: string): PolicyStep {
  const size = f.estimatedSizeBytes;
  const under = b.autoApproveUnder.sizeGb;
  if (under !== undefined) {
    if (size === null) return { rule: 'budget', outcome: 'fail', message: `${label}: size unknown, needs < ${under} GB` };
    if (size >= under * GB) return { rule: 'budget', outcome: 'fail', message: `${label}: ${gb(size)} is not under ${under} GB` };
  }
  const used = f.usage(b);
  if (f.type === 'movie' && b.movieGb !== undefined) {
    if (size === null) return { rule: 'budget', outcome: 'fail', message: `${label}: size unknown` };
    if (used.movieBytes + size > b.movieGb * GB) {
      return { rule: 'budget', outcome: 'fail', message: `${label}: ${gb(used.movieBytes)} used + ${gb(size)} exceeds ${b.movieGb} GB in ${b.periodDays} days` };
    }
    return { rule: 'budget', outcome: 'pass', message: `${label}: ${gb(used.movieBytes + size)} of ${b.movieGb} GB in ${b.periodDays} days` };
  }
  if (f.type === 'series' && b.tvSeasons !== undefined) {
    if (used.seasons + f.seasonCount > b.tvSeasons) {
      return { rule: 'budget', outcome: 'fail', message: `${label}: ${used.seasons} + ${f.seasonCount} seasons exceeds ${b.tvSeasons} in ${b.periodDays} days` };
    }
    return { rule: 'budget', outcome: 'pass', message: `${label}: ${used.seasons + f.seasonCount} of ${b.tvSeasons} seasons in ${b.periodDays} days` };
  }
  return { rule: 'budget', outcome: 'pass', message: `${label}: under ${under} GB` };
}

/**
 * Decides a request that nothing else auto-approved:
 * - user override `never`: pending; `always`: eligible.
 * - eligible when the size is under the threshold or any applicable budget has room.
 * - an active hold window holds eligible requests (and, with autoApprove windows configured, all).
 * - an active autoApprove window approves; with autoApprove windows configured but none active,
 *   requests are held until one opens.
 */
export function evaluatePolicy(f: PolicyFacts): PolicyResult {
  const steps: PolicyStep[] = [];
  const windows = f.settings.approvalWindows;
  const autoWindows = windows.filter((w) => w.action === 'autoApprove');
  const nextAuto = (): Date | null => nextOpening(autoWindows, f.now);
  if (f.user.policy.autoApprove === 'never') {
    steps.push({ rule: 'userOverride', outcome: 'fail', message: 'this user is never auto-approved by policy' });
    return { decision: 'pending', steps, nextWindowAt: null };
  }
  let eligible = false;
  if (f.user.policy.autoApprove === 'always') {
    steps.push({ rule: 'userOverride', outcome: 'pass', message: 'this user is always auto-approved by policy' });
    eligible = true;
  }

  const threshold = f.user.policy.autoApproveIfSizeBelowGb ?? f.settings.autoApproveIfSizeBelowGb;
  if (!eligible && threshold !== null) {
    const source = f.user.policy.autoApproveIfSizeBelowGb !== null ? 'user limit' : 'size limit';
    if (f.estimatedSizeBytes === null) steps.push({ rule: 'size', outcome: 'skip', message: `${source} ${threshold} GB: no release size available` });
    else if (f.estimatedSizeBytes < threshold * GB) {
      steps.push({ rule: 'size', outcome: 'pass', message: `best release ${gb(f.estimatedSizeBytes)} is under the ${source} of ${threshold} GB` });
      eligible = true;
    } else steps.push({ rule: 'size', outcome: 'fail', message: `best release ${gb(f.estimatedSizeBytes)} is not under the ${source} of ${threshold} GB` });
  }

  if (!eligible) {
    const budgets = f.settings.approvalBudgets;
    if (f.user.policy.budgetExempt && budgets.length > 0) steps.push({ rule: 'budget', outcome: 'skip', message: 'this user is exempt from budgets' });
    else {
      budgets.forEach((b, i) => {
        if (eligible || !budgetApplies(b, f.user, f.type)) return;
        const step = checkBudget(b, f, `budget ${i + 1} (${b.scope})`);
        steps.push(step);
        if (step.outcome === 'pass') eligible = true;
      });
    }
  }

  const hold = windows.find((w) => w.action === 'hold' && windowActive(w, f.now));
  if (hold) {
    if (eligible || autoWindows.length > 0) {
      steps.push({ rule: 'window', outcome: 'fail', message: `a hold window (${hold.startHour}:00-${hold.endHour}:00) is active; held until it closes` });
      return { decision: 'hold', steps, nextWindowAt: autoWindows.length > 0 ? nextAuto() : nextClose(hold, f.now) };
    }
    steps.push({ rule: 'window', outcome: 'skip', message: 'a hold window is active' });
    return { decision: 'pending', steps, nextWindowAt: null };
  }
  const open = autoWindows.find((w) => windowActive(w, f.now));
  if (open) {
    steps.push({ rule: 'window', outcome: 'pass', message: `inside the auto-approve window ${open.startHour}:00-${open.endHour}:00` });
    return { decision: 'approve', steps, nextWindowAt: null };
  }
  if (eligible) return { decision: 'approve', steps, nextWindowAt: null };
  if (autoWindows.length > 0) {
    const at = nextAuto();
    steps.push({ rule: 'window', outcome: 'fail', message: `outside the auto-approve windows; held until ${at ? at.toISOString() : 'one opens'}` });
    return { decision: 'hold', steps, nextWindowAt: at };
  }
  return { decision: 'pending', steps, nextWindowAt: null };
}

function nextClose(w: ApprovalWindow, now: Date): Date | null {
  const t = new Date(now);
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    t.setHours(t.getHours() + 1);
    if (!windowActive(w, t)) return new Date(t);
  }
  return null;
}

/** Whether any policy needs a size estimate for this request (so the search is skipped otherwise). */
export function needsSizeEstimate(f: Omit<PolicyFacts, 'estimatedSizeBytes' | 'usage' | 'now' | 'seasonCount'>): boolean {
  if (f.user.policy.autoApprove !== 'inherit') return false;
  if ((f.user.policy.autoApproveIfSizeBelowGb ?? f.settings.autoApproveIfSizeBelowGb) !== null) return true;
  if (f.user.policy.budgetExempt) return false;
  return f.settings.approvalBudgets.some(
    (b) => budgetApplies(b, f.user, f.type) && (b.autoApproveUnder.sizeGb !== undefined || (f.type === 'movie' && b.movieGb !== undefined)),
  );
}
