import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@web/i18n/index';
import { tvRuntime } from './tv-runtime';

// Pieces the picker and Manage profiles share (§9 Q3–Q5): a trapped panel over the stage, the
// 4-dot PIN pad with its 0–9 keys, and the on-screen name keyboard. Panels are [data-tv-scope]:
// Back (Escape) closes them, and focus stays inside while they are open.

export const PIN_LENGTH = 4;
export const NAME_MAX = 24;
const NAME_KEYS = [...'1234567890QWERTYUIOPASDFGHJKLZXCVBNM'];

/** Focus the panel when it opens; give focus back to where it was when it closes. */
function useScopeFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.setTimeout(() => {
      const fm = tvRuntime()?.focus;
      if (fm && ref.current) fm.focusFirst(ref.current);
      else ref.current?.querySelector<HTMLElement>('[data-tv-autofocus], button')?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      const fm = tvRuntime()?.focus;
      if (before?.isConnected) {
        if (fm) fm.focus(before, undefined, true);
        else before.focus();
      } else if (fm) {
        // What had focus is gone (the screen behind changed): start from its first element.
        window.setTimeout(() => fm.focusFirst(), 0);
      }
    };
  }, [ref]);
}

/**
 * A trapped full-stage panel. Escape (the remote's Back) calls onClose. It is rendered into the
 * stage itself, so a panel opened from inside a section (the title page's "more" button) still
 * covers the whole screen rather than that section.
 */
export function TvPanel({ children, onClose, label, className = 'tv-panel' }: { children: ReactNode; onClose: () => void; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stage] = useState(() => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-tv-stage]')));
  useScopeFocus(ref);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    const el = ref.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  }, []);
  const panel = (
    <div ref={ref} className={className} data-tv-scope="" role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </div>
  );
  return stage ? createPortal(panel, stage) : panel;
}

/** Digits typed on a keyboard or the remote's number keys while `active`. */
function useTypedKeys(active: boolean, onChar: (c: string) => void, onDelete: () => void, accept: RegExp) {
  const handlers = useRef({ onChar, onDelete });
  handlers.current = { onChar, onDelete };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 && accept.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onChar(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onDelete();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, accept]);
}

const DIGIT = /^\d$/;
const NAME_CHAR = /^[\p{L}\p{N} '.-]$/u;

/**
 * The PIN pad: a title, 4 dots, a message line and the 0–9 keys. Calls onComplete with the 4 digits
 * (and clears itself when `resetKey` changes, after a wrong PIN). Disabled while `locked`.
 */
export function PinPad({ title, message, locked = false, busy = false, resetKey = 0, onComplete }: { title: string; message?: string | null; locked?: boolean; busy?: boolean; resetKey?: number; onComplete: (pin: string) => void }) {
  const t = useT();
  const [pin, setPin] = useState('');
  useEffect(() => setPin(''), [resetKey]);
  const done = useRef(onComplete);
  done.current = onComplete;
  const press = (d: string) => {
    if (locked || busy) return;
    setPin((p) => {
      if (p.length >= PIN_LENGTH) return p;
      const next = p + d;
      if (next.length === PIN_LENGTH) window.setTimeout(() => done.current(next), 0);
      return next;
    });
  };
  const del = () => setPin((p) => p.slice(0, -1));
  useTypedKeys(!locked, press, del, DIGIT);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div className="tv-pin">
      <h2 className="tv-profiles__title">{title}</h2>
      <div className="tv-pin__dots" aria-label={t('app.tv.pin.entered', { n: pin.length })}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`tv-pin__dot${i < pin.length ? ' tv-pin__dot--on' : ''}`} />
        ))}
      </div>
      <div className="tv-pin__msg" role="status">
        {message ?? ''}
      </div>
      <div className="tv-pin__pad">
        {keys.map((k, i) => (
          <button key={k} type="button" className="tv-key" data-tv-key={`pin-${k}`} data-tv-autofocus={i === 0 ? '' : undefined} disabled={locked} onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <span aria-hidden="true" />
        <button type="button" className="tv-key" data-tv-key="pin-0" disabled={locked} onClick={() => press('0')}>
          0
        </button>
        <button type="button" className="tv-key tv-key--small" data-tv-key="pin-del" onClick={del} aria-label={t('app.tv.key.delete')}>
          ⌫
        </button>
      </div>
    </div>
  );
}

/** The name keyboard: the input line, letters and digits, Space, Delete and Done. */
export function NameKeyboard({ title, initial = '', busy = false, message, onDone }: { title: string; initial?: string; busy?: boolean; message?: string | null; onDone: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState(initial);
  const type = (c: string) => setName((n) => (n + c).replace(/^\s+/, '').slice(0, NAME_MAX));
  const del = () => setName((n) => n.slice(0, -1));
  useTypedKeys(true, type, del, NAME_CHAR);
  const ok = name.trim().length > 0 && !busy;
  return (
    <div className="tv-namekb">
      <h2 className="tv-settings__title">{title}</h2>
      <div className="tv-input" role="textbox" aria-readonly="true" aria-label={title}>
        <span className="tv-input__text">{name}</span>
        <span className="tv-input__caret" aria-hidden="true" />
      </div>
      <div className="tv-keys tv-keys--name">
        {NAME_KEYS.map((k, i) => (
          <button key={k} type="button" className="tv-key" data-tv-key={`nk-${k}`} data-tv-autofocus={i === 10 ? '' : undefined} onClick={() => type(name ? k.toLowerCase() : k)}>
            {k}
          </button>
        ))}
        <button type="button" className="tv-key tv-key--wide" data-tv-key="nk-space" onClick={() => type(' ')}>
          {t('app.tv.key.space')}
        </button>
        <button type="button" className="tv-key tv-key--wide" data-tv-key="nk-del" onClick={del}>
          {t('app.tv.key.delete')}
        </button>
        <button type="button" className="tv-key tv-key--wide tv-key--primary" data-tv-key="nk-done" disabled={!ok} onClick={() => ok && onDone(name.trim())}>
          {t('app.tv.key.done')}
        </button>
      </div>
      <div className="tv-pin__msg" role="status">
        {message ?? ''}
      </div>
    </div>
  );
}
