import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Footer slot, typically Cancel / Save buttons. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Native <dialog> modal: focus trapping, Esc and the backdrop come from the platform.
 * Clicking the backdrop closes; Esc fires `cancel`, which we route to onClose.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', ''); // jsdom / very old browsers
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('modal', `modal-${size}`)}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="modal-content">
          <header className="modal-header">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer ? <footer className="modal-footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
