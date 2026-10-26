import { Fragment, type ReactNode } from 'react';
import { Modal } from './Modal.js';
import { SectionLabel } from './SectionLabel.js';
import { t } from '../../i18n/index.js';

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
    get title() {
      return t('arclight.keyboardSheet.global');
    },
    shortcuts: [
      { keys: ['/'], get label() { return t('common.search'); } },
      { keys: ['Ctrl', 'K'], get label() { return t('common.commandPalette'); } },
      { keys: ['?'], get label() { return t('common.keyboardShortcuts'); } },
      { keys: ['Esc'], get label() { return t('arclight.keyboardSheet.closeDialogOrOverlay'); } },
    ],
  },
  {
    get title() {
      return t('arclight.keyboardSheet.lists');
    },
    shortcuts: [
      { keys: ['↑'], get label() { return t('arclight.keyboardSheet.previousRow'); } },
      { keys: ['↓'], get label() { return t('arclight.keyboardSheet.nextRow'); } },
      { keys: ['Enter'], get label() { return t('common.open'); } },
      { keys: ['Space'], get label() { return t('arclight.keyboardSheet.selectRow'); } },
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
    <Modal open={open} onClose={onClose} title={t('common.keyboardShortcuts')} size={640}>
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
