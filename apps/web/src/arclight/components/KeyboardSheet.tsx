import { Fragment, type ReactNode } from 'react';
import { Modal } from './Modal.js';
import { SectionLabel } from './SectionLabel.js';

export interface Shortcut {
  /** Keys pressed together, e.g. ['Ctrl', 'K'] or ['/']. */
  keys: readonly string[];
  label: ReactNode;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: readonly Shortcut[];
}

/** Mono key caps joined with "+". */
export function KeyCombo({ keys }: { keys: readonly string[] }) {
  return (
    <span className="al-kbd-combo">
      {keys.map((k, i) => (
        <Fragment key={`${k}-${i}`}>
          {i > 0 ? <span aria-hidden="true">+</span> : null}
          <kbd className="al-kbd">{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

export const DEFAULT_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: ['/'], label: 'Search' },
      { keys: ['Ctrl', 'K'], label: 'Command palette' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
      { keys: ['Esc'], label: 'Close dialog or overlay' },
    ],
  },
  {
    title: 'Lists',
    shortcuts: [
      { keys: ['↑'], label: 'Previous row' },
      { keys: ['↓'], label: 'Next row' },
      { keys: ['Enter'], label: 'Open' },
      { keys: ['Space'], label: 'Select row' },
    ],
  },
];

export interface KeyboardSheetProps {
  open: boolean;
  onClose: () => void;
  groups?: readonly ShortcutGroup[] | undefined;
}

/** Keyboard sheet: modal with a two-column mono key list. */
export function KeyboardSheet({ open, onClose, groups = DEFAULT_SHORTCUTS }: KeyboardSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size={640}>
      <div className="al-keys">
        {groups.map((g) => (
          <section key={g.title} className="al-keys__group" aria-label={g.title}>
            <SectionLabel>{g.title}</SectionLabel>
            {g.shortcuts.map((s, i) => (
              <div key={i} className="al-keys__row">
                <span>{s.label}</span>
                <KeyCombo keys={s.keys} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
