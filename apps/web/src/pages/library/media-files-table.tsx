import { useState } from 'react';
import type { MediaFile } from '@arclight/shared';
import { Button, EmptyState, Modal, Table, type Column } from '../../arclight/index.js';
import { formatBytes, formatDate, seasonLabel } from '../../components/media/format.js';
import { QualityLabel, QueryError } from '../../components/media/media-kit.js';
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

  if (error) return <QueryError error={error} title="Could not load files" />;

  const columns: Column<MediaFile>[] = [
    { key: 'path', header: 'Relative path', sortValue: (f) => f.relativePath, cell: (f) => f.relativePath, mono: true },
    ...(mediaType === 'series'
      ? [{ key: 'season', header: 'Season', sortValue: (f: MediaFile) => f.seasonNumber, cell: (f: MediaFile) => (f.seasonNumber == null ? '—' : seasonLabel(f.seasonNumber)), muted: true }]
      : []),
    { key: 'quality', header: 'Quality', sortValue: (f) => f.quality.quality.weight, cell: (f) => <QualityLabel quality={f.quality} /> },
    { key: 'languages', header: 'Languages', cell: (f) => (f.languages.length ? f.languages.join(', ') : '—'), mono: true },
    { key: 'group', header: 'Group', cell: (f) => f.releaseGroup ?? '—', muted: true },
    { key: 'size', header: 'Size', sortValue: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes), align: 'right', mono: true },
    { key: 'added', header: 'Added', sortValue: (f) => f.dateAdded, cell: (f) => formatDate(f.dateAdded), mono: true },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      cell: (f) => (
        <Button size="sm" variant="danger" aria-label={`Delete ${f.relativePath}`} onClick={() => setConfirm(f)}>
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
        density="dense"
        defaultSort={{ key: 'path', direction: 'asc' }}
        empty={<EmptyState title="No files on disk">Search or import to add one.</EmptyState>}
        caption="Media files"
      />
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Delete file?"
        size={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => confirm && del.mutate({ fileId: confirm.id, mediaType, ownerId }, { onSuccess: () => setConfirm(null) })}
            >
              Delete file
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          <span className="al-num">{confirm?.relativePath}</span> ({formatBytes(confirm?.sizeBytes)}) will be deleted from disk. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}
