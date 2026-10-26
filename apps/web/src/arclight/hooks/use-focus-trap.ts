import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

// Only the most recently opened trap handles keys, so Esc in a popover inside a modal
// closes the popover, not the modal.
const stack: symbol[] = [];

export interface FocusTrapOptions {
  active: boolean;
  /** Called on Escape. */
  onEscape?: (() => void) | undefined;
  /** Element to focus first; defaults to the first focusable, then the container. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Put focus back where it was when the trap releases (default true). */
  restoreFocus?: boolean | undefined;
}

/**
 * Keeps Tab / Shift+Tab inside `ref` while active, routes Escape to `onEscape`, focuses the
 * first control on open and restores the previous focus on close. Used by Modal, Drawer,
 * CommandPalette and GlobalSearchOverlay.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, { active, onEscape, initialFocus, restoreFocus = true }: FocusTrapOptions): void {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const id = Symbol('trap');
    stack.push(id);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const first = initialFocus?.current ?? focusableIn(root)[0] ?? root;
    if (first === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        const handler = escapeRef.current;
        if (handler) {
          e.stopPropagation();
          e.preventDefault();
          handler();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === firstItem || current === root || !root.contains(current))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (current === lastItem || !root.contains(current))) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      if (restoreFocus && previous && document.contains(previous)) previous.focus();
    };
  }, [active, ref, initialFocus, restoreFocus]);
}
