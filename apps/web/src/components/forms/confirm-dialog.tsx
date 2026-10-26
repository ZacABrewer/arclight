import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button } from '../button.js';
import { Modal } from '../modal.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
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
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
