import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal } from '../../arclight/index.js';
import './media-kit.css';

export interface DeleteMediaDialogProps {
  open: boolean;
  onClose: () => void;
  /** What is being deleted, e.g. "Breaking Bad" or "3 series". */
  subject: string;
  /** Object noun for the confirm button: "Delete series", "Delete movie". */
  noun?: string | undefined;
  /** Folder shown in the files warning (single item only). */
  path?: string | undefined;
  loading?: boolean;
  onConfirm: (opts: { deleteFiles: boolean; addExclusion: boolean }) => void;
}

/** Destructive confirm (Modal 440) naming the object; files option is a danger checkbox. */
export function DeleteMediaDialog({ open, onClose, subject, noun, path, loading = false, onConfirm }: DeleteMediaDialogProps) {
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
      title={`Delete ${subject}?`}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={loading} onClick={() => onConfirm({ deleteFiles, addExclusion })}>
            {noun ? `Delete ${noun}` : 'Delete'}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        <p style={{ margin: 0 }}>
          {subject} will be removed from the library.
        </p>
        <Checkbox
          tone="danger"
          label="Delete files and folder from disk"
          hint={
            deleteFiles ? (
              <span role="alert">
                {path ? (
                  <>
                    <span className="al-num">{path}</span> and everything in it will be deleted.
                  </>
                ) : (
                  'Every folder and file will be deleted from disk.'
                )}
              </span>
            ) : undefined
          }
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        />
        <Checkbox
          label="Add to import exclusions"
          hint="Lists will not add it again."
          checked={addExclusion}
          onChange={(e) => setAddExclusion(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
