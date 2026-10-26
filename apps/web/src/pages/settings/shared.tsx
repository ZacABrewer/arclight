import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button } from '../../components/button.js';
import { cx } from '../../lib/cx.js';

// Small building blocks shared by the settings pages.

/** Footer for editor dialogs: optional Delete on the left, Cancel / Save on the right. */
export function EditorFooter({
  onCancel,
  onSave,
  saving,
  onDelete,
  extra,
  saveLabel = 'Save',
}: {
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  onDelete?: (() => void) | undefined;
  extra?: ReactNode;
  saveLabel?: string;
}) {
  return (
    <div className="editor-footer">
      <div className="editor-footer-left">
        {onDelete ? (
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        {extra}
      </div>
      <div className="editor-footer-right">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving ?? false} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** Grid of clickable cards (profiles, indexers, clients) with an "add" tile at the end. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="card-grid">{children}</div>;
}

export function ItemCard({
  title,
  onClick,
  children,
  muted = false,
  status,
}: {
  title: ReactNode;
  onClick?: (() => void) | undefined;
  children?: ReactNode;
  muted?: boolean;
  status?: ReactNode;
}) {
  return (
    <div className={cx('item-card', muted && 'item-card-muted')}>
      <div className="item-card-head">
        {onClick ? (
          <button type="button" className="item-card-title link-button" onClick={onClick}>
            {title}
          </button>
        ) : (
          <span className="item-card-title">{title}</span>
        )}
        {status}
      </div>
      {children ? <div className="item-card-body">{children}</div> : null}
    </div>
  );
}

export function AddCard({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="item-card add-card" onClick={onClick}>
      <span aria-hidden="true">+</span> {label}
    </button>
  );
}

/** Inline error line for a failed save inside a dialog. */
export function SaveError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="inline-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

/** Notice for a page whose api route is being built in parallel and answered 404. */
export function PendingApiNotice({ what }: { what: string }) {
  return (
    <div className="notice notice-warning" role="status">
      The {what} api is not available on this server yet. The page will work once that module ships.
    </div>
  );
}

export function minutesLabel(minutes: number): string {
  if (minutes === 0) return 'No delay';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
