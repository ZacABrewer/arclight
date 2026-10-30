import { useEffect } from 'react';
import { DEFAULT_SHORTCUTS, KeyboardSheet, useHotkey, type ShortcutGroup } from '../arclight/index.js';
import { CommandPaletteHost } from '../features/command-palette/palette.js';
import { UniversalSearch } from '../features/universal-search/universal-search.js';
import { t } from '../i18n/index.js';

export const SHELL_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    get title() {
      return t('layout.shellOverlays.global');
    },
    shortcuts: [
      { keys: ['/'], get label() { return t('common.search'); } },
      { keys: ['Ctrl', 'K'], get label() { return t('common.commandPalette'); } },
      { keys: ['?'], get label() { return t('common.keyboardShortcuts'); } },
      { keys: ['Esc'], get label() { return t('layout.shellOverlays.closeDialogOrOverlay'); } },
    ],
  },
  DEFAULT_SHORTCUTS[1]!,
];

/** Palette state the shell owns (the mobile top bar opens it too). */
export interface PaletteState {
  open: boolean;
  /** Text the palette opens with (the search hands an action over). */
  query: string;
}

/** Every global overlay plus its key binding: "/" universal search, Ctrl/Cmd+K palette, "?" shortcuts. */
export interface ShellOverlaysProps {
  isAdmin: boolean;
  search: boolean;
  setSearch: (open: boolean) => void;
  sheet: boolean;
  setSheet: (open: boolean) => void;
  palette: PaletteState;
  setPalette: (next: PaletteState | ((cur: PaletteState) => PaletteState)) => void;
}

export function ShellOverlays({ search, setSearch, sheet, setSheet, palette, setPalette }: ShellOverlaysProps) {
  useHotkey('?', () => setSheet(true));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(false);
        setPalette((p) => ({ open: !p.open, query: '' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearch, setPalette]);

  const shortcuts = () => {
    setSearch(false);
    setPalette({ open: false, query: '' });
    setSheet(true);
  };

  return (
    <>
      <UniversalSearch open={search} onClose={() => setSearch(false)} openPalette={(query) => setPalette({ open: true, query })} onShortcuts={shortcuts} />
      <CommandPaletteHost open={palette.open} initialQuery={palette.query} onClose={() => setPalette({ open: false, query: '' })} onShortcuts={shortcuts} />
      <KeyboardSheet open={sheet} onClose={() => setSheet(false)} groups={SHELL_SHORTCUTS} />
    </>
  );
}
