import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button, Pane, SectionLabel } from '../../arclight/index.js';
import './settings.css';

// Small building blocks shared by the settings pages (Arclight).

/** Footer for editor dialogs: optional Delete (danger) on the left, Cancel / Save on the right. */
export function EditorFooter({
  onCancel,
  onSave,
  saving,
  onDelete,
  extra,
  saveLabel = 'Save',
  deleteLabel = 'Delete',
}: {
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  onDelete?: (() => void) | undefined;
  extra?: ReactNode;
  saveLabel?: string;
  deleteLabel?: string;
}) {
  return (
    <div className="al-editor-footer">
      <div className="al-editor-footer__side">
        {onDelete ? (
          <Button variant="danger" onClick={onDelete}>
            {deleteLabel}
          </Button>
        ) : null}
        {extra}
      </div>
      <div className="al-editor-footer__side">
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

/** Grid of `.al-pane` cards (profiles, indexers, clients) with an "add" tile at the end. */
export function CardGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="al-card-grid" role="list" aria-label={label}>
      {children}
    </div>
  );
}

export function ItemCard({
  title,
  onClick,
  children,
  muted = false,
  status,
  actions,
}: {
  title: ReactNode;
  onClick?: (() => void) | undefined;
  children?: ReactNode;
  muted?: boolean;
  /** Chip(s) top right. */
  status?: ReactNode;
  /** Buttons at the bottom of the card (Test / Edit). */
  actions?: ReactNode;
}) {
  return (
    <div role="listitem" className="al-item-card-wrap">
      <Pane className="al-item-card" data-muted={muted || undefined}>
        <div className="al-item-card__head">
          {onClick ? (
            <button type="button" className="al-item-card__title" onClick={onClick}>
              {title}
            </button>
          ) : (
            <h3 className="al-item-card__title">{title}</h3>
          )}
          {status}
        </div>
        {children ? <div className="al-item-card__meta">{children}</div> : null}
        {actions ? <div className="al-item-card__actions">{actions}</div> : null}
      </Pane>
    </div>
  );
}

export function AddCard({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div role="listitem">
      <button type="button" className="al-add-card" onClick={onClick}>
        <span aria-hidden="true">+</span> {label}
      </button>
    </div>
  );
}

/** A section inside a settings pane: mono CAPS label, optional action right, then content. */
export function SettingsSection({ label, action, children, count }: { label: string; action?: ReactNode; children: ReactNode; count?: number | undefined }) {
  return (
    <section className="al-settings-section" aria-label={label}>
      <div className="al-settings-section__head">
        <SectionLabel count={count}>{label}</SectionLabel>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Inline error line for a failed save inside a dialog. */
export function SaveError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="al-inline-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

/** Notice for a page whose api route is being built in parallel and answered 404. */
export function PendingApiNotice({ what }: { what: string }) {
  return (
    <div className="al-notice" role="status">
      The {what} api is not available on this server yet. This page works once that module ships.
    </div>
  );
}

export function minutesLabel(minutes: number): string {
  if (minutes === 0) return 'No delay';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
