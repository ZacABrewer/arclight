import { useEffect, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileSystemEntry } from '@media-tron/shared';
import { errorMessage } from '../../api/client.js';
import { filesystemApi } from '../../api/filesystem.js';
import { Button } from '../button.js';
import { Input } from '../form.js';
import { Modal } from '../modal.js';
import { Spinner } from '../spinner.js';
import { breadcrumbs, isValidFolderName } from './path-utils.js';

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

/** Folder browser over GET /filesystem with breadcrumbs, drives, optional files and "new folder". */
export function PathPickerDialog({ open, onClose, onSelect, initialPath, title = 'Choose a folder', includeFiles = false, selectFiles = false }: PathPickerDialogProps) {
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

  const createFolder = () => {
    if (newName !== null && isValidFolderName(newName)) mkdir.mutate(newName);
  };

  const entryButton = (entry: FileSystemEntry) => {
    const isFile = entry.type === 'file';
    const glyph = entry.type === 'drive' ? '🖴' : isFile ? '📄' : '📁';
    return (
      <li key={entry.path}>
        <button
          type="button"
          className="path-picker-entry"
          disabled={isFile && !selectFiles}
          onClick={() => (isFile ? onSelect(entry.path) : go(entry.path))}
        >
          <span aria-hidden="true">{glyph}</span>
          <span className="path-picker-name">{entry.name}</span>
          {isFile ? <span className="muted">{formatSize(entry.sizeBytes)}</span> : null}
        </button>
      </li>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" disabled={atRoots || newName !== null} onClick={() => setNewName('')}>
            New folder
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={atRoots || !listing.data} onClick={() => onSelect(current)}>
            Select
          </Button>
        </>
      }
    >
      <div className="path-picker">
        {/* No <form>s in here: the picker is often rendered inside another form. */}
        <div className="row">
          <Input
            aria-label="Folder path"
            value={typed}
            placeholder="Type a path and press Enter"
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => onEnter(e, () => go(typed.trim()))}
          />
          <Button size="sm" onClick={() => go(typed.trim())}>
            Go
          </Button>
        </div>
        <nav aria-label="Breadcrumbs" className="path-picker-crumbs">
          {crumbs.map((c, i) => (
            <span key={`${c.path}-${i}`}>
              {i > 0 ? <span className="muted"> › </span> : null}
              <button type="button" className="link-subtle" onClick={() => go(c.path)} aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>

        {newName !== null ? (
          <div className="row">
            <Input
              aria-label="New folder name"
              autoFocus
              value={newName}
              placeholder="Folder name"
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => onEnter(e, createFolder)}
            />
            <Button size="sm" variant="primary" loading={mkdir.isPending} disabled={!isValidFolderName(newName)} onClick={createFolder}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewName(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {mkdir.error ? (
          <p className="field-error-text" role="alert">
            {errorMessage(mkdir.error)}
          </p>
        ) : null}

        <div className="path-picker-list" aria-busy={listing.isFetching || undefined}>
          {listing.isPending ? (
            <Spinner />
          ) : listing.isError ? (
            <div className="stack-sm">
              <p className="field-error-text" role="alert">
                {errorMessage(listing.error)}
              </p>
              <Button size="sm" onClick={() => go('')}>
                Back to {crumbs[0]?.label ?? 'roots'}
              </Button>
            </div>
          ) : (
            <ul className="path-picker-entries" aria-label="Folder contents">
              {listing.data.parent !== null ? (
                <li>
                  <button type="button" className="path-picker-entry" onClick={() => go(listing.data.parent ?? '')}>
                    <span aria-hidden="true">↰</span>
                    <span className="path-picker-name">..</span>
                    <span className="sr-only">Up one level</span>
                  </button>
                </li>
              ) : null}
              {listing.data.directories.map(entryButton)}
              {withFiles ? listing.data.files.map(entryButton) : null}
              {listing.data.directories.length === 0 && (!withFiles || listing.data.files.length === 0) ? (
                <li className="muted path-picker-empty">Empty folder</li>
              ) : null}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
