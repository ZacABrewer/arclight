import { useState, type ReactNode } from 'react';
import type { BulkRequestResult } from '@arclight/shared';
import type { RowKey } from '../../arclight/index.js';
import { BulkConfirmDialog, useBulkResultToast } from '../../components/bulk-actions.js';
import type { BulkAction } from '../../components/media/bulk-bar.js';
import { t } from '../../i18n/index.js';

// Bulk actions for the request lists (video and audio): approve, decline, retry and delete
// several requests at once, drawn in the shared bulk bar. The server answers per id
// (POST /request/bulk/*, /audiorequest/bulk/:action); one toast says what worked and why the
// rest did not.

export type RequestBulkVerb = 'approve' | 'decline' | 'retry' | 'delete';

const LABELS: Record<RequestBulkVerb, () => string> = {
  approve: () => t('common.approve'),
  decline: () => t('requests.decline'),
  retry: () => t('components.bulkActions.retry'),
  delete: () => t('common.delete'),
};

export function useRequestBulkActions({
  ids,
  manage,
  run,
  busy,
  nameOf,
  onDone,
}: {
  ids: ReadonlySet<RowKey>;
  /** Approve / decline / retry need Manage requests; anyone may delete what they may remove. */
  manage: boolean;
  run: (verb: RequestBulkVerb, ids: number[]) => Promise<BulkRequestResult>;
  busy?: RequestBulkVerb | null | undefined;
  nameOf: (id: number) => string | undefined;
  onDone: (ok: readonly number[]) => void;
}): { actions: BulkAction[]; dialogs: ReactNode } {
  const report = useBulkResultToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const list = [...ids].filter((id): id is number => typeof id === 'number');
  const go = async (verb: RequestBulkVerb) => {
    const res = await run(verb, list);
    report(LABELS[verb](), res, (id) => nameOf(Number(id)));
    onDone(res.ok);
  };
  const verbs: RequestBulkVerb[] = manage ? ['approve', 'decline', 'retry'] : [];
  const actions: BulkAction[] = [
    ...verbs.map((verb) => ({ id: verb, label: LABELS[verb](), loading: busy === verb, disabled: !!busy, onSelect: () => void go(verb).catch(() => undefined) })),
    { id: 'delete', label: t('common.delete'), danger: true, loading: busy === 'delete', disabled: !!busy, onSelect: () => setConfirmDelete(true) },
  ];
  const dialogs = confirmDelete ? (
    <BulkConfirmDialog
      open
      count={list.length}
      title={t('requests.bulk.deleteTitle', { count: list.length })}
      onCancel={() => setConfirmDelete(false)}
      onConfirm={async () => {
        await go('delete');
        setConfirmDelete(false);
      }}
    />
  ) : null;
  return { actions, dialogs };
}
