import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BULK_ACTIONS, type BulkAction, type BulkId, type BulkResource } from '@arclight/shared';
import { libraryApi } from '../api/library.js';
import type { RowKey } from '../arclight/index.js';
import { useBulkAction } from '../hooks/bulk-actions.js';
import { BulkConfirmDialog, useBulkResultToast, useSelection, type Selection } from './bulk-actions.js';
import { BulkBar, type BulkAction as BarAction } from './media/bulk-bar.js';
import { t } from '../i18n/index.js';

// Bulk actions for a POST /bulk resource (settings, activity and system lists), drawn in the
// shared bulk bar (components/media/bulk-bar.tsx: buttons on desktop, one Actions menu on
// phones). Destructive actions are confirmed with the count, tag edits pick a tag from the
// bar, and the per-id result is one toast.

const LABELS: Record<BulkAction, () => string> = {
  enable: () => t('components.bulkActions.enable'),
  disable: () => t('components.bulkActions.disable'),
  test: () => t('components.bulkActions.test'),
  delete: () => t('common.delete'),
  addTags: () => t('components.bulkActions.addTags'),
  removeTags: () => t('components.bulkActions.removeTags'),
  cancel: () => t('components.bulkActions.stop'),
  markFailed: () => t('components.bulkActions.markFailed'),
  redownload: () => t('components.bulkActions.redownload'),
  grab: () => t('components.bulkActions.grabNow'),
  run: () => t('components.bulkActions.runNow'),
};

/** Actions whose effect cannot be taken back: confirmed with the count first. */
const CONFIRM: Partial<Record<BulkAction, (count: number) => string>> = {
  delete: (count) => t('components.bulkActions.deleteTitle', { count }),
  cancel: (count) => t('components.bulkActions.stopTitle', { count }),
  markFailed: (count) => t('components.bulkActions.markFailedTitle', { count }),
};
const DANGER: ReadonlySet<BulkAction> = new Set(['delete', 'cancel', 'markFailed']);

// Same cache as the tag pickers (libraryKeys.library.tags).
const TAGS_KEY = ['library', 'tags'] as const;

export function bulkActionLabel(action: BulkAction): string {
  return LABELS[action]();
}

export interface ResourceBulkOptions {
  /** Row name for failure messages. */
  nameOf?: ((id: BulkId) => string | undefined) | undefined;
  /** Subset (and order) of the resource's actions; default all of them. */
  actions?: readonly BulkAction[] | undefined;
  /** Called after a run with the ids that worked (unselect them). */
  onDone?: ((ok: readonly BulkId[]) => void) | undefined;
}

/** The bar's action list plus the dialogs they open, for `ids` of `resource`. */
export function useResourceBulkActions(resource: BulkResource, ids: ReadonlySet<RowKey>, { nameOf, actions, onDone }: ResourceBulkOptions = {}) {
  const mutation = useBulkAction(resource);
  const report = useBulkResultToast();
  const [confirming, setConfirming] = useState<BulkAction | null>(null);
  const available = (actions ?? BULK_ACTIONS[resource]).filter((a) => BULK_ACTIONS[resource].includes(a));
  const wantsTags = available.includes('addTags') || available.includes('removeTags');
  const tags = useQuery({ queryKey: TAGS_KEY, queryFn: libraryApi.tags.list, staleTime: 60_000, enabled: wantsTags && ids.size > 0 });
  const list = [...ids] as BulkId[];

  const run = (action: BulkAction, tagIds?: number[]) =>
    mutation.mutateAsync(
      { action, ids: list, tags: tagIds },
      {
        onSuccess: (res) => {
          report(LABELS[action](), res, nameOf);
          onDone?.(res.ok);
        },
      },
    );

  const barActions: BarAction[] = available.map((action) => {
    const base = {
      id: action,
      label: LABELS[action](),
      danger: DANGER.has(action),
      loading: mutation.isPending && mutation.variables?.action === action,
      disabled: mutation.isPending,
    };
    if (action === 'addTags' || action === 'removeTags') {
      return {
        ...base,
        optionsHeader: action === 'addTags' ? t('components.bulkActions.addTagsTitle', { count: list.length }) : t('components.bulkActions.removeTagsTitle', { count: list.length }),
        options: (tags.data ?? []).map((tag) => ({ id: String(tag.id), label: tag.label, onSelect: () => void run(action, [tag.id]).catch(() => undefined) })),
      };
    }
    return { ...base, onSelect: () => (CONFIRM[action] ? setConfirming(action) : void run(action).catch(() => undefined)) };
  });

  const dialogs: ReactNode = confirming ? (
    <BulkConfirmDialog
      open
      count={list.length}
      title={CONFIRM[confirming]?.(list.length) ?? LABELS[confirming]()}
      confirmLabel={confirming === 'delete' ? undefined : LABELS[confirming]()}
      onCancel={() => setConfirming(null)}
      onConfirm={async () => {
        await run(confirming);
        setConfirming(null);
      }}
    />
  ) : null;

  return { actions: barActions, dialogs };
}

/** What ResourceBulkBar needs of a selection (a Selection, or a table's controlled state). */
export interface BarSelection {
  selected: ReadonlySet<RowKey>;
  count: number;
  clear: () => void;
  set?: ((keys: Iterable<RowKey>) => void) | undefined;
  drop?: ((keys: Iterable<RowKey>) => void) | undefined;
}

export interface ResourceBulkBarProps extends ResourceBulkOptions {
  resource: BulkResource;
  selection: BarSelection;
  /** Rows on screen: the bar offers "Select all N" while fewer are selected. */
  allKeys?: readonly RowKey[] | undefined;
  /** More actions that work on the selection client-side (export, copy). */
  extra?: readonly BarAction[] | undefined;
  position?: 'fixed' | 'inline' | undefined;
}

/** The shared bulk bar wired to a POST /bulk resource. Renders nothing while nothing is selected. */
export function ResourceBulkBar({ resource, selection, allKeys, extra, position, nameOf, actions, onDone }: ResourceBulkBarProps) {
  const bulk = useResourceBulkActions(resource, selection.selected, {
    nameOf,
    actions,
    onDone: onDone ?? ((ok) => (selection.drop ? selection.drop(ok) : selection.clear())),
  });
  const set = selection.set;
  return (
    <BulkBar
      count={selection.count}
      total={allKeys?.length}
      onSelectAll={allKeys && set ? () => set(allKeys) : undefined}
      actions={[...(extra ?? []), ...bulk.actions]}
      onClear={selection.clear}
      position={position}
    >
      {bulk.dialogs}
    </BulkBar>
  );
}

/**
 * Everything a card grid needs for bulk actions over a POST /bulk resource: the selection,
 * the bar, and each card's checkbox props (ItemCard `select`).
 */
export function useResourceBulk<T>(
  resource: BulkResource,
  rows: readonly T[] | undefined,
  keyOf: (row: T) => RowKey,
  nameOf: (row: T) => string,
  options: {
    actions?: readonly BulkAction[] | undefined;
    /** More bar actions that work on the selected rows client-side (e.g. export). */
    extra?: ((selected: T[]) => readonly BarAction[]) | undefined;
  } = {},
) {
  const list = rows ?? [];
  const keys = list.map(keyOf);
  const selection = useSelection(keys);
  const names = new Map(list.map((r) => [keyOf(r), nameOf(r)] as const));
  const bar = (
    <ResourceBulkBar
      resource={resource}
      selection={selection}
      allKeys={keys}
      actions={options.actions}
      extra={options.extra?.(list.filter((r) => selection.has(keyOf(r))))}
      nameOf={(id) => names.get(id)}
    />
  );
  return { selection, bar, cardProps: (row: T) => selection.cardProps(keyOf(row), nameOf(row)) };
}

/**
 * A table's selection handed to a Selection: spread into <Table> (checkbox column and header
 * select-all) and render the bar separately.
 */
export function tableSelection(selection: Selection) {
  return { selectable: true, selected: selection.selected, onSelectionChange: selection.set } as const;
}
