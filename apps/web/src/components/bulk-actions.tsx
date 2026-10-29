import { useMemo, useState, type ReactNode } from 'react';
import type { BulkId } from '@arclight/shared';
import type { RowKey } from '../arclight/index.js';
import { ConfirmDialog } from './forms/confirm-dialog.js';
import { useToast } from './toast.js';
import { t } from '../i18n/index.js';

// Selection, confirm and result toast for bulk actions outside the library (settings card
// grids, activity / system tables, request lists). The bar itself is the shared
// components/media/bulk-bar.tsx; tables keep their header select-all checkbox and hand their
// selection to it. Destructive actions are confirmed with the count; the per-id result is one
// toast (useBulkResultToast).

export interface Selection {
  /** Selected keys that are still on screen. */
  selected: Set<RowKey>;
  count: number;
  all: boolean;
  some: boolean;
  has: (key: RowKey) => boolean;
  toggle: (key: RowKey) => void;
  toggleAll: () => void;
  set: (keys: Iterable<RowKey>) => void;
  /** Unselect these (e.g. the ids a bulk action finished); failed ones stay selected. */
  drop: (keys: Iterable<RowKey>) => void;
  clear: () => void;
  /** Props for a card's checkbox (ItemCard `select`). */
  cardProps: (key: RowKey, name: string) => { checked: boolean; onChange: () => void; label: string };
}

/** Selection over the keys on screen; keys that disappear (deleted, filtered) drop out. */
export function useSelection(keys: readonly RowKey[]): Selection {
  const [raw, setRaw] = useState<ReadonlySet<RowKey>>(new Set());
  return useMemo(() => {
    const visible = new Set(keys);
    const selected = new Set([...raw].filter((k) => visible.has(k)));
    const count = selected.size;
    const all = keys.length > 0 && count === keys.length;
    return {
      selected,
      count,
      all,
      some: count > 0 && !all,
      has: (key) => selected.has(key),
      toggle: (key) =>
        setRaw((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
      toggleAll: () => setRaw(all ? new Set() : new Set(keys)),
      set: (next) => setRaw(new Set(next)),
      drop: (keys) => {
        const gone = new Set(keys);
        setRaw((prev) => new Set([...prev].filter((k) => !gone.has(k))));
      },
      clear: () => setRaw(new Set()),
      cardProps: (key, name) => ({
        checked: selected.has(key),
        onChange: () =>
          setRaw((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          }),
        label: t('components.bulkActions.selectName', { name }),
      }),
    };
  }, [keys, raw]);
}

export interface BulkOutcome {
  ok: readonly BulkId[];
  failed: ReadonlyArray<{ id: BulkId; error: string }>;
}

/**
 * One toast for a bulk result: "Disabled · 3 done", or "2 done, 1 failed" with the first
 * failures named. `nameOf` turns an id into the row's name for the message.
 */
export function useBulkResultToast() {
  const toast = useToast();
  return (label: string, result: BulkOutcome, nameOf?: (id: BulkId) => string | undefined) => {
    const failed = result.failed.length;
    const ok = result.ok.length;
    if (failed === 0) {
      toast.push({ tone: 'ok', title: t('components.bulkActions.resultDone', { label, count: ok }), durationMs: 4_000 });
      return;
    }
    const shown = result.failed.slice(0, 3).map((f) => `${nameOf?.(f.id) ?? `#${f.id}`}: ${f.error}`);
    if (failed > 3) shown.push(t('components.bulkActions.andMore', { count: failed - 3 }));
    toast.push({
      tone: ok === 0 ? 'error' : 'warning',
      title: t('components.bulkActions.resultPartial', { label, ok, failed }),
      message: shown.join('; '),
      durationMs: 12_000,
    });
  };
}

/** Confirm for a destructive bulk action; the body says how many rows it touches. */
export function BulkConfirmDialog({
  open,
  title,
  count,
  confirmLabel,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  count: number;
  confirmLabel?: string | undefined;
  onCancel: () => void;
  onConfirm: () => Promise<unknown>;
  children?: ReactNode;
}) {
  return (
    <ConfirmDialog open={open} title={title} confirmLabel={confirmLabel ?? t('components.bulkActions.deleteCount', { count })} onCancel={onCancel} onConfirm={onConfirm}>
      <p>{t('components.bulkActions.confirmBody', { count })}</p>
      {children}
    </ConfirmDialog>
  );
}
