import type { ProfileFileStatus, ProfileFileStatusReason, ProfileMigrationQueueState, ProfileMismatchAction } from '@arclight/shared';
import { Chip } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

// Labels and chips for how a file fits its quality profile (profile migration).

export function fitStatusLabel(status: ProfileFileStatus): string {
  switch (status) {
    case 'meets':
      return t('profileMigration.status.meets');
    case 'upgradeAllowed':
      return t('profileMigration.status.upgradeAllowed');
    case 'notAllowed':
      return t('profileMigration.status.notAllowed');
  }
}

export function fitReasonLabel(reason: ProfileFileStatusReason): string {
  switch (reason) {
    case 'qualityNotAllowed':
      return t('profileMigration.reason.qualityNotAllowed');
    case 'belowMinFormatScore':
      return t('profileMigration.reason.belowMinFormatScore');
    case 'belowQualityCutoff':
      return t('profileMigration.reason.belowQualityCutoff');
    case 'belowFormatCutoff':
      return t('profileMigration.reason.belowFormatCutoff');
  }
}

export function queueStateLabel(state: ProfileMigrationQueueState): string {
  switch (state) {
    case 'queued':
      return t('profileMigration.queue.queued');
    case 'grabbed':
      return t('profileMigration.queue.grabbed');
    case 'done':
      return t('profileMigration.queue.done');
    case 'failed':
      return t('profileMigration.queue.failed');
  }
}

export function mismatchActionLabel(action: ProfileMismatchAction): string {
  switch (action) {
    case 'none':
      return t('profileMigration.action.none');
    case 'replace':
      return t('profileMigration.action.replace');
    case 'replaceIfBetter':
      return t('profileMigration.action.replaceIfBetter');
  }
}

export function ProfileFitChip({ status }: { status: ProfileFileStatus }) {
  if (status === 'notAllowed') return <Chip tone="warn">{fitStatusLabel(status)}</Chip>;
  if (status === 'upgradeAllowed')
    return (
      <Chip tone="muted" dot="ring">
        {fitStatusLabel(status)}
      </Chip>
    );
  return <Chip tone="accent">{fitStatusLabel(status)}</Chip>;
}

/** Library badge: shown on items with files their profile does not allow. */
export function ProfileMismatchBadge({ count }: { count: number }) {
  return (
    <Chip tone="warn" title={t('profileMigration.badgeTitle', { count })} data-testid="profile-mismatch-badge">
      {t('profileMigration.badge')}
    </Chip>
  );
}
