import { useState } from 'react';
import type { MediaRequest, PolicyStep, RequestPolicyExplanation } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Chip, Drawer, ErrorBlock, KeyValue, Skeleton, type ChipTone, type KeyValueItem } from '../../arclight/index.js';
import { useRequestPolicy } from '../../hooks/requests.js';
import { formatBytes, formatDateTime, formatRelative, t } from '../../i18n/index.js';
import './policy.css';

// "Held" chip on request rows (heldByPolicy) and the drawer that explains the approval
// policies from GET /request/:id/policy.

/** Plain name of each step of the auto-approval chain. */
export function policyRuleLabel(rule: PolicyStep['rule']): string {
  switch (rule) {
    case 'permission':
      return t('features.requests.policy.rule.permission');
    case 'settings':
      return t('features.requests.policy.rule.settings');
    case 'overrideRule':
      return t('features.requests.policy.rule.overrideRule');
    case 'userOverride':
      return t('features.requests.policy.rule.userOverride');
    case 'size':
      return t('features.requests.policy.rule.size');
    case 'budget':
      return t('features.requests.policy.rule.budget');
    case 'window':
      return t('features.requests.policy.rule.window');
  }
}

/** pass = cyan, fail = orange (needs attention, not an error), skip = faded. */
export function policyOutcomeTone(outcome: PolicyStep['outcome']): ChipTone {
  return outcome === 'pass' ? 'accent' : outcome === 'fail' ? 'warn' : 'muted';
}

export function policyOutcomeLabel(outcome: PolicyStep['outcome']): string {
  return outcome === 'pass' ? t('features.requests.policy.outcome.pass') : outcome === 'fail' ? t('features.requests.policy.outcome.fail') : t('features.requests.policy.outcome.skip');
}

/** One sentence: what the policies decide now, and when a held request is approved. */
export function policySummary(p: RequestPolicyExplanation, now: number = Date.now()): string {
  if (p.held && p.nextWindowAt) return t('features.requests.policy.heldUntil', { when: formatDateTime(p.nextWindowAt), relative: formatRelative(p.nextWindowAt, now) });
  if (p.held) return t('features.requests.policy.heldNoWindow');
  if (p.decision === 'approve') return t('features.requests.policy.wouldApprove');
  if (p.decision === 'hold') return t('features.requests.policy.wouldHold');
  return t('features.requests.policy.needsManualApproval');
}

function PolicyBody({ policy }: { policy: RequestPolicyExplanation }) {
  const facts: KeyValueItem[] = [
    { label: t('features.requests.policy.estimatedSize'), value: policy.estimatedSizeBytes === null ? t('features.requests.policy.unknownSize') : formatBytes(policy.estimatedSizeBytes) },
    { label: t('features.requests.policy.nextWindow'), value: policy.nextWindowAt ? formatDateTime(policy.nextWindowAt) : '—' },
  ];
  return (
    <div className="req-stack">
      <p className="req-policy-head" role="status">
        {policySummary(policy)}
      </p>
      <KeyValue items={facts} />
      <ol className="req-policy-steps" aria-label={t('features.requests.policy.steps')}>
        {policy.steps.map((s, i) => (
          <li key={`${s.rule}-${i}`} className="req-policy-step">
            <div className="req-policy-step__rule">
              <span>{policyRuleLabel(s.rule)}</span>
              <Chip tone={policyOutcomeTone(s.outcome)} dot={s.outcome === 'skip' ? 'ring' : 'fill'}>
                {policyOutcomeLabel(s.outcome)}
              </Chip>
            </div>
            <p className="req-policy-step__msg">{s.message}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Right-side drawer with the policy explanation for one request. */
export function PolicyDrawer({ request, open, onClose }: { request: Pick<MediaRequest, 'id' | 'mediaTitle'>; open: boolean; onClose: () => void }) {
  const policy = useRequestPolicy(request.id, open);
  return (
    <Drawer open={open} onClose={onClose} title={t('features.requests.policy.title', { title: request.mediaTitle })} width={520}>
      {policy.isPending ? (
        <Skeleton lines={5} />
      ) : policy.isError ? (
        <ErrorBlock title={t('features.requests.policy.couldNotLoad')} onRetry={() => void policy.refetch()}>
          {errorMessage(policy.error)}
        </ErrorBlock>
      ) : (
        <PolicyBody policy={policy.data} />
      )}
    </Drawer>
  );
}

/** "Held" chip for requests an approval window holds; a click opens the explanation. */
export function HeldChip({ request }: { request: Pick<MediaRequest, 'id' | 'mediaTitle' | 'heldByPolicy' | 'status'> }) {
  const [open, setOpen] = useState(false);
  if (!request.heldByPolicy || request.status !== 'pending') return null;
  return (
    <>
      <button type="button" className="req-held-btn" aria-label={t('features.requests.policy.whyHeld', { title: request.mediaTitle })} onClick={() => setOpen(true)}>
        <Chip tone="warn" dot="ring">
          {t('features.requests.policy.held')}
        </Chip>
      </button>
      {open ? <PolicyDrawer request={request} open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
