import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  /** primary = one per view; secondary = default; ghost = Cancel/Back/Skip; danger = destructive. */
  variant?: ButtonVariant | undefined;
  /** 32 / 38 / 46 px. */
  size?: ButtonSize | undefined;
  /** Shows a busy glyph, sets aria-busy and disables the button. */
  loading?: boolean | undefined;
  /** Leading icon. With no children it becomes a square icon button (needs aria-label). */
  icon?: ReactNode | undefined;
  /** Trailing icon. */
  iconEnd?: ReactNode | undefined;
  /** Stretch to the container width (mobile, login). */
  block?: boolean | undefined;
}

export interface ButtonProps extends CommonProps, ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  block = false,
  className,
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  iconOnly?: boolean;
  block?: boolean | undefined;
  className?: string | undefined;
}): string {
  return cx(
    'al-btn',
    variant === 'danger-solid' ? 'al-btn--danger al-btn--danger-solid' : `al-btn--${variant}`,
    size !== 'md' && `al-btn--${size}`,
    iconOnly && 'al-btn--icon',
    block && 'al-btn--block',
    className,
  );
}

/** `.al-btn`. Buttons are verbs: "Save changes", "Search monitored", "Delete series". */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconEnd,
  block,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const iconOnly = !!icon && (children === undefined || children === null || children === false);
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, iconOnly, block, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {loading ? <span className="al-btn__spinner" aria-hidden="true" data-testid="al-btn-spinner" /> : icon}
      {children}
      {iconEnd}
    </button>
  );
}

export interface LinkButtonProps extends CommonProps, AnchorHTMLAttributes<HTMLAnchorElement> {
  ref?: Ref<HTMLAnchorElement> | undefined;
}

/** A link styled as a button (navigation that looks like an action, e.g. "Go to dashboard"). */
export function LinkButton({ variant = 'secondary', size = 'md', icon, iconEnd, block, className, children, loading: _loading, ...rest }: LinkButtonProps) {
  const iconOnly = !!icon && !children;
  return (
    <a className={buttonClass({ variant, size, iconOnly, block, className })} {...rest}>
      {icon}
      {children}
      {iconEnd}
    </a>
  );
}

/** Row of buttons with the kit's 10px gap. */
export function ButtonGroup({ children, className }: { children?: ReactNode; className?: string | undefined }) {
  return <div className={cx('al-btn-group', className)}>{children}</div>;
}
