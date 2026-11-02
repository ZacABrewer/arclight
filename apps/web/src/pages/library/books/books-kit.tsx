import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { BooksFormat, BooksKind, BooksRelease, BooksSource, BooksSourceStatus, ComicSeries } from '@arclight/shared';
import { Button, Checkbox, Chip, Modal, Poster, RejectionList, type ButtonProps } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { Loading } from '../../../components/media/media-kit.js';
import { useFeatures } from '../../../hooks/music.js';
import { useBooksCommand } from '../../../hooks/books.js';
import { NotFoundPage } from '../../not-found.js';
import { formatLabel, sourceStateTone } from './books-model.js';
import './books.css';
import { t } from '../../../i18n/index.js';

/** Book pages exist only while the flag is on: a 404 otherwise (and a skeleton while it loads). */
export function BooksGate({ children }: { children: ReactNode }) {
  const features = useFeatures();
  if (!features.ready) return <Loading />;
  if (!features.books) return <NotFoundPage />;
  return <>{children}</>;
}

/** View state kept per browser (view mode, sort, the shelf's tab). */
export function usePersistent<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // Storage unavailable: keep the in-memory value only.
    }
  };
  return [value, set];
}

/** The value after it has stopped changing for `ms` (catalogue lookups as the user types). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return current;
}

/** Route helpers (typed paths). */
export const ebookAuthorLink = (a: { id: number }) => ({ to: '/library/books/authors/$id' as const, params: { id: String(a.id) } });
export const ebookSeriesLink = (s: { id: number } | { seriesId: number }) => ({
  to: '/library/books/series/$id' as const,
  params: { id: String('seriesId' in s ? s.seriesId : s.id) },
});
export const comicSeriesLink = (s: { id: number }) => ({ to: '/library/books/comics/$id' as const, params: { id: String(s.id) } });

/** "Library / Books [/ parent]" crumb. */
export function BooksCrumb({ children }: { children?: ReactNode }) {
  return (
    <>
      <Link to="/library/books">{t('common.library')}</Link> / <Link to="/library/books">{t('books.title')}</Link>
      {children ? <> / {children}</> : null}
    </>
  );
}

/** A 2:3 book or comic cover; the title's initial without one. */
export function CoverArt({
  src,
  title,
  className,
  progress,
  progressTone,
  loading,
  children,
}: {
  src: string | null | undefined;
  title: string;
  className?: string | undefined;
  progress?: number | undefined;
  progressTone?: 'default' | 'warn' | 'muted' | undefined;
  loading?: 'lazy' | 'eager' | undefined;
  children?: ReactNode;
}) {
  return (
    <Poster src={src ?? undefined} title={title} className={['bk-cover', className].filter(Boolean).join(' ')} progress={progress} progressTone={progressTone} loading={loading}>
      {children}
    </Poster>
  );
}

/** EPUB / CBZ … badge (top-left on covers, inline in tables). */
export function FormatBadge({ format, overlay }: { format: BooksFormat | null | undefined; overlay?: boolean }) {
  if (!format) return null;
  return (
    <span className="bk-format" data-overlay={overlay || undefined} data-testid="format-badge">
      {formatLabel(format)}
    </span>
  );
}

/** "Ebook" / "Comic" chip for mixed lists (wanted, calendar, requests). */
export function BooksKindChip({ kind }: { kind: BooksKind }) {
  return (
    <Chip tone="neutral" dot="none" data-kind={kind}>
      {kind === 'ebook' ? t('books.kind.ebook') : t('books.kind.comic')}
    </Chip>
  );
}

export function seriesTypeLabel(type: ComicSeries['seriesType']): string {
  switch (type) {
    case 'comic':
      return t('books.seriesType.comic');
    case 'manga':
      return t('books.seriesType.manga');
    case 'graphicNovel':
      return t('books.seriesType.graphicNovel');
  }
}

export function sourceLabel(source: BooksSource): string {
  switch (source) {
    case 'openLibrary':
      return t('books.source.openLibrary');
    case 'googleBooks':
      return t('books.source.googleBooks');
    case 'hardcover':
      return t('books.source.hardcover');
    case 'comicVine':
      return t('books.source.comicVine');
    case 'metron':
      return t('books.source.metron');
  }
}

function sourceStateLabel(state: BooksSourceStatus['state']): string {
  switch (state) {
    case 'ok':
      return t('books.sourceState.ok');
    case 'cached':
      return t('books.sourceState.cached');
    case 'stale':
      return t('books.sourceState.stale');
    case 'failed':
      return t('books.sourceState.failed');
    case 'disabled':
      return t('books.sourceState.disabled');
  }
}

/** One chip per catalogue that answered (or did not) a lookup. */
export function SourceStatusChips({ sources }: { sources: readonly BooksSourceStatus[] | undefined }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="bk-sources" aria-label={t('books.add.sources')}>
      {sources.map((s) => (
        <Chip key={s.source} tone={sourceStateTone(s.state)} dot={s.state === 'disabled' ? 'ring' : 'fill'} title={s.message ?? undefined} data-state={s.state}>
          {sourceLabel(s.source)} · {sourceStateLabel(s.state)}
        </Chip>
      ))}
    </div>
  );
}

/** Delete an author, a comic series or a book, optionally with its files. */
export function BooksDeleteDialog({
  open,
  onClose,
  subject,
  path,
  loading,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  path?: string | undefined;
  loading: boolean;
  onConfirm: (deleteFiles: boolean) => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  useEffect(() => {
    if (open) setDeleteFiles(false);
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('components.media.deleteMediaDialog.deleteSubject', { subject })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={loading} onClick={() => onConfirm(deleteFiles)}>
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="mk-stack-sm">
        <p style={{ margin: 0 }}>{t('components.media.deleteMediaDialog.subjectWillBeRemovedFrom', { subject })}</p>
        <Checkbox
          tone="danger"
          label={t('components.media.deleteMediaDialog.deleteFilesAndFolderFrom')}
          hint={
            deleteFiles ? (
              <span role="alert">
                {path ? (
                  <>
                    <span className="al-num">{path}</span> {t('components.media.deleteMediaDialog.andEverythingInItWill')}
                  </>
                ) : (
                  t('components.media.deleteMediaDialog.everyFolderAndFileWill')
                )}
              </span>
            ) : undefined
          }
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        />
      </div>
    </Modal>
  );
}

/**
 * Grab cell of the release tables: approved releases grab on click; rejected ones offer
 * "Grab anyway" behind a confirmation that lists the rejections (sent with force).
 */
export function BooksGrabButton({ release, loading, onGrab }: { release: BooksRelease; loading: boolean; onGrab: (force: boolean) => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const override = !release.approved;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t(override ? 'library.grabButton.grabAnywayTitle' : 'library.interactiveSearch.grabTitle', { title: release.title })}
        loading={loading}
        onClick={() => (override ? setConfirming(true) : void onGrab(false).catch(() => undefined))}
      >
        {override ? t('library.grabButton.grabAnyway') : t('library.interactiveSearch.grab')}
      </Button>
      {override ? (
        <ConfirmDialog
          open={confirming}
          title={t('library.grabButton.grabRejectedRelease')}
          confirmLabel={t('library.grabButton.grabAnyway')}
          danger={false}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await onGrab(true);
            setConfirming(false);
          }}
        >
          <p>{t('library.grabButton.overrideExplanation', { title: release.title })}</p>
          <RejectionList reasons={release.rejections} />
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Automatic search for one ebook or comic issue (calendar, wanted rows, book rows). */
export function BooksSearchButton({
  kind,
  id,
  size = 'sm',
  variant,
  label,
}: {
  kind: BooksKind;
  id: number;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  label?: string | undefined;
}) {
  const command = useBooksCommand();
  return (
    <Button
      size={size}
      variant={variant}
      aria-label={label}
      loading={command.isPending}
      onClick={() => command.mutate(kind === 'ebook' ? { name: 'EbookSearch', ebookIds: [id] } : { name: 'ComicIssueSearch', issueIds: [id] })}
    >
      {t('common.search')}
    </Button>
  );
}
