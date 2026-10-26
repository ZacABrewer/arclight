import { useState } from 'react';
import type { MediaFile } from '@media-tron/shared';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { formatBytes, formatDate, seasonLabel } from '../../components/media/format.js';
import { QualityBadge } from '../../components/media/media-ui.js';
import { Modal } from '../../components/modal.js';
import { Table, type Column } from '../../components/table.js';
import { useDeleteMediaFile } from '../../hooks/library.js';

export function MediaFilesTable({
  files,
  error,
  loading,
  mediaType,
  ownerId,
}: {
  files: MediaFile[] | undefined;
  error: unknown;
  loading: boolean;
  mediaType: 'series' | 'movie';
  ownerId: number;
}) {
  const del = useDeleteMediaFile();
  const [confirm, setConfirm] = useState<MediaFile | null>(null);

  if (error) return <ErrorView error={error} />;

  const columns: Column<MediaFile>[] = [
    { key: 'path', header: 'Relative path', sortValue: (f) => f.relativePath, cell: (f) => <code>{f.relativePath}</code> },
    ...(mediaType === 'series'
      ? [{ key: 'season', header: 'Season', sortValue: (f: MediaFile) => f.seasonNumber, cell: (f: MediaFile) => (f.seasonNumber == null ? '—' : seasonLabel(f.seasonNumber)) }]
      : []),
    { key: 'quality', header: 'Quality', sortValue: (f) => f.quality.quality.weight, cell: (f) => <QualityBadge quality={f.quality} /> },
    { key: 'languages', header: 'Languages', cell: (f) => (f.languages.length ? f.languages.join(', ') : '—') },
    { key: 'group', header: 'Group', cell: (f) => f.releaseGroup ?? '—' },
    { key: 'size', header: 'Size', sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes), align: 'right' },
    { key: 'added', header: 'Added', sortValue: (f) => f.dateAdded, cell: (f) => formatDate(f.dateAdded) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (f) => (
        <Button size="sm" variant="ghost" aria-label={`Delete ${f.relativePath}`} onClick={() => setConfirm(f)}>
          Delete
        </Button>
      ),
      align: 'right',
    },
  ];

  return (
    <>
      <Table
        columns={columns}
        rows={files}
        loading={loading}
        rowKey={(f) => f.id}
        defaultSort={{ key: 'path', direction: 'asc' }}
        empty={<EmptyState title="No files on disk" />}
        caption="Media files"
      />
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Delete file"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                confirm &&
                del.mutate({ fileId: confirm.id, mediaType, ownerId }, { onSuccess: () => setConfirm(null) })
              }
            >
              Delete from disk
            </Button>
          </>
        }
      >
        <p>
          Delete <code>{confirm?.relativePath}</code> from disk? This cannot be undone.
        </p>
      </Modal>
    </>
  );
}
