import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, Modal } from '../../arclight/index.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** Destructive confirms name the object: "Delete indexer", "Remove 3 items". */
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  /** Rejecting keeps the dialog open and shows the error inline. */
  onConfirm: () => Promise<unknown>;
  /** Override the message for a given api error (e.g. 409 "in use"). */
  describeError?: (err: unknown) => string | undefined;
}

/** Message for a 409 IN_USE answer, or undefined for anything else. */
export function inUseMessage(err: unknown, what: string): string | undefined {
  if (err instanceof ApiError && err.status === 409) {
    return `This ${what} is still in use and cannot be deleted. Reassign whatever uses it first. (${err.message})`;
  }
  return undefined;
}

/** 440px confirm modal: ghost Cancel, then the (danger) verb on the right. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Delete',
  danger = true,
  onCancel,
  onConfirm,
  describeError,
}: ConfirmDialogProps) {
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
      setError(null);
    } catch (err) {
      setError(describeError?.(err) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      size={440}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p className="al-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
