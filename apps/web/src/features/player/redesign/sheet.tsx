import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../arclight/cx.js';

// A phone bottom sheet (redesign spec §4.4: the avatar menu, choice pickers). Modal: Escape
// and a tap outside close it, focus moves in and returns to the opener, Tab stays inside.

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}

export function BottomSheet({ open, onClose, title, children, className }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])');
    (first ?? panel.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          items[items.length - 1]!.focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0]!.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="rd-root rd-sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={cx('rd-sheet__panel', className)} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1}>
        <span className="rd-sheet__handle" aria-hidden="true" />
        {title ? (
          <h2 id={titleId} className="rd-sheet__title">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
