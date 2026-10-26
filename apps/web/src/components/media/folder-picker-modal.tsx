import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../../api/client.js';
import { filesystemApi } from '../../api/filesystem.js';
import { Button, Modal, PathPickerField, type PathCrumb, type PathEntry } from '../../arclight/index.js';
import { breadcrumbs } from '../path-picker/path-utils.js';

/** Folder browser (Modal 640 + kit PathPickerField) over GET /filesystem. */
export function FolderPickerModal({
  open,
  onClose,
  onSelect,
  initialPath,
  title = 'Choose a folder',
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string | undefined;
  title?: string;
}) {
  const [path, setPath] = useState(initialPath?.trim() ?? '');
  const [typed, setTyped] = useState(path);

  useEffect(() => {
    if (open) {
      const start = initialPath?.trim() ?? '';
      setPath(start);
      setTyped(start);
    }
  }, [open, initialPath]);

  const listing = useQuery({
    queryKey: ['filesystem', path, false],
    queryFn: () => filesystemApi.list(path, false),
    enabled: open,
    retry: false,
  });

  const current = listing.data?.path ?? path;
  const go = (next: string) => {
    setPath(next);
    setTyped(next);
  };
  const entries: PathEntry[] = [
    ...(listing.data && listing.data.parent !== null ? [{ name: '..', path: listing.data.parent ?? '', kind: 'folder' as const }] : []),
    ...(listing.data?.directories ?? []).map((e) => ({ name: e.name, path: e.path, kind: e.type === 'drive' ? ('drive' as const) : ('folder' as const) })),
  ];
  const crumbs: PathCrumb[] = breadcrumbs(current).map((c) => ({ label: c.label, path: c.path }));
  const chosen = typed.trim() || current;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen} onClick={() => onSelect(chosen)}>
            Select folder
          </Button>
        </>
      }
    >
      <PathPickerField
        label="Folder path"
        value={typed}
        onChange={setTyped}
        entries={entries}
        crumbs={crumbs}
        onNavigate={go}
        loading={listing.isPending}
        error={listing.isError ? errorMessage(listing.error) : undefined}
      />
    </Modal>
  );
}
