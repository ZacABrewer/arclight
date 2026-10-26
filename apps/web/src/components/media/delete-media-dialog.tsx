import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal } from '../../arclight/index.js';
import './media-kit.css';
import { t } from '../../i18n/index.js';

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
      title={t('components.media.deleteMediaDialog.deleteSubject', { subject })}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={loading} onClick={() => onConfirm({ deleteFiles, addExclusion })}>
            {noun ? t('components.media.deleteMediaDialog.deleteNoun', { noun }) : t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        <p style={{ margin: 0 }}>
          {t('components.media.deleteMediaDialog.subjectWillBeRemovedFrom', { subject })}
        </p>
        <Checkbox
          tone="danger"
          label={t('components.media.deleteMediaDialog.deleteFilesAndFolderFrom')}
          hint={
            deleteFiles ? (
              <span role="alert">
                {path ? (
                  <>
                    <span className="al-num">{path}</span> {t('components.media.deleteMediaDialog.andEverythingInItWill')}
                  </>
                ) : (
                  t('components.media.deleteMediaDialog.everyFolderAndFileWill')
                )}
              </span>
            ) : undefined
          }
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        />
        <Checkbox
          label={t('components.media.deleteMediaDialog.addToImportExclusions')}
          hint={t('components.media.deleteMediaDialog.listsWillNotAddIt')}
          checked={addExclusion}
          onChange={(e) => setAddExclusion(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
