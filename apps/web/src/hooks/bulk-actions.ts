import type { QueryKey } from '@tanstack/react-query';
import type { BulkAction, BulkId, BulkResource } from '@arclight/shared';
import { bulkActionsApi } from '../api/bulk-actions.js';
import { authKeys } from '../auth/guard.js';
import { backupKeys } from './backup.js';
import { importListKeys } from './import-lists.js';
import { mediaServerKeys } from './media-servers.js';
import { queryKeys } from './query-keys.js';
import { releaseKeys } from './releases.js';
import { settingsKeys } from './settings-keys.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { transcodeKeys } from './transcode.js';
import { t } from '../i18n/index.js';

/** What each bulk resource's lists are cached under. */
const AFFECTS: Record<BulkResource, readonly QueryKey[]> = {
  indexer: [['indexers']],
  downloadclient: [settingsKeys.downloadClients],
  notification: [settingsKeys.notifications],
  importlist: [importListKeys.all],
  mediaserver: [mediaServerKeys.list],
  customformat: [settingsKeys.customFormats, settingsKeys.qualityProfiles],
  qualityprofile: [settingsKeys.qualityProfiles],
  delayprofile: [settingsKeys.delayProfiles],
  releaseprofile: [settingsKeys.releaseProfiles],
  remotepathmapping: [settingsKeys.remotePathMappings],
  user: [authKeys.all],
  backup: [backupKeys.list],
  job: [queryKeys.jobs.all],
  transcodejob: [transcodeKeys.jobsAll],
  history: [['history'], ['queue']],
  pending: [releaseKeys.pending, ['queue']],
};

export interface BulkVars {
  action: BulkAction;
  ids: readonly BulkId[];
  tags?: readonly number[] | undefined;
}

/** POST /bulk for one resource; refetches that resource's lists when it settles. */
export function useBulkAction(resource: BulkResource) {
  return useInvalidatingMutation(
    ({ action, ids, tags }: BulkVars) => bulkActionsApi.run({ resource, action, ids: [...ids], ...(tags?.length ? { tags: [...tags] } : {}) }),
    AFFECTS[resource],
    { errorTitle: t('components.bulkActions.failedTitle') },
  );
}
