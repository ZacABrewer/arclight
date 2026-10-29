import { z } from 'zod';

// Bulk actions over the settings, activity and system lists (POST /bulk). One request names a
// resource, an action and the selected ids; the server runs the action on each id through the
// same route a single-item change uses (same validation, in-use guards and audit) and answers
// per id, so one failure never hides the others. (Library and Wanted bulk commands: bulk.ts.)

/** Lists that take bulk actions through POST /bulk. */
export const BulkResource = z.enum([
  'indexer',
  'downloadclient',
  'notification',
  'importlist',
  'mediaserver',
  'customformat',
  'qualityprofile',
  'delayprofile',
  'releaseprofile',
  'remotepathmapping',
  'user',
  'backup',
  'job',
  'transcodejob',
  'history',
  'pending',
]);
export type BulkResource = z.infer<typeof BulkResource>;

export const BulkAction = z.enum(['enable', 'disable', 'test', 'delete', 'addTags', 'removeTags', 'cancel', 'markFailed', 'redownload', 'grab', 'run']);
export type BulkAction = z.infer<typeof BulkAction>;

/** Which actions each resource takes. Anything else answers 400. */
export const BULK_ACTIONS: Readonly<Record<BulkResource, readonly BulkAction[]>> = {
  indexer: ['enable', 'disable', 'test', 'delete', 'addTags', 'removeTags'],
  downloadclient: ['enable', 'disable', 'test', 'delete', 'addTags', 'removeTags'],
  notification: ['enable', 'disable', 'test', 'delete', 'addTags', 'removeTags'],
  importlist: ['enable', 'disable', 'test', 'delete', 'addTags', 'removeTags'],
  mediaserver: ['enable', 'disable', 'test', 'delete'],
  customformat: ['delete'],
  qualityprofile: ['delete'],
  delayprofile: ['delete'],
  releaseprofile: ['enable', 'disable', 'delete', 'addTags', 'removeTags'],
  remotepathmapping: ['delete'],
  user: ['delete'],
  backup: ['delete'],
  job: ['run'],
  transcodejob: ['cancel'],
  history: ['markFailed', 'redownload'],
  pending: ['grab', 'delete'],
};

/** Tag edits need the tag ids. */
export const BULK_TAG_ACTIONS: readonly BulkAction[] = ['addTags', 'removeTags'];

/** Row ids are numbers for most lists; media servers and backups use strings, jobs their name. */
export const BulkId = z.union([z.number().int(), z.string().min(1).max(200)]);
export type BulkId = z.infer<typeof BulkId>;

export const BULK_MAX_IDS = 500;

export const BulkActionRequest = z
  .object({
    resource: BulkResource,
    action: BulkAction,
    ids: z.array(BulkId).min(1).max(BULK_MAX_IDS),
    /** addTags / removeTags: the tag ids to add or remove. */
    tags: z.array(z.number().int().positive()).min(1).max(100).optional(),
  })
  .superRefine((req, ctx) => {
    if (!BULK_ACTIONS[req.resource].includes(req.action)) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: `${req.resource} does not take the bulk action ${req.action}` });
    }
    if (BULK_TAG_ACTIONS.includes(req.action) && !req.tags?.length) {
      ctx.addIssue({ code: 'custom', path: ['tags'], message: `${req.action} needs at least one tag` });
    }
  });
export type BulkActionRequest = z.infer<typeof BulkActionRequest>;

export const BulkFailure = z.object({ id: BulkId, error: z.string(), code: z.string().optional() });
export type BulkFailure = z.infer<typeof BulkFailure>;

/**
 * Same shape as the request bulk actions (POST /request/bulk/*): ids that worked, and the
 * ids that did not with the reason. A test that ran but failed is a failure.
 */
export const BulkActionResult = z.object({
  ok: z.array(BulkId),
  failed: z.array(BulkFailure),
});
export type BulkActionResult = z.infer<typeof BulkActionResult>;
