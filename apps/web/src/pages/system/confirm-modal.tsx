import { useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button, ErrorBlock, Modal } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** Names the object: "Restore backup", "Delete backup". */
  confirmLabel: string;
  onCancel: () => void;
  /** Rejecting keeps the modal open and shows the cause inline. */
  onConfirm: () => Promise<unknown>;
}

/** 440px confirm: ghost Cancel, then the danger verb on the right. */
export function ConfirmModal({ open, title, children, confirmLabel, onCancel, onConfirm }: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onCancel();
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger-solid" loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? <ErrorBlock title={t('system.confirmModal.confirmlabelFailed', { confirmLabel })}>{error}</ErrorBlock> : null}
    </Modal>
  );
}
