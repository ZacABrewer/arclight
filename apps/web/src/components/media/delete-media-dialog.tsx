import { useEffect, useState } from 'react';
import { Button } from '../button.js';
import { Modal } from '../modal.js';
import './media.css';

export interface DeleteMediaDialogProps {
  open: boolean;
  onClose: () => void;
  /** What is being deleted, e.g. "Breaking Bad" or "3 series". */
  subject: string;
  /** Folder shown in the files warning (single item only). */
  path?: string | undefined;
  loading?: boolean;
  onConfirm: (opts: { deleteFiles: boolean; addExclusion: boolean }) => void;
}

export function DeleteMediaDialog({ open, onClose, subject, path, loading = false, onConfirm }: DeleteMediaDialogProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [addExclusion, setAddExclusion] = useState(false);

  useEffect(() => {
    if (open) {
      setDeleteFiles(false);
      setAddExclusion(false);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Delete ${subject}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={loading} onClick={() => onConfirm({ deleteFiles, addExclusion })}>
            Delete
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <strong>{subject}</strong> from the library?
        </p>
        <label className="check-row">
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          Delete files and folder from disk
        </label>
        {deleteFiles ? (
          <p className="danger-text" role="alert">
            {path ? (
              <>
                The folder <code>{path}</code> and everything in it will be deleted.
              </>
            ) : (
              'Every folder and file will be deleted from disk.'
            )}
          </p>
        ) : null}
        <label className="check-row">
          <input type="checkbox" checked={addExclusion} onChange={(e) => setAddExclusion(e.target.checked)} />
          Add to import exclusions (prevent re-adding from lists)
        </label>
      </div>
    </Modal>
  );
}
