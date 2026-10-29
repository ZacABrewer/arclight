import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, FloatBar, FloatBarDivider, Menu, Popover, type MenuItem } from '../../arclight/index.js';
import { useIsMobile } from './media-kit.js';
import { t } from '../../i18n/index.js';
import './bulk-bar.css';

// The one bulk bar every library / Wanted list uses: "3 selected", "Select all 120", the
// page's actions, Cancel. Desktop shows each action as a button (pickers such as profile or
// tags open a menu); when they don't fit (phones, narrow windows, long action lists) they fold
// into one "Actions" menu so the bar never runs off the screen.

export interface BulkOption {
  id: string;
  label: ReactNode;
  onSelect: () => void;
}

export interface BulkAction {
  id: string;
  label: string;
  /** Plain action. */
  onSelect?: (() => void) | undefined;
  /** Picker: the action opens a menu of these (profile, root folder, tags…). */
  options?: readonly BulkOption[] | undefined;
  /** Menu heading for a picker (defaults to the label). */
  optionsHeader?: string | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
}

export interface BulkBarProps {
  /** Selected rows. */
  count: number;
  /**
   * Rows the list (with its current filter) holds. While fewer are selected the bar offers
   * "Select all N"; for paged lists `total` is the server's count and `onSelectAll` switches
   * the bar to "all matching" mode.
   */
  total?: number | undefined;
  onSelectAll?: (() => void) | undefined;
  /** "All N matching" is selected (paged lists): the count shows the total. */
  allMatching?: boolean | undefined;
  actions: readonly BulkAction[];
  onClear: () => void;
  /** Show the bar while nothing is selected yet (select mode of poster grids). */
  open?: boolean | undefined;
  position?: 'fixed' | 'inline' | undefined;
  /** Dialogs the actions open. */
  children?: ReactNode;
}

function PickerButton({ action }: { action: BulkAction }) {
  return (
    <Popover
      trigger={(props) => (
        <Button variant="ghost" disabled={action.disabled} loading={action.loading} {...props}>
          {action.label}
        </Button>
      )}
      placement="top-start"
      width={260}
      label={action.optionsHeader ?? action.label}
    >
      {(close) =>
        (action.options ?? []).length === 0 ? (
          <p className="mk-bulk__empty">{t('bulk.noOptions')}</p>
        ) : (
          <Menu header={action.optionsHeader ?? action.label} onDone={close} items={(action.options ?? []).map((o) => ({ id: o.id, label: o.label, onSelect: o.onSelect }))} />
        )
      }
    </Popover>
  );
}

/** Phone width: every action in one menu; a picker swaps the menu for its options. */
function ActionsMenu({ actions, disabled }: { actions: readonly BulkAction[]; disabled: boolean }) {
  const [picker, setPicker] = useState<BulkAction | null>(null);
  return (
    <Popover
      trigger={(props) => (
        <Button variant="secondary" disabled={disabled} {...props}>
          {t('bulk.actions')}
        </Button>
      )}
      placement="top-start"
      width={260}
      label={t('bulk.actions')}
      onOpenChange={(o) => {
        if (!o) setPicker(null);
      }}
    >
      {(close) => {
        if (picker) {
          const items: MenuItem[] = [
            { id: '__back', label: `‹ ${t('bulk.back')}`, onSelect: () => setPicker(null) },
            ...(picker.options ?? []).map((o, i) => ({
              id: o.id,
              label: o.label,
              separatorBefore: i === 0,
              onSelect: () => {
                o.onSelect();
                setPicker(null);
                close();
              },
            })),
          ];
          return <Menu header={picker.optionsHeader ?? picker.label} items={items} />;
        }
        const items: MenuItem[] = actions
          .filter((a) => !a.disabled)
          .map((a, i, list) => ({
            id: a.id,
            label: a.options ? `${a.label} ›` : a.label,
            danger: a.danger,
            separatorBefore: a.danger && i > 0 && !list[i - 1]?.danger,
            onSelect: () => {
              if (a.options) setPicker(a);
              else {
                a.onSelect?.();
                close();
              }
            },
          }));
        return <Menu items={items} />;
      }}
    </Popover>
  );
}

/**
 * Whether the bar's buttons fit its width. Measured once with every button shown (before
 * paint), then re-checked on resize; a new action list measures again.
 */
function useActionsFit(actionCount: number) {
  const probe = useRef<HTMLSpanElement>(null);
  const needed = useRef<number | null>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    needed.current = null;
    setFits(true);
  }, [actionCount]);
  useLayoutEffect(() => {
    const room = (bar: HTMLElement) => {
      const max = parseFloat(getComputedStyle(bar).maxWidth);
      const parent = bar.parentElement?.clientWidth ?? window.innerWidth;
      return Number.isFinite(max) ? Math.min(max, parent) : parent;
    };
    const check = () => {
      const bar = probe.current?.parentElement;
      if (!bar) return;
      if (needed.current === null && fits) needed.current = bar.scrollWidth;
      if (needed.current !== null) setFits(needed.current <= room(bar) + 1);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  });
  return { probe, fits };
}

export function BulkBar({ count, total, onSelectAll, allMatching = false, actions, onClear, open = false, position, children }: BulkBarProps) {
  const mobile = useIsMobile();
  const fits = useActionsFit(actions.length);
  if (count === 0 && !open && !allMatching) return null;
  const shown = allMatching && total !== undefined ? total : count;
  const canSelectAll = onSelectAll !== undefined && total !== undefined && total > 0 && !allMatching && count < total;
  const none = shown === 0;
  const plain = actions.filter((a) => !a.danger);
  const danger = actions.filter((a) => a.danger);
  return (
    <FloatBar count={shown} position={position} className="mk-bulk" data-testid="bulk-bar">
      {canSelectAll ? (
        <Button variant="ghost" size="sm" className="mk-bulk__all" onClick={onSelectAll}>
          {t('bulk.selectAll', { count: total })}
        </Button>
      ) : null}
      <span ref={fits.probe} hidden />
      {mobile || !fits.fits ? (
        <ActionsMenu actions={actions} disabled={none} />
      ) : (
        <>
          {plain.map((a) =>
            a.options ? (
              <PickerButton key={a.id} action={{ ...a, disabled: a.disabled || none }} />
            ) : (
              <Button key={a.id} variant="ghost" disabled={a.disabled || none} loading={a.loading} onClick={a.onSelect}>
                {a.label}
              </Button>
            ),
          )}
          {danger.length ? <FloatBarDivider /> : null}
          {danger.map((a) => (
            <Button key={a.id} variant="danger" disabled={a.disabled || none} loading={a.loading} onClick={a.onSelect}>
              {a.label}
            </Button>
          ))}
        </>
      )}
      <Button variant="ghost" className="al-floatbar__cancel" onClick={onClear}>
        {t('common.cancel')}
      </Button>
      {children}
    </FloatBar>
  );
}
