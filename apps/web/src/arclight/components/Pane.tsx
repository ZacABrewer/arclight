import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.js';
import { SectionLabel } from './SectionLabel.js';
import { t } from '../../i18n/index.js';

export type Chamfer = 'tl' | 'tr' | 'bl' | 'br' | 'both';

export interface PaneProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /**
   * Hero chamfer (22px cut, lit 1px edge, no glow). `both` = tl + br.
   * LINT: at most 2 chamfered panes per screen (Dashboard "Next 24 hours" + "VPN/Storage/
   * Issues"; Login card; wizard card; modal). Everything else is a plain pane.
   */
  chamfer?: Chamfer | undefined;
  /** 16px chamfer for mobile heroes. */
  small?: boolean | undefined;
  /** Header label — a string renders as the mono CAPS section label. */
  title?: ReactNode | undefined;
  /** Right side of the header: links ("Calendar"), buttons. */
  actions?: ReactNode | undefined;
  /** Remove body padding (edge-to-edge tables). Same meaning as the old Card `flush`. */
  flush?: boolean | undefined;
  /** Render children directly, without the `.al-pane__body` wrapper. */
  bare?: boolean | undefined;
  /** Stronger glass for overlays (modal-like surfaces). */
  strong?: boolean | undefined;
  as?: ElementType | undefined;
  children?: ReactNode;
}

function edgesFor(chamfer: Chamfer | undefined): Array<'tl' | 'tr' | 'bl' | 'br'> {
  if (!chamfer) return [];
  return chamfer === 'both' ? ['tl', 'br'] : [chamfer];
}

/** `.al-pane` — the default container: square, line-2 border, blur 26, sheen. */
export function Pane({ chamfer, small, title, actions, flush, bare, strong, as: As = 'section', className, children, ...rest }: PaneProps) {
  const head =
    title !== undefined || actions !== undefined ? (
      <header className="al-pane__head">
        {typeof title === 'string' ? <SectionLabel as="h2">{title}</SectionLabel> : (title ?? <span />)}
        {actions !== undefined ? <div className="al-pane__actions">{actions}</div> : null}
      </header>
    ) : null;
  return (
    <As
      className={cx(
        'al-pane',
        chamfer && `al-pane--chamfer-${chamfer}`,
        small && 'al-pane--sm',
        flush && 'al-pane--flush',
        strong && 'al-pane--strong',
        className,
      )}
      data-chamfer={chamfer}
      {...rest}
    >
      {edgesFor(chamfer).map((e) => (
        <i key={e} className={`al-edge al-edge--${e}`} aria-hidden="true" />
      ))}
      {head}
      {bare ? children : <div className="al-pane__body">{children}</div>}
    </As>
  );
}

export interface FloatBarProps extends HTMLAttributes<HTMLDivElement> {
  /** bulk = chamfered bottom-centre bar; save = unsaved-changes bar at the bottom of a form pane. */
  variant?: 'bulk' | 'save' | undefined;
  /** Bulk: number of selected items → mono "3 selected". Save: number of changes. */
  count?: number | undefined;
  /** Override the leading text ("2 unsaved changes"). */
  label?: ReactNode | undefined;
  /** bulk defaults to fixed bottom-centre; `inline` keeps it in flow (gallery, drawers). */
  position?: 'fixed' | 'sticky' | 'inline' | undefined;
  children?: ReactNode;
}

/** `.al-floatbar` — bulk-select bar or unsaved-changes bar. */
export function FloatBar({ variant = 'bulk', count, label, position, className, children, ...rest }: FloatBarProps) {
  const pos = position ?? (variant === 'bulk' ? 'fixed' : 'sticky');
  const lead =
    label ??
    (count === undefined ? null : variant === 'bulk' ? (
      <span className="al-floatbar__count">{t('arclight.pane.countSelected', { count })}</span>
    ) : (
      <span>
        {t('arclight.pane.countUnsavedChanges', { count })}
      </span>
    ));
  return (
    <div
      role={variant === 'bulk' ? 'toolbar' : 'region'}
      aria-label={variant === 'bulk' ? t('arclight.pane.bulkActions') : t('arclight.pane.unsavedChanges')}
      className={cx('al-floatbar', variant === 'save' && 'al-floatbar--save', pos === 'fixed' && 'al-floatbar--fixed', pos === 'sticky' && 'al-floatbar--sticky', className)}
      data-variant={variant}
      {...rest}
    >
      {variant === 'save' ? <span className="al-floatbar__dot" aria-hidden="true" /> : null}
      {lead}
      {variant === 'save' ? <span className="al-floatbar__spacer" /> : null}
      {children}
    </div>
  );
}

/** 1px vertical divider between float-bar action groups. */
export function FloatBarDivider() {
  return <span className="al-floatbar__divider" aria-hidden="true" />;
}
