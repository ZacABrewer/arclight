import { useEffect, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileSystemEntry } from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { filesystemApi } from '../../api/filesystem.js';
import { Button, Icon, Input, Modal, PathPickerField, type PathEntry } from '../../arclight/index.js';
import { breadcrumbs, isValidFolderName } from './path-utils.js';
import './path-picker.css';
import { t } from '../../i18n/index.js';

/** Enter runs `action` without submitting any enclosing form. */
function onEnter(e: KeyboardEvent<HTMLInputElement>, action: () => void) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  action();
}

export const filesystemKey = (path: string, includeFiles: boolean) => ['filesystem', path, includeFiles] as const;

export interface PathPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  /** Where to start; empty or missing starts at the roots. */
  initialPath?: string | undefined;
  title?: string;
  /** Show files under the folders. */
  includeFiles?: boolean;
  /** Clicking a file selects it (implies includeFiles). */
  selectFiles?: boolean;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/**
 * Folder browser over GET /filesystem on the Arclight path picker: mono path input, crumbs,
 * a click selects a folder, a double-click or → opens it, Enter in the input opens what was
 * typed. Drives, optional files and "New folder".
 */
export function PathPickerDialog({ open, onClose, onSelect, initialPath, title = t('components.pathPicker.chooseAFolder'), includeFiles = false, selectFiles = false }: PathPickerDialogProps) {
  const withFiles = includeFiles || selectFiles;
  const [path, setPath] = useState(initialPath?.trim() ?? '');
  const [typed, setTyped] = useState(path);
  const [newName, setNewName] = useState<string | null>(null);
  const qc = useQueryClient();

  // Re-open at the caller's current value.
  useEffect(() => {
    if (open) {
      const start = initialPath?.trim() ?? '';
      setPath(start);
      setTyped(start);
      setNewName(null);
    }
  }, [open, initialPath]);

  const listing = useQuery({
    queryKey: filesystemKey(path, withFiles),
    queryFn: () => filesystemApi.list(path, withFiles),
    enabled: open,
    retry: false,
  });

  const go = (next: string) => {
    setPath(next);
    setTyped(next);
    setNewName(null);
  };

  const mkdir = useMutation({
    mutationFn: (name: string) => filesystemApi.mkdir({ parent: listing.data?.path ?? path, name: name.trim() }),
    meta: { silent: true },
    onSuccess: async (entry) => {
      await qc.invalidateQueries({ queryKey: ['filesystem'] });
      go(entry.path);
    },
  });

  const current = listing.data?.path ?? path;
  const atRoots = listing.data ? listing.data.path === '' : path === '';
  const crumbs = breadcrumbs(current);
  const directories = listing.data?.directories ?? [];

  // Select picks the highlighted folder of this listing, otherwise the folder being browsed.
  const candidate = typed.trim();
  const choice = candidate !== '' && (candidate === current || directories.some((d) => d.path === candidate)) ? candidate : current;

  const createFolder = () => {
    if (newName !== null && isValidFolderName(newName)) mkdir.mutate(newName);
  };

  const toEntry = (entry: FileSystemEntry): PathEntry => ({
    name: entry.name,
    path: entry.path,
    kind: entry.type === 'drive' ? 'drive' : entry.type === 'file' ? 'file' : 'folder',
    meta: entry.type === 'file' ? formatSize(entry.sizeBytes) : undefined,
  });
  const entries: PathEntry[] = listing.data ? [...listing.data.directories.map(toEntry), ...(withFiles ? listing.data.files.map(toEntry) : [])] : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size={640}
      footer={
        <>
          <Button variant="ghost" icon={<Icon name="plus" />} disabled={atRoots || newName !== null} onClick={() => setNewName('')}>
            {t('components.pathPicker.newFolder')}
          </Button>
          <span className="mt-path-picker__spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!listing.data || choice === ''} onClick={() => onSelect(choice)}>
            {t('common.select')}
          </Button>
        </>
      }
    >
      {/* No <form>s in here: the picker is often rendered inside another form. */}
      <div className="mt-path-picker">
        <div className="mt-path-picker__row">
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="arrowUp" />}
            disabled={!listing.data || listing.data.parent === null}
            onClick={() => go(listing.data?.parent ?? '')}
          >
            {t('components.pathPicker.upOneLevel')}
          </Button>
          <p className="mt-path-picker__hint">{t('components.pathPicker.clickAFolderToSelect')}</p>
        </div>
        <PathPickerField
          label={t('common.folderPath')}
          placeholder={t('components.pathPicker.typeAPathAndPress')}
          value={typed}
          onChange={setTyped}
          onNavigate={(p) => go(p.trim())}
          selectedPath={typed}
          onSelectFile={selectFiles ? onSelect : undefined}
          entries={entries}
          crumbs={crumbs.map((c) => ({ label: c.label, path: c.path }))}
          loading={listing.isPending}
          error={listing.isError ? errorMessage(listing.error) : undefined}
          collapsed={listing.isError}
        />
        {listing.isError ? (
          <div>
            <Button size="sm" variant="secondary" onClick={() => go('')}>
              {t('components.pathPicker.backToValue', { value: crumbs[0]?.label ?? t('components.pathPicker.roots') })}
            </Button>
          </div>
        ) : null}

        {newName !== null ? (
          <div className="mt-path-picker__row">
            <Input
              aria-label={t('components.pathPicker.newFolderName')}
              mono
              autoFocus
              value={newName}
              placeholder={t('components.pathPicker.folderName')}
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => onEnter(e, createFolder)}
            />
            <Button size="sm" variant="primary" loading={mkdir.isPending} disabled={!isValidFolderName(newName)} onClick={createFolder}>
              {t('components.pathPicker.createFolder')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewName(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : null}
        {mkdir.error ? (
          <p className="mt-path-picker__error" role="alert">
            {errorMessage(mkdir.error)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
