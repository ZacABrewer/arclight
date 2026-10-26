import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx.js';
import { useFocusTrap } from '../hooks/use-focus-trap.js';
import { Icon } from './Icon.js';
import { t } from '../../i18n/index.js';

/** 440 = destructive confirm (kit default), 560 = add dialog, 640 = palette/forms, 1100 = interactive search. */
export type ModalWidth = 440 | 560 | 640 | 1100;
/** Old Modal sizes still accepted: sm → 440, md → 560, lg → 1100. */
export type ModalSize = ModalWidth | 'sm' | 'md' | 'lg';

const SIZE_MAP: Record<'sm' | 'md' | 'lg', ModalWidth> = { sm: 440, md: 560, lg: 1100 };

export function modalWidth(size: ModalSize): ModalWidth {
  return typeof size === 'number' ? size : SIZE_MAP[size];
}

function usePortalTarget(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.body;
}

/** Locks page scroll while an overlay is open. */
function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Footer slot: ghost Cancel left of the primary/danger action. */
  footer?: ReactNode | undefined;
  size?: ModalSize | undefined;
  /** Hide the ✕ close button (confirm dialogs keep Cancel in the footer). */
  hideClose?: boolean | undefined;
  /** Clicking the scrim closes (default true). */
  dismissOnScrim?: boolean | undefined;
  /** Element to focus on open (default: first focusable). */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Accessible description id override; defaults to the body. */
  className?: string | undefined;
}

/**
 * `.al-modal` — chamfered top-left with a lit edge, scrim at 72%, rezz-in. Focus is trapped,
 * Esc and the scrim close it, focus returns to the opener. Same props as the old Modal.
 */
export function Modal({ open, onClose, title, children, footer, size = 440, hideClose, dismissOnScrim = true, initialFocus, className }: ModalProps) {
  const target = usePortalTarget();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useFocusTrap(ref, { active: open, onEscape: onClose, initialFocus });
  useScrollLock(open);
  if (!open || !target) return null;
  const width = modalWidth(size);
  return createPortal(
    <div className="al-modal-layer">
      <div className="al-scrim" aria-hidden="true" onClick={dismissOnScrim ? onClose : undefined} data-testid="al-scrim" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={cx('al-modal', width !== 440 && `al-modal--${width}`, className)}
        data-width={width}
      >
        <i className="al-modal__edge" aria-hidden="true" />
        <div className="al-modal__head">
          <h2 id={titleId} className="al-modal__title">
            {title}
          </h2>
          {hideClose ? null : (
            <button type="button" className="al-btn al-btn--ghost al-btn--sm al-btn--icon al-modal__close" aria-label={t('common.close')} onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div id={bodyId} className="al-modal__body">
          {children}
        </div>
        {footer ? <div className="al-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    target,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode | undefined;
  /** Default min(520px, 100vw). */
  width?: number | undefined;
  className?: string | undefined;
}

/** `.al-drawer` — right-side sheet (episode details, history details). Slides 24px + fade. */
export function Drawer({ open, onClose, title, children, footer, width, className }: DrawerProps) {
  const target = usePortalTarget();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, { active: open, onEscape: onClose });
  useScrollLock(open);
  if (!open || !target) return null;
  return createPortal(
    <>
      <div className="al-scrim" aria-hidden="true" onClick={onClose} style={{ background: 'rgba(0,0,0,.5)' }} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx('al-drawer', className)}
        style={width ? { width: `min(${width}px, 100vw)` } : undefined}
      >
        <div className="al-drawer__head">
          <h2 id={titleId} className="al-drawer__title">
            {title}
          </h2>
          <button type="button" className="al-btn al-btn--ghost al-btn--sm al-btn--icon" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="al-drawer__body">{children}</div>
        {footer ? <div className="al-drawer__foot">{footer}</div> : null}
      </div>
    </>,
    target,
  );
}
