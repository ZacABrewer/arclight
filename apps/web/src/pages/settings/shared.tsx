import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, Chip, Pane, SectionLabel, Tooltip } from '../../arclight/index.js';
import './settings.css';
import './managed.css';
import { t } from '../../i18n/index.js';

// Small building blocks shared by the settings pages (Arclight).

/** Footer for editor dialogs: optional Delete (danger) on the left, Cancel / Save on the right. */
export function EditorFooter({
  onCancel,
  onSave,
  saving,
  onDelete,
  extra,
  saveLabel = t('common.save'),
  deleteLabel = t('common.delete'),
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
          {t('common.cancel')}
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

/** ItemCard's bulk selection checkbox. */
export interface ItemCardSelect {
  checked: boolean;
  onChange: () => void;
  label: string;
}

export function ItemCard({
  title,
  onClick,
  children,
  muted = false,
  status,
  actions,
  select,
}: {
  title: ReactNode;
  onClick?: (() => void) | undefined;
  children?: ReactNode;
  muted?: boolean;
  /** Chip(s) top right. */
  status?: ReactNode;
  /** Buttons at the bottom of the card (Test / Edit). */
  actions?: ReactNode;
  /** Bulk selection checkbox before the title (components/bulk-actions.tsx). */
  select?: ItemCardSelect | undefined;
}) {
  return (
    <div role="listitem" className="al-item-card-wrap">
      <Pane className="al-item-card" data-muted={muted || undefined} data-selected={select?.checked || undefined}>
        <div className="al-item-card__head">
          {select ? <Checkbox className="al-item-card__select" aria-label={select.label} checked={select.checked} onChange={select.onChange} /> : null}
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

export const managedTooltip = () => t('settings.shared.managedTooltip');

/** "Managed by config file" lock badge with the reason in a tooltip. */
export function ManagedBadge({ detail }: { detail?: string | undefined }) {
  return (
    <Tooltip content={detail ? t('settings.shared.managedTooltipKeysDetail', { tooltip: managedTooltip(), detail }) : managedTooltip()}>
      <span tabIndex={0} className="al-managed-badge">
        <Chip tone="neutral" dot="ring">
          {t('settings.shared.managedByConfigFile')}
        </Chip>
      </span>
    </Tooltip>
  );
}

/**
 * A section inside a settings pane: mono CAPS label, optional action right, then content.
 * `managed` (from isSectionManaged in hooks/config.ts) adds the lock badge and disables every
 * input inside through a disabled fieldset.
 */
export function SettingsSection({
  label,
  action,
  children,
  count,
  managed = false,
  managedKeys,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
  count?: number | undefined;
  managed?: boolean | undefined;
  /** Managed key names, listed in the badge tooltip. */
  managedKeys?: readonly string[] | undefined;
}) {
  return (
    <section className="al-settings-section" aria-label={label} data-managed={managed || undefined}>
      <div className="al-settings-section__head">
        <SectionLabel count={count}>{label}</SectionLabel>
        {managed ? <ManagedBadge detail={managedKeys?.length ? managedKeys.join(', ') : undefined} /> : null}
        {action}
      </div>
      {managed ? (
        <fieldset disabled className="al-managed-fieldset" aria-label={t('settings.shared.labelManagedByConfigFile', { label })}>
          {children}
        </fieldset>
      ) : (
        children
      )}
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
      {t('settings.shared.theWhatApiIsNot', { what })}
    </div>
  );
}

export function minutesLabel(minutes: number): string {
  if (minutes === 0) return t('settings.shared.noDelay');
  if (minutes % 1440 === 0) return t('settings.shared.valueD', { value: minutes / 1440 });
  if (minutes % 60 === 0) return t('settings.shared.valueH', { value: minutes / 60 });
  return t('settings.shared.minutesMin', { minutes });
}
