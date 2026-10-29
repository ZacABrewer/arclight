import { useEffect, useMemo, useState } from 'react';
import type { BulkRenameRequest } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, EmptyState, ErrorBlock, Modal, Skeleton } from '../../arclight/index.js';
import { useBulkRename, useBulkRenamePreview } from '../../hooks/bulk.js';
import { t } from '../../i18n/index.js';

export interface BulkRenameDialogProps {
  /** Items to rename; null keeps the dialog closed. */
  target: { seriesIds?: number[]; movieIds?: number[] } | null;
  /** Only these media files (e.g. the selected episodes' files). */
  fileIds?: ReadonlySet<number> | undefined;
  /** "3 movies", "Season 2 · 4 episodes". */
  subject: string;
  onClose: () => void;
  onDone?: (() => void) | undefined;
}

/** Rename preview for many items: every file that would move, ticked; Rename applies the ticked ones. */
export function BulkRenameDialog({ target, fileIds, subject, onClose, onDone }: BulkRenameDialogProps) {
  const body: BulkRenameRequest | null = useMemo(
    () => (target ? { ...(target.seriesIds?.length ? { seriesIds: target.seriesIds } : {}), ...(target.movieIds?.length ? { movieIds: target.movieIds } : {}) } : null),
    [target],
  );
  const preview = useBulkRenamePreview(body);
  const rename = useBulkRename();
  const items = useMemo(() => (preview.data?.items ?? []).filter((i) => !fileIds || fileIds.has(i.mediaFileId)), [preview.data, fileIds]);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setTicked(new Set(items.map((i) => i.mediaFileId))), [items]);

  const toggle = (id: number) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      size={640}
      title={t('bulk.rename.title', { subject })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={rename.isPending}
            disabled={!body || ticked.size === 0}
            onClick={() =>
              body &&
              rename.mutate(
                { ...body, files: [...ticked] },
                {
                  onSuccess: () => {
                    onDone?.();
                    onClose();
                  },
                },
              )
            }
          >
            {t('bulk.rename.renameFiles', { count: ticked.size })}
          </Button>
        </>
      }
    >
      {preview.isPending ? (
        <Skeleton lines={4} />
      ) : preview.isError ? (
        <ErrorBlock title={t('bulk.rename.previewFailed')} onRetry={() => void preview.refetch()}>
          {errorMessage(preview.error)}
        </ErrorBlock>
      ) : items.length === 0 ? (
        <EmptyState title={t('bulk.rename.nothingToRename')}>{t('bulk.rename.nothingToRenameBody')}</EmptyState>
      ) : (
        <div className="mk-stack-sm">
          <p className="al-caption" style={{ margin: 0 }}>
            {t('bulk.rename.hint', { count: items.length })}
          </p>
          <ul className="mk-rename-list" aria-label={t('bulk.rename.files')}>
            {items.map((i) => (
              <li key={i.mediaFileId}>
                <Checkbox
                  checked={ticked.has(i.mediaFileId)}
                  onChange={() => toggle(i.mediaFileId)}
                  aria-label={t('bulk.rename.renameFile', { path: i.existingPath })}
                  label={
                    <span className="mk-rename-row">
                      <span className="al-num mk-muted">{i.existingPath}</span>
                      <span className="al-num">{i.newPath}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
          {preview.data && preview.data.failed.length > 0 ? <p className="al-field__error">{t('bulk.rename.someNotPreviewed', { count: preview.data.failed.length })}</p> : null}
        </div>
      )}
    </Modal>
  );
}
